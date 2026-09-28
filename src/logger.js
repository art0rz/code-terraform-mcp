const LEVELS = { off: 0, error: 1, warn: 2, info: 3 };

export function createLogger({ level = process.env.CODE_TERRAFORM_LOG_LEVEL ?? "info", write = (line) => process.stderr.write(line) } = {}) {
  const threshold = LEVELS[level.toLowerCase()] ?? LEVELS.info;
  const emit = (name, message) => {
    if (LEVELS[name] > threshold) return;
    const summary = String(message).replace(/\s+/g, " ").slice(0, 500);
    write(`${new Date().toISOString()} [${name.toUpperCase()}] code-terraform-docs-mcp: ${summary}\n`);
  };
  return {
    error: (message) => emit("error", message),
    warn: (message) => emit("warn", message),
    info: (message) => emit("info", message)
  };
}

export const logger = createLogger();
