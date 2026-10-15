<?php

declare(strict_types=1);

// Isolated helper: no Laravel bootstrap, env files, network or production writes.
/** @param resource|false $stream */
function streamHash($stream): string
{
    if ($stream === false) {
        throw new RuntimeException();
    }
    try {
        $hash = hash_init('sha256');
        hash_update_stream($hash, $stream);

        return hash_final($hash);
    } finally {
        fclose($stream);
    }
}

try {
    $archive = '/backup/minio.zip';
    $zip = new ZipArchive();
    if ($argv[1] === 'create') {
        if ($zip->open($archive, ZipArchive::CREATE | ZipArchive::EXCL) !== true) {
            throw new RuntimeException();
        }
        $hashes = [];
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('/source', FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
        foreach ($iterator as $file) {
            if ($file->isLink() || (!$file->isFile() && !$file->isDir())) {
                throw new RuntimeException();
            }
            $relative = substr($file->getPathname(), strlen('/source/'));
            $added = $file->isDir() ? $zip->addEmptyDir($relative) : $zip->addFile($file->getPathname(), $relative);
            if (!$added) {
                throw new RuntimeException();
            }
            if ($file->isFile()) {
                $hashes[$relative] = hash_file('sha256', $file->getPathname());
            }
        }
        // An explicit format sentinel also represents an empty source volume.
        $zip->addEmptyDir('.backup-empty');
        if (!$zip->close() || $zip->open($archive, ZipArchive::CHECKCONS) !== true) {
            throw new RuntimeException();
        }
        foreach ($hashes as $relative => $hash) {
            if (streamHash($zip->getStream($relative)) !== $hash) {
                throw new RuntimeException();
            }
        }
        $zip->close();
        if (!chmod($archive, 0o600) || !chown($archive, (int) $argv[2]) || !chgrp($archive, (int) $argv[3])) {
            throw new RuntimeException();
        }
    } elseif ($argv[1] === 'restore-test') {
        if (count(scandir('/restore')) !== 2 || $zip->open($archive, ZipArchive::CHECKCONS) !== true) {
            throw new RuntimeException();
        }
        for ($index = 0; $index < $zip->numFiles; $index++) {
            $relative = $zip->getNameIndex($index);
            if ($relative === false || $relative === '' || str_starts_with($relative, '/') || str_contains($relative, "\0") || in_array('..', explode('/', $relative), true)) {
                throw new RuntimeException();
            }
            if (!$zip->getExternalAttributesIndex($index, $system, $attributes)) {
                throw new RuntimeException();
            }
            $type = ($attributes >> 16) & 0o170_000;
            if (!in_array($type, [0, 0o040_000, 0o100_000], true)) {
                throw new RuntimeException();
            }
            if ($relative === '.backup-empty/') {
                continue;
            }
            $target = '/restore/' . $relative;
            if (str_ends_with($relative, '/')) {
                if (!is_dir($target) && !mkdir($target, 0o700, true)) {
                    throw new RuntimeException();
                }
            } else {
                if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0o700, true)) {
                    throw new RuntimeException();
                }
                $input = $zip->getStream($relative);
                $output = fopen($target, 'xb');
                if ($input === false || $output === false || stream_copy_to_stream($input, $output) === false) {
                    throw new RuntimeException();
                }
                fclose($input);
                fclose($output);
                if (hash_file('sha256', $target) !== streamHash($zip->getStream($relative))) {
                    throw new RuntimeException();
                }
            }
        }
        $zip->close();
    } else {
        throw new RuntimeException();
    }
} catch (Throwable) {
    fwrite(STDERR, "MinIO snapshot operation failed.\n");
    exit(1);
}
