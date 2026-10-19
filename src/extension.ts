import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DfmtError, formatSource, isAbortError } from './dfmt';

/**
 * The `d` language identifier is contributed by whichever D extension the user
 * already has installed; this extension deliberately does not register it.
 */
const D_LANGUAGE_ID = 'd';
const CONFIG_SECTION = 'dfmt';
const DEFAULT_EXECUTABLE = 'dfmt';
const OUTPUT_CHANNEL_NAME = 'dfmt';

/** Suppresses repeated identical error notifications while a problem persists. */
const ERROR_NOTIFICATION_INTERVAL_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const provider = new DfmtFormattingProvider(output);

  context.subscriptions.push(
    output,
    vscode.languages.registerDocumentFormattingEditProvider(
      [
        { language: D_LANGUAGE_ID, scheme: 'file' },
        { language: D_LANGUAGE_ID, scheme: 'untitled' },
      ],
      provider,
    ),
  );

  output.appendLine('dfmt is ready. Format a D document with "Format Document" (Shift+Alt+F).');
}

export function deactivate(): void {
  // Everything is owned by the extension context, so there is nothing to release.
}

/**
 * Feeds a D document through `dfmt` and returns the resulting edit.
 *
 * A formatting provider must never throw and must return the original document
 * unchanged when formatting is not possible, so every failure path returns an
 * empty edit list after reporting the problem.
 */
class DfmtFormattingProvider implements vscode.DocumentFormattingEditProvider {
  /**
   * One promise chain per document. VS Code does not guarantee that formatting
   * requests for the same document are serialised, and two overlapping dfmt
   * processes could otherwise apply results computed from stale text.
   */
  private readonly queues = new Map<string, Promise<unknown>>();
  private lastNotification: { message: string; at: number } | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.sequence(document.uri.toString(), () => this.format(document, token));
  }

  /** Runs `task` after every previously queued task for `key` has settled. */
  private sequence<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async format(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri);
    const executable = normaliseExecutable(configuration.get<string>('path'));
    const args = configuration.get<string[]>('arguments') ?? [];
    const useEditorConfig = configuration.get<boolean>('useEditorConfig') ?? true;

    // Snapshot everything that describes the document as dfmt is about to see
    // it, so the result can be validated before it is applied.
    const source = document.getText();
    const version = document.version;
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
    const cwd = useEditorConfig ? documentDirectory(document) : undefined;

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());

    const target = document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
    const startedAt = Date.now();
    this.output.appendLine(
      `[${new Date(startedAt).toISOString()}] formatting ${target} (version ${version}) with "${executable}"` +
        (cwd === undefined ? '' : ` from ${cwd}`),
    );

    try {
      const result = await formatSource(source, { executable, args, cwd, signal: controller.signal });
      this.output.appendLine(
        `[dfmt] finished in ${Date.now() - startedAt} ms, ${result.text.length} characters returned.`,
      );

      if (result.diagnostics.length > 0) {
        // dfmt formats files with syntax errors on a best-effort basis and
        // reports the problems on stderr while still exiting with code 0.
        this.output.appendLine(`[dfmt] reported:\n${result.diagnostics}`);
      }

      if (token.isCancellationRequested) {
        this.output.appendLine('[dfmt] request was cancelled; the document was left unchanged.');
        return [];
      }

      if (document.version !== version) {
        this.output.appendLine('[dfmt] the document changed while formatting; the result was discarded.');
        return [];
      }

      if (result.text === source) {
        return [];
      }

      return [vscode.TextEdit.replace(fullRange, result.text)];
    } catch (error) {
      if (isAbortError(error)) {
        this.output.appendLine('[dfmt] request was cancelled.');
        return [];
      }
      this.report(error);
      return [];
    } finally {
      cancellation.dispose();
    }
  }

  /** Logs a failure and surfaces it once as an error notification. */
  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[dfmt] error: ${message}`);

    if (error instanceof DfmtError && error.stderr.length > 0) {
      this.output.appendLine(`[dfmt] stderr:\n${error.stderr}`);
    }

    const now = Date.now();
    if (this.lastNotification?.message === message && now - this.lastNotification.at < ERROR_NOTIFICATION_INTERVAL_MS) {
      return;
    }
    this.lastNotification = { message, at: now };

    void vscode.window.showErrorMessage(`dfmt: ${message}`, 'Show Log', 'Open Settings').then((choice) => {
      switch (choice) {
        case 'Show Log':
          this.output.show(true);
          break;
        case 'Open Settings':
          void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.path`);
          break;
        default:
          break;
      }
    });
  }
}

/**
 * Resolves the configured executable to a usable path.
 *
 * Windows users frequently paste quoted paths; no shell is involved when the
 * process is started, so the quotes would be taken literally and are removed.
 */
function normaliseExecutable(configured: string | undefined): string {
  const trimmed = (configured ?? '').trim();

  if (trimmed.length === 0) return DEFAULT_EXECUTABLE;

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length === 0 ? DEFAULT_EXECUTABLE : unquoted;
  }

  return trimmed;
}

/**
 * The directory dfmt is started from, which is how dfmt discovers the
 * `.editorconfig` files that apply to the document.
 */
function documentDirectory(document: vscode.TextDocument): string | undefined {
  if (document.uri.scheme === 'file') {
    const directory = path.dirname(document.uri.fsPath);
    if (fs.existsSync(directory)) return directory;
  }

  const folder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  return folder !== undefined && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}
