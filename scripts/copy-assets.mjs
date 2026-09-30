import { copyFile, chmod } from "node:fs/promises";
await copyFile(
  new URL("../src/stdio-proxy.py", import.meta.url),
  new URL("../dist/stdio-proxy.py", import.meta.url),
);
await chmod(new URL("../dist/index.js", import.meta.url), 0o755);
