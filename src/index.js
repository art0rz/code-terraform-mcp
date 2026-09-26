#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ManualStore, DEFAULT_MANUAL_PATH } from "./manual-store.js";
import { LanguageService } from "./language-service.js";
import { DebugService } from "./debug-service.js";
import { createServer } from "./server.js";
import { WorkspaceStore } from "./workspace-store.js";

function usage() {
  return `code-terraform-docs-mcp

Usage:
  code-terraform-docs-mcp [--manual /absolute/path/to/manual.md] [--workspace /absolute/path/to/save-scripts]

Options:
  --manual <path>  Markdown manual to serve.
  --workspace <path>  Live Code: Terraform scripts workspace used for game-aware analysis.
  --help           Show this help.

Environment:
  CODE_TERRAFORM_DOCS_MANUAL  Manual path used when --manual is omitted.
  CODE_TERRAFORM_WORKSPACE    Workspace path used when --workspace is omitted.

Default:
  ${DEFAULT_MANUAL_PATH}
  (Code-Terraform-DOCS-Manual.md in the process working directory)`;
}

function parseArguments(argv) {
  let manualPath = process.env.CODE_TERRAFORM_DOCS_MANUAL || DEFAULT_MANUAL_PATH;
  let workspacePath = process.env.CODE_TERRAFORM_WORKSPACE || null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true, manualPath, workspacePath };
    if (argument === "--manual") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manual requires a path.");
      manualPath = value;
      index += 1;
      continue;
    }
    if (argument === "--workspace") {
      const value = argv[index + 1];
      if (!value) throw new Error("--workspace requires a path.");
      workspacePath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { help: false, manualPath, workspacePath };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const store = new ManualStore(options.manualPath);
  await store.load();
  const workspaceStore = new WorkspaceStore(options.workspacePath);
  const languageService = new LanguageService(workspaceStore);
  const debugService = new DebugService(workspaceStore);
  const server = createServer(store, { workspaceStore, languageService, debugService });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await languageService.dispose();
    await debugService.dispose();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`code-terraform-docs-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
