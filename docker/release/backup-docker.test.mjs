import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { DockerBackup } from './backup-docker.mjs'
import { preflight, createBackup, restoreTest, verifyBackup } from './backup.mjs'
import { create } from './manifest.mjs'
import { initialState, begin, advance } from './state.mjs'

const enabled=process.env.BACKUP_DOCKER_TEST==='1'
const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:'unix:///var/run/docker.sock'}
function docker(...args) {
  const result=spawnSync('docker',args,{env,encoding:'utf8',timeout:300000,maxBuffer:1024*1024})
  assert.equal(result.status,0,`Isolated Docker command failed: ${args[0]}`)
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
  let restored=false, copied=false
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
    docker(...curl,'-X','PUT','--data-binary','isolated-object-payload','http://127.0.0.1:9000/backup-fixture/object')
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
    restoreTest(backup,driver)
    assert.equal(restored,true);assert.equal(copied,true)
    driver.run=(args,options)=>{
      if(args[0]==='exec' && args.includes('pg_restore')) throw new Error('controlled isolated restore failure')
      return originalRun(args,options)
    }
    assert.throws(()=>restoreTest(backup,driver))
    assert.equal(docker('ps','-aq','--filter','label=pizza.backup-test'),'')
    driver.run=originalRun
    assert.equal(docker('exec',pg,'psql','-U','postgres','-Atc','SELECT count(*) FROM backup_fixture'),'1')
    // Source object is still readable after the backup and isolated restore.
    docker('start',minio);await ready(['exec',minio,'curl','-fsS','http://127.0.0.1:9000/minio/health/live'])
    assert.equal(docker(...curl,'http://127.0.0.1:9000/backup-fixture/object'),'isolated-object-payload')
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
