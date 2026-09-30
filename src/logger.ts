const LEVELS = { off: 0, error: 1, warn: 2, info: 3 };

export function createLogger({
  level = process.env.CODE_TERRAFORM_LOG_LEVEL ?? "info",
  write = (line: string) => process.stderr.write(line),
}: { level?: string; write?: (line: string) => void } = {}) {
  const threshold = LEVELS[level.toLowerCase() as keyof typeof LEVELS] ?? LEVELS.info;
  const emit = (name: keyof typeof LEVELS, message: unknown) => {
    if (LEVELS[name] > threshold) return;
    const summary = String(message).replace(/\s+/g, " ").slice(0, 500);
    write(
      `${new Date().toISOString()} [${name.toUpperCase()}] code-terraform-docs-mcp: ${summary}\n`,
    );
  };
  return {
    error: (message: unknown) => emit("error", message),
    warn: (message: unknown) => emit("warn", message),
    info: (message: unknown) => emit("info", message),
  };
}

export const logger = createLogger();
