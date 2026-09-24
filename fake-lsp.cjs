const { stdin, stdout } = process;
let buffer = Buffer.alloc(0);
const keepAlive = setInterval(() => {}, 1_000);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

function onMessage(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { hoverProvider: true, completionProvider: {}, signatureHelpProvider: {}, definitionProvider: true } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    clearInterval(keepAlive);
    process.exit(0);
  }
  if (message.method === "textDocument/didOpen") {
    const { uri, text } = message.params.textDocument;
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
  }
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
