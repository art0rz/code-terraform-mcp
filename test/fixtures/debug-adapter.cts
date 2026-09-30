interface Message {
  seq: number;
  command: string;
  arguments: { breakpoints?: { line: number }[] };
}
const { stdin, stdout } = process;
let buffer: Buffer = Buffer.alloc(0);
let seq = 1;

function send(message: object) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }));
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

function handle(message: Message) {
  const command = message.command;
  if (command === "launch" || command === "attach") {
    send({ type: "event", event: "initialized", body: {} });
    send({
      type: "event",
      event: "output",
      body: { category: "console", output: `connected via ${command}` },
    });
  }
  const responses: Record<string, unknown> = {
    initialize: { supportsConfigurationDoneRequest: true },
    launch: {},
    attach: {},
    configurationDone: {},
    setBreakpoints: {
      breakpoints: (message.arguments.breakpoints ?? []).map(({ line }) => ({
        verified: true,
        line,
      })),
    },
    threads: { threads: [{ id: 1, name: "pioneer_1" }] },
    stackTrace: { stackFrames: [{ id: 42, name: "main", line: 3, column: 1 }], totalFrames: 1 },
    scopes: { scopes: [{ name: "Locals", variablesReference: 12 }] },
    variables: { variables: [{ name: "x", value: "3", variablesReference: 0 }] },
    evaluate: { result: "3", variablesReference: 0 },
    pause: {},
    continue: {},
    next: {},
    stepIn: {},
    stepOut: {},
    disconnect: {},
  };
  send({
    type: "response",
    request_seq: message.seq,
    command,
    success: true,
    body: responses[command] ?? {},
  });
  if (command === "configurationDone")
    send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
  if (command === "disconnect") process.exit(0);
}

stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const match = buffer
      .subarray(0, end)
      .toString()
      .match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const size = Number(match[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()) as Message;
    buffer = buffer.subarray(end + 4 + size);
    handle(message);
  }
});
stdin.resume();
