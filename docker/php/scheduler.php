<?php

declare(strict_types=1);

/**
 * A single foreground schedule:run at each minute boundary. Stop signals are
 * deliberately not forwarded: Laravel's current command must finish first.
 * The isolated session contains schedule:run and its foreground descendants.
 *
 * @param list<string> $command
 */
function runScheduler(array $command, int $graceSeconds = 60, bool $immediate = false): int
{
    if (!extension_loaded('pcntl') || !function_exists('posix_setsid')) {
        fwrite(STDERR, "Scheduler requires pcntl and posix.\n");

        return 1;
    }
    $stopping = false;
    $deadline = PHP_FLOAT_MAX;
    $child = null;
    $leaderDone = false;
    $statusCode = 0;
    pcntl_async_signals(true);
    foreach ([SIGTERM, SIGQUIT, SIGINT] as $signal) {
        pcntl_signal($signal, static function () use (&$stopping, &$deadline, $graceSeconds): void {
            if (!$stopping) {
                $stopping = true;
                $deadline = hrtime(true) / 1e9 + $graceSeconds;
            }
        });
    }
    $next = $immediate ? 0 : (intdiv(time(), 60) + 1) * 60;
    while (true) {
        if ($child === null && $stopping) {
            return $statusCode;
        }
        if ($child === null && time() >= $next) {
            // Block shutdown across fork; the pending signal is handled by the
            // parent immediately afterwards. The child resets its signal mask.
            pcntl_sigprocmask(SIG_BLOCK, [SIGTERM, SIGQUIT, SIGINT], $oldMask);
            $pid = pcntl_fork();
            if ($pid === 0) {
                foreach ([SIGTERM, SIGQUIT, SIGINT] as $signal) {
                    pcntl_signal($signal, SIG_DFL);
                }
                if (posix_setsid() === -1) {
                    exit(1);
                }
                pcntl_sigprocmask(SIG_SETMASK, $oldMask);
                pcntl_exec($command[0], array_slice($command, 1));
                exit(1);
            }
            $child = $pid > 0 ? $pid : null;
            $leaderDone = false;
            pcntl_sigprocmask(SIG_SETMASK, $oldMask);
            if ($pid === -1) {
                fwrite(STDERR, "Cannot start scheduler command.\n");

                return 1;
            }
            $next = (intdiv(time(), 60) + 1) * 60;
        }
        if ($child !== null) {
            while (($reaped = pcntl_waitpid(-1, $status, WNOHANG)) > 0) {
                if ($reaped === $child) {
                    $leaderDone = true;
                    $statusCode = pcntl_wifexited($status) ? pcntl_wexitstatus($status) : 128 + pcntl_wtermsig($status);
                }
            }
            // Also wait for foreground grandchildren if the command exits early.
            if ($leaderDone && !posix_kill(-$child, 0)) {
                $child = null;
                if ($statusCode !== 0) {
                    fwrite(STDERR, "Scheduler command failed.\n");

                    return $statusCode;
                }
            } elseif ($stopping && hrtime(true) / 1e9 >= $deadline) {
                fwrite(STDERR, "Scheduler shutdown deadline exceeded.\n");
                posix_kill(-$child, SIGKILL);
                // PID 1 adopts and reaps descendants killed with the session.
                while (pcntl_waitpid(-1, $status) > 0) {
                }

                return 124;
            }
        }
        usleep(50_000);
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    exit(runScheduler([PHP_BINARY, '/var/www/app/artisan', 'schedule:run']));
}
