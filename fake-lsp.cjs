const { stdin, stdout } = process;
let buffer = Buffer.alloc(0);
let initializationOptions = null;
const keepAlive = setInterval(() => {}, 1_000);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

function onMessage(message) {
  if (message.method === "initialize") {
    initializationOptions = message.params.initializationOptions ?? null;
    send({ id: message.id, result: { capabilities: { hoverProvider: true, completionProvider: {}, signatureHelpProvider: {}, definitionProvider: true,
      referencesProvider: true, documentSymbolProvider: true, renameProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: ["function"], tokenModifiers: ["declaration"] }, full: true } } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "initialized") {
    send({ method: "codeterraform/status", params: { ready: true, analysisVersion: "test-analysis", initializationOptions } });
    send({ method: "codeterraform/fleet", params: { fleet: { scripts: { pioneer_1: { status: "running" } } } } });
    return;
  }
  if (message.method === "exit") {
    clearInterval(keepAlive);
    process.exit(0);
  }
  if (message.method === "textDocument/didOpen") {
    const { uri, text } = message.params.textDocument;
    if (text.includes("killserver")) process.exit(1);
    const diagnostics = text.includes("broken") ? [{
      severity: 1,
      message: "Fake broken source",
      source: "fake-lsp",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
    }] : [];
    send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
    return;
  }
  if (message.method === "textDocument/hover") {
    send({ id: message.id, result: { contents: { kind: "markdown", value: "**Fake owner**" } } });
    return;
  }
  if (message.method === "textDocument/signatureHelp") {
    send({ id: message.id, result: { activeSignature: 0, activeParameter: 0, signatures: [{ label: "move_to(x, y)", parameters: [{ label: "x" }, { label: "y" }] }] } });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({ id: message.id, result: [] });
    return;
  }
  if (message.method === "textDocument/completion") {
    send({ id: message.id, result: { items: [
      { label: "move_to", kind: 2, detail: "Navigate", insertText: "move_to" },
      { label: "battery", kind: 10, detail: "Battery" }
    ] } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") send({ id: message.id, result: [{ name: "helper", kind: 12,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
    selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } }, children: [] }] });
  if (message.method === "textDocument/references") send({ id: message.id, result: [{ uri: message.params.textDocument.uri,
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } }] });
  if (message.method === "textDocument/rename") send({ id: message.id, result: { changes: {
    [message.params.textDocument.uri]: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } }, newText: message.params.newName }]
  } } });
  if (message.method === "textDocument/semanticTokens/full") send({ id: message.id, result: { data: [0, 4, 6, 0, 1] } });
  if (message.method === "textDocument/formatting") send({ id: message.id, result: [] });
  if (message.method === "textDocument/codeAction") send({ id: message.id, result: [{ title: "Run", command: { command: "codeterraform.run" } }] });
  if (message.method === "codeterraform/gameCommand") send({ id: message.id, result: { ok: true, action: message.params.command } });
}

stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    onMessage(message);
  }
});
stdin.resume();
