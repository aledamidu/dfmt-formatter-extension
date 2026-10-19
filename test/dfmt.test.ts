/**
 * Unit tests for the dfmt integration.
 *
 * These tests drive the real `dfmt` binary through `src/dfmt.ts`, which is the
 * module that knows how to start the process, feed it source on stdin and turn
 * its exit code and stderr into a result or an error. The `vscode` API layer in
 * `src/extension.ts` is a thin adapter on top of it and is covered by running
 * the extension in the Extension Development Host.
 *
 * The tests are skipped, without failing, when dfmt is not installed. Set
 * DFMT_PATH to point at a specific binary.
 *
 * Run with: bun test
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DfmtError, formatSource, isAbortError } from '../src/dfmt';

const DFMT_PATH_ENV = 'DFMT_PATH';

/** The executable under test: an explicit override, or `dfmt` from the PATH. */
const dfmtExecutable = process.env[DFMT_PATH_ENV] ?? 'dfmt';

const dfmtAvailable = ((): boolean => {
  try {
    return spawnSync(dfmtExecutable, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/**
 * Creates a throwaway directory whose `.editorconfig` stops EditorConfig
 * lookup, so the tests never inherit settings from a parent folder.
 */
function makeProject(files: Record<string, string> = {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dfmt-test-'));

  const allFiles: Record<string, string> = { '.editorconfig': 'root = true\n', ...files };
  for (const [name, contents] of Object.entries(allFiles)) {
    fs.writeFileSync(path.join(directory, name), contents, 'utf8');
  }

  return directory;
}

const temporaryDirectories: string[] = [];

function project(files: Record<string, string> = {}): string {
  const directory = makeProject(files);
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const simpleInput = 'void main(){int x=1;writeln(x);}';
const simpleOutput = 'void main()\n{\n    int x = 1;\n    writeln(x);\n}\n';

describe('formatSource', () => {
  test.if(dfmtAvailable)('formats source piped through stdin', async () => {
    const result = await formatSource(simpleInput, {
      executable: dfmtExecutable,
      cwd: project(),
    });

    expect(result.text).toBe(simpleOutput);
    expect(result.diagnostics).toBe('');
  });

  test.if(dfmtAvailable)('keeps the line endings used by the document', async () => {
    const result = await formatSource('void main(){\r\nint x=1;\r\n}', {
      executable: dfmtExecutable,
      cwd: project(),
    });

    expect(result.text).toBe('void main()\r\n{\r\n    int x = 1;\r\n}\r\n');
  });

  test.if(dfmtAvailable)('honours extra command-line arguments', async () => {
    const result = await formatSource(simpleInput, {
      executable: dfmtExecutable,
      args: ['--indent_size=2'],
      cwd: project(),
    });

    expect(result.text).toBe('void main()\n{\n  int x = 1;\n  writeln(x);\n}\n');
  });

  test.if(dfmtAvailable)('applies the .editorconfig of the working directory', async () => {
    const cwd = project({ '.editorconfig': 'root = true\n\n[*.d]\nindent_size = 2\n' });

    const result = await formatSource(simpleInput, { executable: dfmtExecutable, cwd });

    expect(result.text).toBe('void main()\n{\n  int x = 1;\n  writeln(x);\n}\n');
  });

  test.if(dfmtAvailable)('reports parse errors as diagnostics while still formatting', async () => {
    const result = await formatSource('void main() { int x = ; }', {
      executable: dfmtExecutable,
      cwd: project(),
    });

    expect(result.diagnostics).toContain('Primary expression expected');
    expect(result.text).toContain('int x = ;');
  });

  test.if(dfmtAvailable)('returns an empty result for whitespace-only input', async () => {
    const result = await formatSource('   \n\n', { executable: dfmtExecutable, cwd: project() });

    expect(result.text).toBe('');
    expect(result.diagnostics).toBe('');
  });

  test.if(dfmtAvailable)('runs an executable from a path containing spaces', async () => {
    const directory = project();
    const spaced = path.join(directory, 'a folder with spaces', 'dfmt copy.exe');
    fs.mkdirSync(path.dirname(spaced));
    fs.copyFileSync(requireDfmtLocation(), spaced);

    const result = await formatSource(simpleInput, { executable: spaced, cwd: directory });

    expect(result.text).toBe(simpleOutput);
  });

  test.if(dfmtAvailable)('throws a DfmtError when dfmt exits with a non-zero code', async () => {
    const failure = formatSource(simpleInput, {
      executable: dfmtExecutable,
      args: ['--brace_style=not-a-real-brace-style'],
      cwd: project(),
    });

    const error = await failure.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DfmtError);
    expect((error as DfmtError).exitCode).toBe(1);
    expect((error as DfmtError).stderr).toContain('brace_style');
  });

  test('throws a DfmtError when the executable does not exist', async () => {
    const failure = formatSource(simpleInput, {
      executable: 'dfmt-executable-that-does-not-exist',
      cwd: project(),
    });

    const error = await failure.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DfmtError);
    expect((error as DfmtError).message).toContain('could not execute');
    expect((error as DfmtError).message).toContain('dfmt-executable-that-does-not-exist');
  });

  test.if(dfmtAvailable)('rejects with an abort error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await formatSource(simpleInput, {
      executable: dfmtExecutable,
      cwd: project(),
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(isAbortError(error)).toBe(true);
  });
});

/** Locates the dfmt binary so it can be copied into a directory with spaces. */
function requireDfmtLocation(): string {
  const located = spawnSync(process.platform === 'win32' ? 'where' : 'which', [dfmtExecutable], {
    encoding: 'utf8',
  });

  const first = located.stdout?.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (located.status !== 0 || first === undefined) {
    throw new Error(`Could not locate "${dfmtExecutable}" to copy it.`);
  }

  return first.trim();
}
