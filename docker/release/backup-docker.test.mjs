import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { DockerBackup } from './backup-docker.mjs'
import { preflight, createBackup, restoreTest, verifyBackup } from './backup.mjs'
import { create } from './manifest.mjs'
import { initialState, begin, advance } from './state.mjs'
import { RestoreData } from './restore-data.mjs'

const enabled=process.env.BACKUP_DOCKER_TEST==='1'
const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:'unix:///var/run/docker.sock'}
function docker(...args) {
  const result=spawnSync('docker',args,{env,encoding:'utf8',timeout:300000,maxBuffer:1024*1024})
  assert.equal(result.status,0,`Isolated Docker command failed: ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}
async function ready(args) {
  for(let n=0;n<100;n++) {
    if(spawnSync('docker',args,{env,stdio:'ignore',timeout:3000}).status===0)return
    await delay(100)
  }
  assert.fail('Isolated fixture did not become ready')
}

test('real custom dump/globals and offline MinIO restore use only isolated resources', {skip:!enabled,timeout:240000},async()=>{
  const owner=randomUUID(), project='pizza-backup-test-'+owner
  const root=fs.mkdtempSync(join(tmpdir(),'pizza-backup-integration-'))
  const containers=[], volumes=[]
  let restored=false, copied=false, s3Checked=false
  function createContainer(service,image,args=[]) {
    const id=docker('create','--pull=never','--network=none','--label',`pizza.backup-fixture=${owner}`,
      '--label',`com.docker.compose.project=${project}`,'--label',`com.docker.compose.service=${service}`,...args,image)
    containers.push(id);return id
  }
  try {
    const pgImage=docker('image','inspect','postgres:15-alpine','--format','{{.Id}}')
    const minioImage=docker('image','inspect','minio/minio:latest','--format','{{.Id}}')
    const phpImage=docker('image','inspect',process.env.BACKUP_TEST_PHP_IMAGE || 'pizza-background-check:audit-eb7383641a1a-9e67bdf247c5','--format','{{.Id}}')
    const pg=createContainer('postgres',pgImage,['--read-only','--tmpfs','/var/lib/postgresql/data:rw','--tmpfs','/var/run/postgresql:rw','--tmpfs','/tmp:rw','--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_USER=postgres','--env','POSTGRES_DB=postgres'])
    docker('start',pg); await ready(['exec',pg,'sh','-ec','test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'])
    docker('exec',pg,'psql','-U','postgres','-c',"CREATE TABLE backup_fixture(id int primary key, value text); INSERT INTO backup_fixture VALUES(1, 'isolated-value');")
    const volume=docker('volume','create','--label',`pizza.backup-fixture=${owner}`,'pizza-backup-source-'+owner);volumes.push(volume)
    const minio=docker('create','--pull=never','--network=none','--label',`pizza.backup-fixture=${owner}`,'--label',`com.docker.compose.project=${project}`,'--label','com.docker.compose.service=minio',
      '--env','MINIO_ROOT_USER=fixtureuser','--env','MINIO_ROOT_PASSWORD=fixturepassword','--mount',`type=volume,src=${volume},dst=/data`,minioImage,'server','/data');containers.push(minio)
    docker('start',minio); await ready(['exec',minio,'curl','-fsS','http://127.0.0.1:9000/minio/health/live'])
    const curl=['exec',minio,'curl','-fsS','--aws-sigv4','aws:amz:us-east-1:s3','--user','fixtureuser:fixturepassword']
    docker(...curl,'-X','PUT','http://127.0.0.1:9000/backup-fixture')
    const versioning='<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'
    docker(...curl,'-X','PUT','-H','Content-Type: application/xml','-H',`Content-MD5: ${createHash('md5').update(versioning).digest('base64')}`,'--data-binary',versioning,'http://127.0.0.1:9000/backup-fixture?versioning')
    docker(...curl,'-X','PUT','--data-binary','isolated-object-payload','http://127.0.0.1:9000/backup-fixture/object')
    docker(...curl,'-X','PUT','--data-binary','isolated-new-version','http://127.0.0.1:9000/backup-fixture/object')
    docker(...curl,'-X','PUT','http://127.0.0.1:9000/backup-empty')
    docker(...curl,'-X','PUT','http://127.0.0.1:9000/backup-no-objects')
    docker(...curl,'-X','PUT','--data-binary','','http://127.0.0.1:9000/backup-empty/zero')
    const largePayload=Buffer.alloc(3*1024*1024,90)
    const upload=spawnSync('docker',['exec','-i',minio,'curl','-fsS','--aws-sigv4','aws:amz:us-east-1:s3','--user','fixtureuser:fixturepassword','-X','PUT','--data-binary','@-','http://127.0.0.1:9000/backup-fixture/zz-large'],{env,input:largePayload,timeout:30000,encoding:'utf8'})
    assert.equal(upload.status,0,'Controlled large-object upload failed')
    for(const service of ['nginx','php','report-worker','outbox-worker','report-scheduler']) createContainer(service,pgImage,['--entrypoint','true'])
    const manifest=create({CI_COMMIT_SHA:'a'.repeat(40),CI_PIPELINE_ID:'456',PHP_IMAGE:'registry.example.test/p/php@sha256:'+'b'.repeat(64),NGINX_IMAGE:'registry.example.test/p/nginx@sha256:'+'c'.repeat(64)})
    let state=advance(begin(initialState(project),manifest),manifest,'images_ready')
    const settings={schema_version:1,project,postgres_container:pg,minio_container:minio,utility_image:phpImage,reserve_bytes:67108864}
    const driver=new DockerBackup(settings)
    const receipt=preflight(state,root,driver)
    assert.ok(fs.existsSync(receipt))
    // Running MinIO must be rejected before any backup is created.
    const quiesced=advance(advance(state,manifest,'quiescing'),manifest,'quiesced')
    assert.throws(()=>createBackup(quiesced,root,'unsafe',driver),/WRITERS_NOT_SAFELY_STOPPED/)
    assert.equal(docker('exec',pg,'psql','-U','postgres','-Atc','SELECT count(*) FROM backup_fixture'),'1')
    docker('stop','-t','20',minio)
    const backup=createBackup(quiesced,root,'real',driver)
    verifyBackup(backup,driver)
    const originalRun=driver.run.bind(driver)
    driver.run=(args,options)=>{
      const result=originalRun(args,options)
      if(args[0]==='exec' && args.includes('pg_restore')) {
        assert.notEqual(args[2],pg)
        assert.equal(originalRun(['exec',args[2],'psql','-U','postgres','-d','backup_verify','-Atc','SELECT value FROM backup_fixture']),'isolated-value')
        restored=true
      }
      if(args.at(-1)==='restore-test')copied=true
      return result
    }
    const serviceCheck=driver.verifyRestoredMinio.bind(driver)
    driver.verifyRestoredMinio=(volume,metadata,owner)=>{
      assert.notEqual(volume,volumes[0])
      const result=serviceCheck(volume,metadata,owner)
      assert.deepEqual(result,{buckets:3,versions:4,bytes:largePayload.length+Buffer.byteLength('isolated-new-versionisolated-object-payload'),content_sha256:createHash('sha256').update('isolated-new-versionisolated-object-payload').update(largePayload).digest('hex')})
      s3Checked=true
      return result
    }
    restoreTest(backup,driver)
    assert.equal(restored,true);assert.equal(copied,true);assert.equal(s3Checked,true)
    // The production recovery adapter uses durable one-shot tasks and fresh
    // volumes, preserving globals/owners/ACL rather than --no-owner/--no-acl.
    const recoveryId=createHash('sha256').update(owner).digest('hex')
    const recoveryDirectory=join(root,'data-recovery');fs.mkdirSync(recoveryDirectory,{mode:0o700})
    const recoveredVolumes={postgres:'pizza-restored-'+owner+'-pg',minio:'pizza-restored-'+owner+'-minio'}
    const data=new RestoreData({backup:driver},recoveryDirectory,{id:recoveryId,volumes:recoveredVolumes,
      metadata:verifyBackup(backup,driver),backup_path:backup,utility_image:phpImage,
      database:{name:'postgres',user:'postgres',password:'public-recovery-fixture'}})
    data.check=()=>verifyBackup(backup,driver)
    driver.run=originalRun
    try {
      let checked=false
      driver.run=(args,options)=>{
        if(args[0]==='stop' && driver.inspect(args[1]).Config.Labels['pizza.data-recovery']===recoveryId) {
          const stage=args[1]
          assert.equal(docker('exec',stage,'psql','-U','postgres','-d','postgres','-Atc','SELECT value FROM backup_fixture'),'isolated-value')
          assert.equal(docker('exec',stage,'psql','-U','postgres','-d','postgres','-Atc',"SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname='backup_fixture'"),'postgres')
          checked=true
        }
        return originalRun(args,options)
      }
      data.restore()
      assert.equal(checked,true)
      // Do not restart/import either completed one-shot task on a retry.
      const databaseTask=data.read('completed-database'),filesTask=data.read('completed-files')
      data.restore()
      assert.deepEqual(data.read('completed-database'),databaseTask)
      assert.deepEqual(data.read('completed-files'),filesTask)
      assert.equal(docker('exec',pg,'psql','-U','postgres','-Atc','SELECT value FROM backup_fixture'),'isolated-value')
      driver.run=originalRun
    } finally {
      const ids=docker('ps','-aq','--filter','label=pizza.data-recovery='+recoveryId).split(/\s+/).filter(Boolean)
      for(const id of ids) {
        assert.equal(JSON.parse(docker('inspect',id))[0].Config.Labels['pizza.data-recovery'],recoveryId)
        docker('rm','-f',id)
      }
      const restoredVolumes=docker('volume','ls','-q','--filter','label=pizza.data-recovery='+recoveryId).split(/\s+/).filter(Boolean)
      for(const name of restoredVolumes) {
        assert.equal(JSON.parse(docker('volume','inspect',name))[0].Labels['pizza.data-recovery'],recoveryId)
        docker('volume','rm',name)
      }
    }
    driver.run=(args,options)=>{
      if(args[0]==='exec' && args.includes('pg_restore')) throw new Error('controlled isolated restore failure')
      return originalRun(args,options)
    }
    assert.throws(()=>restoreTest(backup,driver))
    assert.equal(docker('ps','-aq','--filter','label=pizza.backup-test'),'')
    driver.run=(args,options)=>{
      if(args.includes('/minio-service-check.php')) throw new Error('controlled S3 read failure')
      return originalRun(args,options)
    }
    assert.throws(()=>restoreTest(backup,driver))
    assert.equal(docker('ps','-aq','--filter','label=pizza.backup-test'),'')
    assert.equal(docker('volume','ls','-q','--filter','label=pizza.backup-test'),'')
    driver.run=originalRun
    // Exercise the combined coordinator with real dump/snapshot/restore, on the
    // same isolated fixtures. Only Compose/image acquisition is faked: no Registry.
    const stateDirectory=join(root,'release-state')
    fs.mkdirSync(stateDirectory,{mode:0o700})
    fs.writeFileSync(join(stateDirectory,'state.json'),JSON.stringify(initialState(project)),{mode:0o600})
    const coordinated=spawnSync('sh',['-ec','exec 9<"$TEST_STATE";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"'],{
      env:{...env,TEST_STATE:stateDirectory,TEST_CODE:`
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import {backupRelease} from ${JSON.stringify(new URL('./coordinator.mjs',import.meta.url).href)};
        import {DockerCoordinator} from ${JSON.stringify(new URL('./coordinator-docker.mjs',import.meta.url).href)};
        const driver=new DockerCoordinator(${JSON.stringify(settings)});
        driver.check=()=>({isolatedFixture:true});
        driver.images=()=>{};
        const args=[process.env.TEST_STATE,${JSON.stringify(manifest)},'unused','unused',${JSON.stringify(root)},driver];
        const first=backupRelease(...args);
        assert.equal(first.state.operation.phase,'backup_ready');
        const before=fs.readFileSync(process.env.TEST_STATE+'/state.json','utf8');
        const second=backupRelease(...args);
        assert.equal(second.backupPath,first.backupPath);
        assert.equal(fs.readFileSync(process.env.TEST_STATE+'/state.json','utf8'),before);
        console.log(JSON.stringify({phase:second.state.operation.phase,path:second.backupPath}));
      `},encoding:'utf8',timeout:150000,maxBuffer:1024*1024,
    })
    assert.equal(coordinated.status,0,'Isolated coordinated backup/restore failed')
    const coordinatedResult=JSON.parse(coordinated.stdout)
    assert.equal(coordinatedResult.phase,'backup_ready')
    assert.equal(verifyBackup(coordinatedResult.path,driver).project,project)
    assert.equal(docker('ps','-aq','--filter','label=pizza.backup-test'),'')
    assert.equal(docker('volume','ls','-q','--filter','label=pizza.backup-test'),'')
    assert.equal(docker('exec',pg,'psql','-U','postgres','-Atc','SELECT count(*) FROM backup_fixture'),'1')
    // Source object is still readable after the backup and isolated restore.
    docker('start',minio);await ready(['exec',minio,'curl','-fsS','http://127.0.0.1:9000/minio/health/live'])
    assert.equal(docker(...curl,'http://127.0.0.1:9000/backup-fixture/object'),'isolated-new-version')
    docker('stop','-t','20',minio)
  } finally {
    for(const id of containers.reverse()) {
      assert.equal(docker('inspect',id,'--format','{{index .Config.Labels "pizza.backup-fixture"}}'),owner)
      docker('rm','-f','-v',id)
    }
    for(const volume of volumes) {
      assert.equal(JSON.parse(docker('volume','inspect',volume))[0].Labels['pizza.backup-fixture'],owner)
      docker('volume','rm',volume)
    }
    fs.rmSync(root,{recursive:true})
  }
})
