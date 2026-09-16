# Shuck for Zed

[Shuck](https://github.com/ewhauser/shuck) provides linting and formatting for shell scripts through its native language server. This extension connects Zed's `Shell Script` language to `shuck server` over stdio.

The MVP is tested against Shuck `v0.2.2`. Keep the installed binary on a compatible release when upgrading the extension.

## Requirements

Install Shuck separately and make the `shuck` executable available to Zed. See Shuck's [installation documentation](https://github.com/ewhauser/shuck#installation) if it is not installed yet:

```sh
shuck --version
```

The MVP does not download a binary. You can use a custom executable path with Zed's LSP settings.

## Settings

Enable Shuck as the shell language server and use it as the formatter:

```json
{
  "languages": {
    "Shell Script": {
      "language_servers": ["shuck"],
      "formatter": "language_server",
      "format_on_save": "on"
    }
  }
}
```

To use a binary that is not on Zed's shell `PATH`:

```json
{
  "lsp": {
    "shuck": {
      "binary": {
        "path": "/absolute/path/to/shuck",
        "arguments": ["server"]
      }
    }
  }
}
```

`binary.arguments` is the complete argument list and replaces the default `["server"]`; include `server` yourself when adding Shuck options. For example, to pass a server option, use `["server", "--isolated"]`. Environment variables can be supplied with `binary.env`.

If another Bash language server is enabled, configure `languages.Shell Script.language_servers` explicitly so that diagnostics and formatting are not provided twice.

Shuck reads `shuck.toml` or `.shuck.toml` using its normal project configuration rules. GitHub Actions YAML embedded-shell LSP mapping is not included in this version.

## Development

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release --target wasm32-wasip2
node scripts/lsp-smoke.js
shuck format --diff fixtures/shuck-config/format.sh
```

The smoke test requires a local `shuck` executable and verifies the native server's advertised diagnostics/formatting capabilities, a real diagnostic, quick fixes, `source.fixAll.shuck`, source navigation, and formatting edits. The final command exercises the equivalent `shuck.toml` configuration filename; exit status 1 is expected because `--diff` reports the pending formatting change. Load the repository through Zed's **Install Dev Extension** action to test the same integration from the editor.

## License

MIT
