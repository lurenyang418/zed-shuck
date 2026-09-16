#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..", "fixtures");
const shuck = process.env.SHUCK_BINARY || "shuck";
// Keep this protocol fixture in sync with extension.toml's Shell Script mapping.
const shellScriptLanguageId = "shellscript";
const newline = String.fromCharCode(13, 10);
const messages = [];
const waiters = [];
let serverError = null;

class MessageParser {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from(`${newline}${newline}`));
      if (headerEnd < 0) return;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthHeader = header
        .split(newline)
        .find((line) => line.toLowerCase().startsWith("content-length:"));
      if (!lengthHeader) throw new Error("LSP response has no Content-Length header");

      const length = Number.parseInt(lengthHeader.split(":", 2)[1].trim(), 10);
      const bodyStart = headerEnd + newline.length * 2;
      if (!Number.isInteger(length) || this.buffer.length < bodyStart + length) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.onMessage(JSON.parse(body));
    }
  }
}

function send(server, message) {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}${newline}${newline}${body}`);
}

function waitFor(predicate, timeoutMs = 5000) {
  if (serverError) return Promise.reject(serverError);

  for (let index = 0; index < messages.length; index += 1) {
    if (predicate(messages[index])) return Promise.resolve(messages.splice(index, 1)[0]);
  }

  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const position = waiters.indexOf(waiter);
      if (position >= 0) waiters.splice(position, 1);
      reject(new Error(`Timed out waiting for an LSP message after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function offsetAtPosition(text, position) {
  const lines = text.split("\n");
  if (position.line >= lines.length) {
    throw new Error(`LSP edit line is out of bounds: ${position.line}`);
  }

  return (
    lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) +
    position.character
  );
}

