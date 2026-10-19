/**
 * Integration tests for the VS Code layer in `src/extension.ts`.
 *
 * The `vscode` module is replaced with a small in-memory stub so the real
 * formatting provider can be exercised headlessly: activation is run, the
 * registered provider is captured, and it is asked to format documents. The
 * provider talks to the real `dfmt` binary, so these tests cover the whole path
 * from a D document to the returned `TextEdit`.
 *
 * Run with: bun test
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dfmtExecutable = process.env.DFMT_PATH ?? 'dfmt';

const dfmtAvailable = ((): boolean => {
  try {
    return spawnSync(dfmtExecutable, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

interface Provider {
  provideDocumentFormattingEdits(
    document: unknown,
    options: unknown,
    token: unknown,
  ): Promise<{ newText: string }[]>;
}

/** Everything the extension does through the `vscode` API, for assertions. */
const recorded = {
  selectors: [] as unknown[],
  messages: [] as string[],
  log: [] as string[],
  provider: undefined as Provider | undefined,
};

/** Settings returned by the stubbed `getConfiguration`. */
let settings: Record<string, unknown> = {};

mock.module('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => recorded.log.push(line),
      show: () => undefined,
      dispose: () => undefined,
    }),
    showErrorMessage: async (message: string) => {
      recorded.messages.push(message);
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
    }),
    getWorkspaceFolder: () => undefined,
    workspaceFolders: undefined,
  },
  languages: {
    registerDocumentFormattingEditProvider: (selector: unknown, provider: Provider) => {
      recorded.selectors.push(selector);
      recorded.provider = provider;
      return { dispose: () => undefined };
    },
  },
  commands: { executeCommand: async () => undefined },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  TextEdit: {
    replace: (range: unknown, newText: string) => ({ range, newText }),
  },
}));

const { activate } = await import('../src/extension');

activate({ subscriptions: { push: () => undefined } } as never);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dfmt-extension-test-'));
const documentPath = path.join(workspace, 'app.d');
const source = 'import std.stdio;\n\nvoid main(){writeln("hi");}\n';
fs.writeFileSync(documentPath, source, 'utf8');
fs.writeFileSync(path.join(workspace, '.editorconfig'), 'root = true\n', 'utf8');

afterAll(() => {
  mock.restore();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const uri = { scheme: 'file', fsPath: documentPath, toString: () => `file://${documentPath}` };

/** Minimal stand-in for `vscode.TextDocument`. */
function makeDocument(text: string, version: number) {
  return { uri, version, getText: () => text, positionAt: (offset: number) => offset };
}

/**
 * A document whose reported version is newer than the one captured when
 * formatting started, simulating a user edit that lands while dfmt is running.
 */
function makeDocumentEditedDuringFormatting(text: string) {
  let reads = 0;
  return {
    uri,
    get version() {
      reads += 1;
      return reads === 1 ? 1 : 2;
    },
    getText: () => text,
    positionAt: (offset: number) => offset,
  };
}

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const provider = recorded.provider;

describe('extension activation', () => {
  test('registers a document formatting provider for D documents only', () => {
    expect(provider).toBeDefined();
    expect(recorded.selectors).toEqual([
      [
        { language: 'd', scheme: 'file' },
        { language: 'd', scheme: 'untitled' },
      ],
    ]);
  });

  test('does not contribute the d language itself', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as { contributes: Record<string, unknown> };

    expect(manifest.contributes.languages).toBeUndefined();
    expect(Object.keys(manifest.contributes)).toEqual(['configuration']);
  });
});

describe('formatting a document', () => {
  test.if(dfmtAvailable)('returns one edit replacing the whole document', async () => {
    settings = { path: dfmtExecutable, arguments: [], useEditorConfig: true };
    recorded.messages.length = 0;

    const edits = await provider!.provideDocumentFormattingEdits(
      makeDocument(source, 1),
      {},
      token,
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]!.newText).toBe('import std.stdio;\n\nvoid main()\n{\n    writeln("hi");\n}\n');
    expect(recorded.messages).toEqual([]);
  });

  test.if(dfmtAvailable)('accepts a quoted dfmt.path and reports no edit when already formatted', async () => {
    settings = { path: `"${dfmtExecutable}"`, arguments: [], useEditorConfig: false };
    recorded.messages.length = 0;

    const edits = await provider!.provideDocumentFormattingEdits(
      makeDocument('void main()\n{\n}\n', 1),
      {},
      token,
    );

    expect(edits).toEqual([]);
    expect(recorded.messages).toEqual([]);
  });

  test.if(dfmtAvailable)('honours dfmt.arguments from the settings', async () => {
    settings = { path: dfmtExecutable, arguments: ['--indent_size=2'], useEditorConfig: false };

    const edits = await provider!.provideDocumentFormattingEdits(
      makeDocument('void main(){int x=1;}\n', 1),
      {},
      token,
    );

    expect(edits[0]!.newText).toBe('void main()\n{\n  int x = 1;\n}\n');
  });

  test.if(dfmtAvailable)('discards a result computed while the document was changing', async () => {
    settings = { path: dfmtExecutable, arguments: [], useEditorConfig: false };
    recorded.log.length = 0;

    const edits = await provider!.provideDocumentFormattingEdits(
      makeDocumentEditedDuringFormatting(source),
      {},
      token,
    );

    expect(edits).toEqual([]);
    expect(recorded.log.some((line) => line.includes('changed while formatting'))).toBe(true);
  });

  test('keeps the document unchanged and reports an error when dfmt is missing', async () => {
    settings = { path: 'dfmt-executable-that-does-not-exist', arguments: [], useEditorConfig: false };
    recorded.messages.length = 0;

    const edits = await provider!.provideDocumentFormattingEdits(
      makeDocument(source, 1),
      {},
      token,
    );

    expect(edits).toEqual([]);
    expect(recorded.messages).toHaveLength(1);
    expect(recorded.messages[0]).toContain('could not execute');
    expect(recorded.messages[0]).toContain('dfmt.path');
  });

  test.if(dfmtAvailable)('serialises overlapping requests for the same document', async () => {
    settings = { path: dfmtExecutable, arguments: [], useEditorConfig: false };

    const results = await Promise.all([
      provider!.provideDocumentFormattingEdits(makeDocument(source, 1), {}, token),
      provider!.provideDocumentFormattingEdits(makeDocument(source, 1), {}, token),
    ]);

    for (const edits of results) {
      expect(edits).toHaveLength(1);
      expect(edits[0]!.newText).toBe('import std.stdio;\n\nvoid main()\n{\n    writeln("hi");\n}\n');
    }
  });
});
