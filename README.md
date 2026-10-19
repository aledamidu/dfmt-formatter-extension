# dfmt - D formatter for VS Code

A minimal, standalone Visual Studio Code extension that formats D source files
with the [`dfmt`](https://github.com/dlang-community/dfmt) command-line
formatter.

It plugs into the standard VS Code formatting API, so it works with **Format
Document** (`Shift+Alt+F`) and with **Format on Save**. It has no runtime
dependencies, does not register the D language itself, and does not touch your
LSP configuration, autocompletion, or diagnostics.

## Requirements

| Requirement | Notes |
| --- | --- |
| VS Code 1.95 or newer | The extension is built against the 1.95 API and only uses stable APIs. |
| `dfmt` installed | Either on your `PATH`, or configured through `dfmt.path`. |
| An extension that provides the `d` language id | For example code-d or the D language extension. The language mode shown in the status bar must be **D**. |

This extension deliberately does **not** register the `d` language. If no
installed extension contributes `d`, VS Code has no `d` language to attach a
formatter to. Set the language mode of a `.d` file manually once (command
palette → **Change Language Mode** → **D**) to confirm that a D extension is
present.

## How it works

`dfmt` is documented to read D source from **stdin** and write the formatted
source to **stdout** when no file name is given, so the extension streams the
document through the process and never writes a temporary file:

1. `vscode.languages.registerDocumentFormattingEditProvider` is registered for
   the `d` language (document schemes `file` and `untitled`).
2. When VS Code asks for formatting, the document text is piped to `dfmt` over
   stdin, together with any configured arguments.
3. The formatted text comes back on stdout and is applied as a single
   `vscode.TextEdit` that replaces the document range. The file on disk is never
   touched directly.
4. The process is started with `child_process.spawn` and an argument array — no
   shell, no string concatenation — so paths containing spaces work and the
   configured values can never be interpreted by a shell.

Failure handling, in line with "never make the document worse":

* A non-zero exit code, an unavailable executable, or a missing execute
  permission leaves the document exactly as it was and shows an error
  notification with **Show Log** / **Open Settings** actions.
* `dfmt` formats files with syntax errors on a best-effort basis: it still writes
  output to stdout, reports the problem on stderr, and exits with code `0`. In
  that case the formatted result is applied and the diagnostics are written to
  the **dfmt** output channel (**View → Output → dfmt**).
* If `dfmt` returns nothing for a document that had content, the document is
  left unchanged rather than being emptied.
* Results are only applied if the document still has the version it had when
  formatting started. Editing while a format is in flight discards the stale
  result.
* Requests are serialised per document, so two overlapping formats can never
  race on the same file.
* Cancelling a format request kills the running `dfmt` process.

### About `.editorconfig`

`dfmt` reads `.editorconfig` files, and when it formats stdin it looks for the
files that would apply to a D file in its **current working directory**. The
extension therefore starts `dfmt` from the folder that contains the document, so
your project's `.editorconfig` is honoured, exactly as if you had run `dfmt` on
the file from that folder.

This means a project `.editorconfig` such as

```ini
[*.d]
indent_style = space
indent_size = 2
dfmt_brace_style = allman
end_of_line = lf
```

wins over dfmt's built-in defaults — including `end_of_line`, which can switch a
CRLF file to LF. Set `"dfmt.useEditorConfig": false` to ignore `.editorconfig`
entirely and use dfmt's defaults plus `dfmt.arguments`.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `dfmt.path` | `string` | `"dfmt"` | Path to the `dfmt` executable. The default resolves `dfmt` through `PATH`. Surrounding double quotes are ignored and the path may contain spaces. |
| `dfmt.arguments` | `string[]` | `[]` | Extra command-line arguments passed to `dfmt` on every invocation, for example `--single_indent=true`. Run `dfmt --help` for the full list. |
| `dfmt.useEditorConfig` | `boolean` | `true` | Run `dfmt` from the document's folder so the project's `.editorconfig` applies. |

Example `settings.json`:

```jsonc
{
  "dfmt.path": "C:\\dlangdevtools\\dfmt.exe",
  "dfmt.arguments": ["--max_line_length=100"],
  "dfmt.useEditorConfig": true
}
```

All three settings also accept a workspace or folder scope, so a multi-root
workspace can point at different `dfmt` builds per folder.

## Making it the default formatter for D

If exactly one extension registers a formatter for `d`, VS Code selects it
automatically. When several extensions offer D formatting, pick this one
explicitly:

```jsonc
{
  "[d]": {
    "editor.defaultFormatter": "local.dfmt-dlang"
  },
  "editor.formatOnSave": true
}
```

`local.dfmt-dlang` is `<publisher>.<name>` from `package.json`. Change
`publisher` if you rebuild the extension under a different publisher.

### Resolving formatter conflicts

* **Another extension wins.** Set `editor.defaultFormatter` as above. The
  extension id of a candidate formatter is shown on hover in
  **Preferences: Configure Language Specific Settings**.
* **Nothing happens on save.** Either `editor.defaultFormatter` points at
  another extension, or `editor.formatOnSave` is off. Run **Format Document**
  once; if a "multiple formatters" prompt appears, choose *Configure…* and select
  **dfmt - D formatter**.
* **The extension is not offered at all.** No other extension is contributing
  the `d` language id, or the file's language mode is not D. Check the status
  bar.
* **You want to disable it temporarily.** Set `"dfmt.path"` to a nonsense value
  and use **Show Log** to see why, or disable the extension from the Extensions
  view.

This extension never writes to `editor.defaultFormatter`, `formatOnSave`, or any
other LSP-related setting.

## Development

Everything runs through [bun](https://bun.sh); `node`/`npm` are not required.
VS Code bundles its own Node runtime for the extension host, and the build
tooling (`tsc`, `vsce`) is executed by bun.

### 1. Install the development dependencies

```powershell
cd C:\Users\Mata\Mata\Dev\dfmt-dlang
bun install
```

### 2. Open the project in VS Code

```powershell
code .
```

### 3. Run the extension in the Extension Development Host

Press **F5** (or **Run → Start Debugging**). This runs the `bun: watch` build
task first and then opens a second VS Code window titled
*[Extension Development Host]* with the extension loaded.

### 4. Test Format Document and Format on Save

In the Extension Development Host window:

1. Open `app.d` (a sample with deliberately odd indentation is included).
2. Run **Format Document** with `Shift+Alt+F`. The file should be reformatted
   immediately.
3. Turn on format on save and save again:

   ```jsonc
   {
     "editor.formatOnSave": true,
     "[d]": { "editor.defaultFormatter": "local.dfmt-dlang" }
   }
   ```

4. Open **View → Output** and select **dfmt** from the dropdown to see the log,
   including any stderr diagnostics.
5. To verify error handling, set `"dfmt.path": "dfmt-does-not-exist"` and format
   again: an error notification appears and the document is left untouched.

### 5. Run the automated tests

```powershell
bun test          # unit + integration tests against the real dfmt binary
bun run check-types   # type-check src/ and test/
```

The tests exercise the real `dfmt` executable. They are skipped — not failed —
when `dfmt` is not on the `PATH`; set `DFMT_PATH` to point at a specific binary:

```powershell
$env:DFMT_PATH = "C:\dlangdevtools\dfmt.exe"; bun test
```

### 6. Package the extension as a `.vsix`

```powershell
bun run package
```

This compiles the TypeScript and then runs `vsce`. It produces
`dfmt-dlang-0.1.0.vsix` in the project root. Equivalent explicit command:

```powershell
bun run compile
bunx @vscode/vsce package --allow-missing-repository --no-dependencies
```

> `vsce` is called with `--no-dependencies` because the extension has no runtime
> dependencies. Its automatic "prepublish" step would shell out to `npm`, so
> compilation is wired into the `package` script instead of a
> `vscode:prepublish` script.

### 7. Install the `.vsix` locally

```powershell
code --install-extension .\dfmt-dlang-0.1.0.vsix --force
```

`--force` overwrites a previously installed version. Verify with:

```powershell
code --list-extensions --show-versions | Select-String dfmt
```

Reload VS Code (**Developer: Reload Window**) after installing or updating. To
remove it again:

```powershell
code --uninstall-extension local.dfmt-dlang
```

No Marketplace account or publication is required.

## Quick reference

```powershell
cd C:\Users\Mata\Mata\Dev\dfmt-dlang
bun install                                   # development dependencies
bun run compile                               # compile TypeScript to out/
bun run watch                                 # recompile on change
bun test                                      # run the test suite
bun run check-types                           # type-check src/ and test/
bun run package                               # produce dfmt-dlang-0.1.0.vsix
code --install-extension .\dfmt-dlang-0.1.0.vsix --force
code --uninstall-extension local.dfmt-dlang
```

## Project layout

```
dfmt-dlang/
├─ package.json           Extension manifest: activation, settings, scripts
├─ tsconfig.json          Build config (CommonJS output in out/)
├─ tsconfig.test.json     Type-check config for src/ and test/
├─ .vscodeignore          Files excluded from the .vsix
├─ .vscode/
│  ├─ launch.json         F5 → Extension Development Host
│  └─ tasks.json          bun: watch / compile / test tasks
├─ src/
│  ├─ extension.ts        VS Code glue: provider, settings, queueing, errors
│  └─ dfmt.ts             Process wrapper (no vscode import, unit testable)
├─ test/
│  ├─ dfmt.test.ts        Tests for the process wrapper
│  └─ extension.test.ts   Provider tests with the vscode API stubbed
└─ app.d                  Sample D file for manual testing
```

`src/dfmt.ts` is intentionally free of `vscode` imports so the formatter
integration can be tested against the real binary without launching VS Code.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `dfmt: could not execute the dfmt formatter "dfmt".` | `dfmt` is not on the `PATH` of the VS Code process. Set `dfmt.path` to the full path, for example `C:\\dlangdevtools\\dfmt.exe`. |
| Nothing happens on `Shift+Alt+F`. | Another extension is the default formatter for `d`, or no extension contributes `d`. See *Resolving formatter conflicts*. |
| The file is indented with tabs/spaces you did not configure. | A project `.editorconfig` is being applied by `dfmt`. Adjust it, pass `dfmt.arguments`, or set `dfmt.useEditorConfig` to `false`. |
| Formatting a file with a syntax error seems to do nothing. | `dfmt` could not parse the file; check the **dfmt** output channel for the reported diagnostics. |
| CRLF files become LF. | `.editorconfig` sets `end_of_line = lf`. Remove it or set `dfmt.useEditorConfig` to `false`. |

Run `dfmt --version` in a terminal to confirm which binary is being used.
