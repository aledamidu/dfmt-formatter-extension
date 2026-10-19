# Create a VS Code Extension for dfmt

Create a minimal, standalone Visual Studio Code extension that integrates the **`dfmt` formatter for the D programming language** directly into VS Code.

## Goal

I already have `dfmt` installed on my Windows system. I do not want to use DCD or install another third-party VS Code extension just to format D code.

The extension must work independently of any D language server or other D-related extension.

## Requirements

### 1. Official VS Code Formatting API

- Use the official VS Code Extension API.
- Register a document formatting provider using `vscode.languages.registerDocumentFormattingEditProvider`.
- Support D source files (`.d`).
- Integrate with the standard VS Code commands:
  - Format Document (`Shift + Alt + F`).
  - Format on Save (`editor.formatOnSave`).
- Do not create a custom formatting command when the standard formatting API can handle the task.
- Do not implement a language server, autocomplete, diagnostics, or other unrelated features.

### 2. Execute dfmt

- Execute the existing `dfmt` binary as an external process.
- Support Windows and paths containing spaces.
- Provide a configurable setting for the executable path, such as `dfmt.path`.
- Use `dfmt`'s documented input/output behavior. Verify the correct command-line arguments and whether it accepts source code through stdin before implementing the process invocation.
- If the formatter requires a file instead of stdin, use a safe temporary-file approach and clean up temporary files.
- Do not use `shell: true` or construct shell commands from user input.
- Preserve the document's contents if formatting fails.
- Handle process errors, nonzero exit codes, stderr output, and unavailable executables.
- Prevent concurrent formatting requests from corrupting or overwriting document contents.
- Apply the formatted result as a `vscode.TextEdit` rather than directly modifying the file through the filesystem.

### 3. Configuration

Provide a setting for the `dfmt` executable path. Prefer a configurable path with a sensible default that resolves `dfmt` through the system `PATH`.

Allow the formatter's options to be extended later without unnecessary complexity.

Do not modify or override the user's existing LSP configuration.

### 4. Extension conflicts

- Do not register the D language itself; assume another installed extension already provides the `d` language identifier.
- Register the formatter only for D documents.
- Document how to set this extension as the default formatter for D in VS Code's `settings.json`.
- Explain how to resolve conflicts if another extension also provides formatting for D.

### 5. Project structure and implementation

Create a complete, minimal project with all necessary files, including:

- `package.json`
- `src/extension.ts` or `extension.js`
- `tsconfig.json` if using TypeScript
- `.vscodeignore` if needed
- `README.md`
- Any tests necessary to validate the formatter integration

Use TypeScript if it improves type safety without introducing unnecessary dependencies. Keep runtime dependencies minimal.

### 6. Testing and installation

Explain how to:

1. Install the development dependencies.
2. Open the project in VS Code.
3. Run the extension using the Extension Development Host (`F5`).
4. Test Format Document and Format on Save.
5. Package the extension as a `.vsix` file.
6. Install the generated `.vsix` locally using the VS Code CLI.

The extension must not require publication to the Marketplace.

### 7. Quality requirements

- Follow current VS Code extension development best practices.
- Include clear error messages when `dfmt` cannot be executed.
- Avoid unnecessary abstractions and dependencies.
- Do not fabricate `dfmt` CLI behavior or assume unsupported flags.
- Consult the official VS Code Extension API documentation and the official `dfmt` documentation or repository before making implementation decisions.
- Provide working, complete source files rather than pseudocode or isolated snippets.

## Deliverables

Produce the complete project files, explain the implementation briefly, and provide exact PowerShell commands for building, testing, packaging, and installing the extension on Windows.

Prioritize a reliable, minimal formatter extension over unnecessary features.
