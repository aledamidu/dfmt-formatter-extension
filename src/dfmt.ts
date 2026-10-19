/**
 * Thin wrapper around the `dfmt` command-line formatter for D.
 *
 * Documented behaviour that this module relies on
 * (https://github.com/dlang-community/dfmt):
 *
 *  - When no file name is given, dfmt reads the D source from **stdin** and
 *    writes the formatted source to **stdout**. Formatting is therefore done
 *    in memory and no temporary file is ever created.
 *  - Options are passed as `--option_name=value` on the command line and take
 *    precedence over `.editorconfig`.
 *  - When dfmt formats stdin it looks for the `.editorconfig` files that would
 *    apply to a D file in the *current working directory*.
 *
 * This module intentionally has no dependency on the `vscode` API so that it
 * can be exercised by plain unit tests.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Options for a single `dfmt` invocation. */
export interface DfmtOptions {
  /** Executable to run. A bare name is resolved through `PATH`. */
  executable: string;
  /** Extra command-line arguments, passed through verbatim. */
  args?: readonly string[];
  /** Working directory, used by dfmt to locate `.editorconfig` files. */
  cwd?: string;
  /** Kills the child process when aborted. */
  signal?: AbortSignal;
}

/** The formatted text and any diagnostics dfmt reported. */
export interface DfmtResult {
  /** Formatted source exactly as dfmt wrote it to stdout. */
  text: string;
  /** Text dfmt wrote to stderr, trimmed. Empty when dfmt reported nothing. */
  diagnostics: string;
}

/** Thrown when dfmt could not be executed or refused to format the input. */
export class DfmtError extends Error {
  /** The executable that was invoked. */
  readonly executable: string;
  /** Process exit code, or `undefined` when the process never produced one. */
  readonly exitCode: number | undefined;
  /** Captured stderr, trimmed. Empty when there was none. */
  readonly stderr: string;

  constructor(
    message: string,
    details: { executable: string; exitCode?: number; stderr?: string; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DfmtError';
    this.executable = details.executable;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr ?? '';
  }
}

/** True when `error` was caused by aborting the invocation. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Formats D `source` by piping it through `dfmt` on stdin.
 *
 * Resolves with the formatted text. Rejects with a {@link DfmtError} when dfmt
 * cannot be started, exits with a non-zero code, or returns nothing for a
 * document that had content. Rejects with the original `AbortError` when
 * `options.signal` is aborted. The caller is expected to leave the document
 * untouched whenever this promise rejects.
 */
export function formatSource(source: string, options: DfmtOptions): Promise<DfmtResult> {
  const { executable, args = [], cwd, signal } = options;

  return new Promise<DfmtResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      // No shell and no string concatenation: the executable and every argument
      // are passed as separate array entries, so paths with spaces are safe and
      // user input can never be interpreted by a shell.
      child = spawn(executable, [...args], { cwd, signal, windowsHide: true });
    } catch (error) {
      reject(toDfmtError(error, executable));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const succeed = (result: DfmtResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      fail(isAbortError(error) ? error : toDfmtError(error, executable));
    });

    child.on('close', (code: number | null) => {
      const text = Buffer.concat(stdoutChunks).toString('utf8');
      const diagnostics = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code !== 0) {
        fail(
          new DfmtError(describeExit(code, executable, diagnostics), {
            executable,
            ...(code === null ? {} : { exitCode: code }),
            stderr: diagnostics,
          }),
        );
        return;
      }

      // dfmt legitimately returns an empty result for input that is only
      // whitespace, but an empty result for real content means something went
      // wrong and the document must not be emptied.
      if (text.length === 0 && source.trim().length > 0) {
        fail(
          new DfmtError(
            `"${executable}" returned no output for a document that was not empty. The document was left unchanged.`,
            { executable, stderr: diagnostics },
          ),
        );
        return;
      }

      // dfmt performs best-effort formatting of files that do not parse: it
      // still writes output to stdout and reports the problem on stderr while
      // exiting with code 0. The result is usable, so it is returned together
      // with the diagnostics and the caller decides what to do with them.
      succeed({ text, diagnostics });
    });

    // dfmt may exit before it reads all of stdin (for example when an option is
    // invalid), which surfaces as EPIPE. The exit code and stderr already
    // describe that failure, so the write error is intentionally ignored.
    child.stdin.on('error', () => undefined);
    child.stdin.end(Buffer.from(source, 'utf8'));
  });
}

/** Turns a low-level spawn failure into an actionable {@link DfmtError}. */
function toDfmtError(error: unknown, executable: string): DfmtError {
  if (error instanceof DfmtError) return error;

  const code = (error as NodeJS.ErrnoException | null)?.code;

  switch (code) {
    case 'ENOENT':
      return new DfmtError(
        `could not execute the dfmt formatter "${executable}". ` +
          'Install dfmt, make sure it is on your PATH, or set "dfmt.path" to the full path of the executable.',
        { executable, cause: error },
      );
    case 'EACCES':
      return new DfmtError(`no permission to execute the dfmt formatter "${executable}".`, {
        executable,
        cause: error,
      });
    default:
      return new DfmtError(error instanceof Error ? error.message : String(error), {
        executable,
        cause: error,
      });
  }
}

/** Builds a message for a non-zero exit, quoting the first stderr line. */
function describeExit(code: number | null, executable: string, diagnostics: string): string {
  const reason = diagnostics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const base = `"${executable}" exited with code ${code === null ? 'unknown' : code}`;
  return reason === undefined ? `${base}.` : `${base}: ${reason}`;
}
