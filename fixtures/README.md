# LSP fixtures

These files exercise the native Shuck language server used by the extension:

- `diagnostics.sh` intentionally contains an unclosed `if` block and exercises quick fixes.
- `format.sh` is valid but intentionally under-indented.
- `posix.sh` and `zsh.zsh` cover the initial shell dialects.
- `source/main.sh` and `source/lib.sh` cover source navigation fixtures.
- `.shuck.toml` is a project configuration fixture enabling linting of hinted source files and two-space formatting.
- `shuck-config/shuck.toml` verifies the equivalent non-hidden project configuration filename.

These fixtures verify the two supported configuration filenames independently; they do not test precedence between conflicting configuration files in the same directory.

Run the protocol smoke test from the repository root:

```sh
node scripts/lsp-smoke.js
```
