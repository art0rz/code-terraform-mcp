# Code: Terraform MCP

A local, read-only Model Context Protocol server for the Code: Terraform manual and game-aware language service.

The manual stays as one source file. At startup, the server parses it into logical entries in memory, indexes the entries for lexical search, and reloads the index automatically when the file changes.

When a live save workspace is configured, the server also launches the game's bundled language server. An MCP client can validate supplied source, inspect a symbol, or request a short completion list in the context of a real registered machine script or Library. Source is opened as an unsaved in-memory document and is never written to the live save.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_manual` | Search titles, hierarchy, headings, inline API symbols, and body text. |
| `get_manual_entry` | Read the complete Markdown for one result. |
| `list_manual_sections` | Browse sections, groups, and entry counts. |
| `get_manual_build` | Check the loaded build, source path, size, and timestamps. |
| `list_script_targets` | List registered scripts and Libraries, including component owner types. |
| `validate_script` | Return game-aware diagnostics for complete supplied source. |
| `inspect_symbol` | Return hover, signature, and definition information at a position. |
| `complete_at` | Return a limited, optionally filtered contextual completion list. |

All tools are annotated as read-only, idempotent, non-destructive, and closed-world.

## Requirements

- Node.js 20 or newer
- Python 3 (used only as a transparent stdio relay for the bundled Node language server)
- The exported `Code-Terraform-DOCS-Manual.md`
- Optional: a live save scripts workspace containing `codeterraform-workspace.json`

## Install and verify

```bash
npm install
npm run verify
```

By default, the server reads `Code-Terraform-DOCS-Manual.md` from the process
working directory. This makes the manual part of each project using the MCP:

```text
my-code-terraform-project/
├── Code-Terraform-DOCS-Manual.md
├── README.md
├── libraries/
├── scripts/
└── tests/
```

Run the server from the project directory:

```bash
cd /path/to/my-code-terraform-project
node /path/to/code-terraform-docs-mcp/src/index.js
```

STDIO is reserved for MCP protocol messages, so a successful server intentionally prints nothing while waiting for a client.

Use another manual path with either form:

```bash
node src/index.js --manual /absolute/path/to/Code-Terraform-DOCS-Manual.md

CODE_TERRAFORM_DOCS_MANUAL=/absolute/path/to/Code-Terraform-DOCS-Manual.md npm start

node src/index.js \
  --manual /absolute/path/to/Code-Terraform-DOCS-Manual.md \
  --workspace /absolute/path/to/save_scripts
```

## Connect Codex

Add the local STDIO server from the command line:

```bash
codex mcp add code_terraform_docs \
  --env CODE_TERRAFORM_WORKSPACE=/path/to/your/code-terraform/save/scripts \
  -- node /path/to/code-terraform-docs-mcp/src/index.js
```

Codex launches the server in the active project's working directory, so no
manual-path environment variable is needed when the manual is stored at the
project root. `--manual` and `CODE_TERRAFORM_DOCS_MANUAL` remain available as
explicit overrides.

Alternatively, copy [`examples/codex-config.toml`](examples/codex-config.toml) into the relevant Codex `config.toml`. Use a project `.codex/config.toml` only in a trusted project.

After adding the server, restart or refresh the local Codex client, then use `/mcp` or `codex mcp list` to confirm that `code_terraform_docs` is connected.

## Example prompts

- “Search the Code: Terraform manual for charging a rover, then show the relevant API.”
- “What properties does the Battery component expose?”
- “Which manual build are you using?”
- “List the manual's component groups.”
- “Validate this Pioneer script against `pioneer_3`.”
- “What does `self.nav` expose on this Pioneer?”

The server instructions encourage clients to search first, fetch full manual entries for authoritative guidance, and validate generated game scripts before presenting them.

## Game-aware analysis

The workspace path is fixed when the MCP process starts. `list_script_targets` reads only the documents registered by the game's `codeterraform-workspace.json`. The remaining language tools accept one of those IDs or paths plus complete source text; they do not accept arbitrary filesystem paths.

The MCP launches its own language-server process instead of connecting to an editor's private stdio session. It automatically restarts that process if the workspace advertises a different server path or analysis version. Requests are serialized so two callers cannot replace the same in-memory document simultaneously.

Positions passed to `inspect_symbol` and `complete_at` are one-based. Diagnostics returned by `validate_script` are also normalized to one-based lines and columns.

If a save is rebuilt, moved, or replaced, update `CODE_TERRAFORM_WORKSPACE` and restart the MCP server. The game must have exported the workspace and bundled language server, but the target script does not need to be running.

## Search behavior

Search is deterministic and entirely local. It boosts exact title matches, title phrases, hierarchy, inline code terms, headings, and body occurrences in that order. Results include stable numeric entry IDs, generated documentation URLs, scores, and short snippets.

There is no embedding service, database, network call, or OpenAI API key. Numeric IDs follow source order and may change when a new export adds or reorders entries, so callers should use IDs returned by the current search result.

## Development

```bash
npm run check
npm test
npm run verify
```

Project structure:

```text
src/
├── index.js          # CLI and STDIO transport
├── language-service.js # Isolated LSP lifecycle and normalized results
├── manual-store.js   # File resolution, caching, and live reload
├── parser.js         # Markdown-to-entry parser
├── search.js         # Ranking, filtering, snippets, and lookup
├── server.js         # MCP server and tool schemas
├── stdio-proxy.py    # Transparent stdio relay for the bundled Node server
└── workspace-store.js # Registered-target and workspace validation
```

The manual and workspace roots are fixed when the process starts. Language tools resolve only game-registered targets, never write supplied source, reject paths outside the workspace, and refuse language-server workspace edits.
