import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class FfmpegError extends Error {
  override name = 'FfmpegError';

  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(stderr ? `${message}: ${stderr.trim().split('\n').at(-1)}` : message);
  }
}

export type FfmpegRun = {
  args: string[];
  input?: AsyncIterable<Buffer> | Iterable<Buffer> | undefined;
  output?: Writable | Writable[] | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

// Only the tail of stderr is kept. A failing run can log per frame, and
// the last lines are the ones that name the cause.
const STDERR_LIMIT = 16 * 1024;
// ffmpeg closing stdin early is normal once it has the frames it needs;
// the exit code decides whether the run failed.
const BROKEN_PIPE_CODES = new Set([
  'EPIPE',
  'EOF',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

export class FfmpegSupervisor {
  private readonly running = new Set<ChildProcess>();

  constructor(private readonly ffmpegPath: string) {}

  killAll(): void {
    for (const child of this.running) {
      child.kill('SIGKILL');
    }
  }

  async run(run: FfmpegRun): Promise<void> {
    run.signal?.throwIfAborted();

    const child = spawn(
      this.ffmpegPath,
      ['-hide_banner', '-nostats', '-loglevel', 'error', ...run.args],
      {
        stdio: [
          run.input ? 'pipe' : 'ignore',
          run.output ? 'pipe' : 'ignore',
          'pipe',
        ],
        windowsHide: true,
      },
    );
    this.running.add(child);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      stderr = (stderr + text).slice(-STDERR_LIMIT);
    });

    let failure: unknown;
    let outputError: unknown;
    // The first reason recorded wins: the kill it triggers makes the child
    // exit non-zero, and that exit must not replace the real cause.
    const kill = (reason: unknown) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };

    const closed = new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        failure ??= err;
        this.running.delete(child);
        resolve(null);
      });
      child.once('close', (code) => {
        this.running.delete(child);
        resolve(code);
      });
    });

    const onAbort = () => {
      kill(run.signal!.reason);
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = run.timeoutMs
      ? setTimeout(() => {
          kill(
            new FfmpegError(
              `ffmpeg timed out after ${run.timeoutMs} ms`,
              stderr,
            ),
          );
        }, run.timeoutMs)
      : undefined;

    if (run.input) {
      pipeline(run.input, child.stdin!).catch((err: NodeJS.ErrnoException) => {
        if (!BROKEN_PIPE_CODES.has(err.code ?? '')) {
          kill(err);
        }
      });
    }
    const outputs = run.output ? [run.output].flat() : [];
    const writing =
      outputs.length > 0
        ? pipeline(
            child.stdout!,
            ...(outputs as [Writable, ...Writable[]]),
          ).catch((err: unknown) => {
            outputError = err;
            child.kill('SIGKILL');
          })
        : Promise.resolve();

    try {
      const [code] = await Promise.all([closed, writing]);
      if (failure) {
        throw failure;
      }
      if (outputError) {
        throw outputError;
      }
      if (code !== 0 && code !== null) {
        throw new FfmpegError(`ffmpeg exited with code ${code}`, stderr);
      }
    } finally {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
    }
  }
}