function applyTextEdits(text, edits) {
  const editsWithOffsets = edits
    .map((edit) => ({
      start: offsetAtPosition(text, edit.range.start),
      end: offsetAtPosition(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((left, right) => right.start - left.start);

  return editsWithOffsets.reduce(
    (result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end),
    text,
  );
}

function assertFormattedText(response, source, expected, description) {
  if (!Array.isArray(response.result)) {
    throw new Error(`Expected ${description} to return text edits; got ${JSON.stringify(response)}`);
  }

  const formatted = applyTextEdits(source, response.result);
  if (formatted !== expected) {
    throw new Error(
      `Unexpected ${description} result; expected ${JSON.stringify(expected)}, got ${JSON.stringify(formatted)}`,
    );
  }
}

function reportServerError(error) {
  if (serverError) return;
  serverError = error instanceof Error ? error : new Error(String(error));
  for (const waiter of waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(serverError);
  }
}

const server = spawn(shuck, ["server"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});
const serverClosed = new Promise((resolve) => server.once("close", resolve));
const parser = new MessageParser((message) => {
  const waiterIndex = waiters.findIndex(({ predicate }) => predicate(message));
  if (waiterIndex >= 0) {
    const waiter = waiters.splice(waiterIndex, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  } else {
    messages.push(message);
  }
});

server.on("error", (error) => {
  reportServerError(new Error(`Unable to start Shuck executable '${shuck}': ${error.message}`));
});

server.stdout.on("data", (chunk) => {
  try {
    parser.push(chunk);
  } catch (error) {
    reportServerError(new Error(`Could not parse Shuck output: ${error.message}`));
    server.kill();
  }
});

server.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

async function run() {
  const diagnosticsPath = path.join(root, "diagnostics.sh");
  const fixablePath = path.join(root, "fixable.sh");
  const formatPath = path.join(root, "format.sh");
  const sourcePath = path.join(root, "source", "main.sh");
  const libraryPath = path.join(root, "source", "lib.sh");
  const diagnosticsUri = pathToFileURL(diagnosticsPath).href;
  const fixableUri = pathToFileURL(fixablePath).href;
  const formatUri = pathToFileURL(formatPath).href;
  const sourceUri = pathToFileURL(sourcePath).href;
  const libraryUri = pathToFileURL(libraryPath).href;
  const diagnosticsText = fs.readFileSync(diagnosticsPath, "utf8");
  const fixableText = fs.readFileSync(fixablePath, "utf8");
  const formatText = fs.readFileSync(formatPath, "utf8");
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const expectedTwoSpaceFormat = [
    "#!/usr/bin/env bash",
    "",
    "main() {",
    '  echo "hello"',
    "}",
    "",
    "main",
  ].join("\n") + "\n";
  const expectedFourSpaceFormat = expectedTwoSpaceFormat.replace(
    '  echo "hello"',
    '    echo "hello"',
  );

  send(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(`${root}${path.sep}`).href,
      initializationOptions: { unsafeFixes: true },
      capabilities: {},
    },
  });
  const initialize = await waitFor((message) => message.id === 1);
  if (!initialize.result?.capabilities?.documentFormattingProvider) {
    throw new Error("Shuck did not advertise document formatting");
  }
  if (!initialize.result?.capabilities?.diagnosticProvider) {
    throw new Error("Shuck did not advertise diagnostics");
  }
  const codeActionKinds = initialize.result.capabilities.codeActionProvider?.codeActionKinds || [];
  if (!codeActionKinds.includes("quickfix") || !codeActionKinds.includes("source.fixAll.shuck")) {
    throw new Error("Shuck did not advertise quick fixes and source.fixAll.shuck");
  }

  send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
  send(server, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: diagnosticsUri,
        languageId: shellScriptLanguageId,
        version: 1,
        text: diagnosticsText,
      },
    },
  });
  const diagnostics = await waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params?.uri === diagnosticsUri,
  );
  if (!diagnostics.params.diagnostics.length) {
    throw new Error("Expected diagnostics for fixtures/diagnostics.sh");
  }

  send(server, {
    jsonrpc: "2.0",
    id: 7,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri: diagnosticsUri },
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 13 },
      },
      context: { diagnostics: diagnostics.params.diagnostics, only: ["quickfix"] },
    },
  });
  const codeActions = await waitFor((message) => message.id === 7);
  if (!Array.isArray(codeActions.result) || !codeActions.result.length) {
    throw new Error("Expected quick-fix code actions for fixtures/diagnostics.sh");
  }

  send(server, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: fixableUri,
        languageId: shellScriptLanguageId,
        version: 1,
        text: fixableText,
      },
    },
  });
  const fixableDiagnostics = await waitFor(
    (message) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params?.uri === fixableUri,
  );
  if (!fixableDiagnostics.params.diagnostics.length) {
    throw new Error("Expected a fixable diagnostic for fixtures/fixable.sh");
  }

  send(server, {
    jsonrpc: "2.0",
    id: 8,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri: fixableUri },
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 5 },
      },
      context: {
        diagnostics: fixableDiagnostics.params.diagnostics,
        only: ["source.fixAll.shuck"],
      },
    },
  });
  const sourceFixAll = await waitFor((message) => message.id === 8);
  if (
    !Array.isArray(sourceFixAll.result) ||
    !sourceFixAll.result.some((action) => action.kind === "source.fixAll.shuck")
  ) {
    throw new Error(
      `Expected source.fixAll.shuck code actions for fixtures/fixable.sh; got ${JSON.stringify(sourceFixAll)}`,
    );
  }

  send(server, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: formatUri,
        languageId: shellScriptLanguageId,
        version: 1,
        text: formatText,
      },
    },
  });
  send(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri: formatUri },
      options: { tabSize: 2, insertSpaces: true },
    },
  });
  const formatting = await waitFor((message) => message.id === 2);
  assertFormattedText(
    formatting,
    formatText,
    expectedTwoSpaceFormat,
    "two-space document formatting",
  );

  send(server, {
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/rangeFormatting",
    params: {
      textDocument: { uri: formatUri },
      range: {
        start: { line: 2, character: 0 },
        end: { line: 4, character: 1 },
      },
      options: { tabSize: 2, insertSpaces: true },
    },
  });
  const rangeFormatting = await waitFor((message) => message.id === 3);
  const rangeEditText = Array.isArray(rangeFormatting.result)
    ? rangeFormatting.result.map((edit) => edit.newText || "").join("")
    : "";
  if (!rangeEditText) {
    throw new Error(
      `Expected range-formatting edits; got ${JSON.stringify(rangeFormatting.result)}`,
    );
  }
  assertFormattedText(
    rangeFormatting,
    formatText,
    expectedTwoSpaceFormat,
    "two-space range formatting",
  );

  send(server, {
    jsonrpc: "2.0",
    method: "workspace/didChangeConfiguration",
    params: { settings: { format: { "indent-width": 4 } } },
  });
  send(server, {
    jsonrpc: "2.0",
    id: 10,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri: formatUri },
      options: { tabSize: 4, insertSpaces: true },
    },
  });
  const reconfiguredFormatting = await waitFor((message) => message.id === 10);
  assertFormattedText(
    reconfiguredFormatting,
    formatText,
    expectedFourSpaceFormat,
    "four-space formatting after didChangeConfiguration",
  );

  send(server, {
    jsonrpc: "2.0",
    method: "workspace/didChangeConfiguration",
    params: { settings: {} },
  });
  send(server, {
    jsonrpc: "2.0",
    id: 11,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri: formatUri },
      options: { tabSize: 2, insertSpaces: true },
    },
  });
  const restoredFormatting = await waitFor((message) => message.id === 11);
  assertFormattedText(
    restoredFormatting,
    formatText,
    expectedTwoSpaceFormat,
    "two-space formatting after configuration reset",
  );

  send(server, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: sourceUri,
        languageId: shellScriptLanguageId,
        version: 1,
        text: sourceText,
      },
    },
  });
  send(server, {
    jsonrpc: "2.0",
    id: 4,
    method: "workspace/symbol",
    params: { query: "greet" },
  });
  const symbols = await waitFor((message) => message.id === 4);
  if (
    !symbols.result?.some(
      (symbol) => symbol.name === "greet" && symbol.location?.uri === libraryUri,
    )
  ) {
    throw new Error(
      `Expected the sourced greet function in workspace symbols; got ${JSON.stringify(symbols.result)}`,
    );
  }

  send(server, {
    jsonrpc: "2.0",
    id: 5,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: sourceUri },
      position: { line: 4, character: 1 },
    },
  });
  const definition = await waitFor((message) => message.id === 5);
  const definitions = Array.isArray(definition.result)
    ? definition.result
    : definition.result
      ? [definition.result]
      : [];
  if (!definitions.some((location) => location.uri === libraryUri)) {
    throw new Error("Expected a definition in the sourced library");
  }

  send(server, {
    jsonrpc: "2.0",
    id: 9,
    method: "textDocument/references",
    params: {
      textDocument: { uri: sourceUri },
      position: { line: 4, character: 1 },
      context: { includeDeclaration: true },
    },
  });
  const references = await waitFor((message) => message.id === 9);
  if (
    !Array.isArray(references.result) ||
    !references.result.some((location) => location.uri === sourceUri) ||
    !references.result.some((location) => location.uri === libraryUri)
  ) {
    throw new Error(
      `Expected references for the sourced greet function; got ${JSON.stringify(references.result)}`,
    );
  }

  send(server, { jsonrpc: "2.0", id: 6, method: "shutdown", params: null });
  await waitFor((message) => message.id === 6);
  send(server, { jsonrpc: "2.0", method: "exit", params: null });
  server.stdin.end();

  console.log(
    "LSP smoke passed: diagnostics, quick fixes, source.fixAll, formatting, configuration refresh, and source navigation are available",
  );
}

async function stopServer() {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([
      serverClosed,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await serverClosed;
  }
}

run()
  .catch((error) => {
    console.error(`LSP smoke failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(stopServer);
