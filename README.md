# Code: Terraform MCP

A local Model Context Protocol server for the Code: Terraform manual, game-aware language service, and optional live game control/debugging.

The manual stays as one source file. At startup, the server parses it into logical entries in memory, indexes the entries for lexical search, and reloads the index automatically when the file changes.

When a live save workspace is configured, the server also launches the game's bundled language server. An MCP client can validate supplied source, inspect a symbol, or request a short completion list in the context of a real registered machine script or Library. Source is opened as an unsaved in-memory document and is never written to the live save.

## Tools

| Tool                                                           | Purpose                                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_manual`                                                | Search titles, hierarchy, headings, inline API symbols, and body text. Results include each entry's size.                                                                        |
| `get_manual_entry`                                             | Read one result whole, one heading's section, or only its outline (headings and section sizes).                                                                                  |
| `list_manual_sections`                                         | Browse sections, groups, and entry counts.                                                                                                                                       |
| `get_manual_build`                                             | Check the loaded build, source path, size, and timestamps.                                                                                                                       |
| `list_script_targets`                                          | List registered scripts and Libraries, including component owner types.                                                                                                          |
| `validate_script`                                              | Return game-aware diagnostics for complete supplied source.                                                                                                                      |
| `inspect_symbol`                                               | Return hover, signature, and definition information at a position.                                                                                                               |
| `complete_at`                                                  | Return a limited, optionally filtered contextual completion list.                                                                                                                |
| `get_game_status`, `list_fleet`                                | Read the game's published connection, object, and script status snapshots.                                                                                                       |
| `list_script_symbols`, `find_references`, `preview_rename`     | Browse symbols and references, or preview rename edits without applying them.                                                                                                    |
| `get_semantic_tokens`, `format_script`, `list_code_actions`    | Inspect syntax tokens, preview Ruff formatting edits, and list actions without executing them.                                                                                   |
| `run_script`, `stop_script`                                    | Start or stop a registered script in the active game.                                                                                                                            |
| `create_library`, `import_library`, `rename_library`           | Create or rename the active game's Libraries. Importing never replaces an existing Library.                                                                                      |
| `apply_library`, `apply_all_libraries`                         | Deploy saved Library source and restart the scripts that import it. Update a Library by writing its synced `lib/<name>.py` file, then applying it; saving alone does not deploy. |
| `debug_start`, `debug_set_breakpoints`, `debug_control`        | Attach a persistent debug session (optionally starting an idle script), set breakpoints, pause, continue, or step.                                                               |
| `debug_inspect`, `debug_evaluate`, `debug_events`, `debug_end` | Inspect a halted script, evaluate an expression, read events, or detach.                                                                                                         |

Manual, status, source analysis, and debug inspection tools are read-only. Run, Stop, Library management, breakpoint/control, expression evaluation, and debug-session lifecycle tools change the live game and are annotated accordingly. The MCP never writes source into the save workspace itself; game commands are forwarded through the game's language server or debug adapter.

## Requirements

- Node.js 22.22.1 or newer
- Python 3 (transparent stdio relay for the bundled Node language server and debug adapter)
- Optional: Ruff for `format_script`. The game's server finds it on PATH or in common pipx/uv/cargo locations; set `CODE_TERRAFORM_RUFF` to an executable path otherwise
- The exported `Code-Terraform-DOCS-Manual.md`
- Optional: a live save scripts workspace containing `codeterraform-workspace.json`

## Install and verify

```bash
npm ci
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
node /path/to/code-terraform-docs-mcp/dist/index.js
```

The server writes MCP messages to stdout and concise logs to stderr. It logs startup,
manual reloads, language-server transitions, game-changing tool calls, and failures;
routine read calls stay quiet. Set `CODE_TERRAFORM_LOG_LEVEL` to `warn`, `error`,
or `off` to reduce logging (`info` is the default). Successful game-changing
calls are logged by tool name without their arguments or source text.

Every 60 seconds, a heartbeat logs MCP liveness. With a workspace configured,
it also sends a read-only document-symbol request to confirm the bundled LSP
responds and reports the latest status and whether the LSP published a fleet
snapshot. The first check runs at startup. `ready` is the LSP's reported value;
it is not a separate live game-connection flag.

Use another manual path with either form:

```bash
node dist/index.js --manual /absolute/path/to/Code-Terraform-DOCS-Manual.md

CODE_TERRAFORM_DOCS_MANUAL=/absolute/path/to/Code-Terraform-DOCS-Manual.md npm start

node dist/index.js \
  --manual /absolute/path/to/Code-Terraform-DOCS-Manual.md \
  --workspace /absolute/path/to/save_scripts
```

## Connect Codex

Add the local STDIO server from the command line:

```bash
codex mcp add code_terraform_docs \
  --env CODE_TERRAFORM_WORKSPACE=/path/to/your/code-terraform/save/scripts \
  -- node /path/to/code-terraform-docs-mcp/dist/index.js
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
- “Show the outline of the Built-in Functions entry, then read only its Math section.”
- “Which manual build are you using?”
- “List the manual's component groups.”
- “Validate this Pioneer script against `pioneer_3`.”
- “What does `self.nav` expose on this Pioneer?”

The server instructions encourage clients to search first, fetch full manual entries for authoritative guidance, and validate generated game scripts before presenting them.

## Reading large entries

Most entries are short, but some are long: in the bundled manual, `Built-in Functions` is about 70 KB and `Research` about 45 KB, and the 52 entries over 8 KB make up about half the manual's text. Returning such an entry whole costs an agent tens of thousands of tokens when it needs one method.

`get_manual_entry` therefore reads an entry in three ways:

| Arguments                                 | Returns                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `{ "identifier": 12 }`                    | The whole entry, as before.                                                                               |
| `{ "identifier": 12, "outline": true }`   | Only the headings, each with its nesting depth, source line, and section size. No body text.              |
| `{ "identifier": 12, "heading": "Math" }` | One heading's section with its subsections, under the entry heading and the section's enclosing headings. |

A section runs from its heading to the next heading of the same or a higher level. Headings inside fenced code blocks are ignored, like in search. `heading` matching ignores case, punctuation, and code markers. An exact heading text wins, then a match on the heading's leading words (so `abs` picks the `abs(number: float, /) → float` signature, not `isclose(..., abs_tol ...)`), then a partial match anywhere in the heading. The first tier with any match must have exactly one. An ambiguous or unknown heading returns an error that lists the candidate headings, so the caller can retry with the exact text. `heading` and `outline` cannot be combined.

`search_manual` reports each result's size as `characters`, and its text summary marks entries of 8 KB or more, so an agent knows when to ask for the outline first. A typical flow:

1. `search_manual` returns `Built-in Functions` with `characters` around 70,000, and its text summary marks the entry `(… KB; outline first)`.
2. `get_manual_entry` with `{ "identifier": <id>, "outline": true }` lists `Math` and the function signatures under it, about 236 lines.
3. `get_manual_entry` with `{ "identifier": <id>, "heading": "abs" }` returns only the `abs()` section, under its `### Math` heading.

Section results report `section.sourceLineStart` and `section.sourceLineEnd` (one-based, inclusive) into the manual file, like the entry's own source lines.

## Game-aware analysis

The workspace path is fixed when the MCP process starts. `list_script_targets` reads only the documents registered by the game's `codeterraform-workspace.json`. The remaining language tools accept one of those IDs or paths plus complete source text; they do not accept arbitrary filesystem paths.

The MCP launches its own language-server process instead of connecting to an editor's private stdio session. It automatically restarts that process if the workspace advertises a different server path or analysis version. Requests are serialized so two callers cannot replace the same in-memory document simultaneously.

`run_script` and `stop_script` use the game's `codeterraform/gameCommand` language-server request and the **saved registered source**, not the unsaved source passed to validation. The game must be open and may reject a command when the source has changed, the save session changed, or the command bridge is busy. Library tools use the same game command path.

The debug tools launch the game's bundled `debug-adapter.cjs` as a separate Debug Adapter Protocol process. `debug_start` attaches to a running script by default and never starts an idle one; an idle script ends the session immediately. Pass `runIfIdle: true` to start an idle script. `debug_end` detaches the debugger and does not stop the script. Sessions persist in this MCP process until ended, the adapter exits, or the MCP shuts down; at most four sessions are supported. `debug_events` uses a cursor and retains the 100 most recent events. Evaluation can call game APIs and may have side effects.

Positions passed to `inspect_symbol` and `complete_at` are one-based. Diagnostics returned by `validate_script` are also normalized to one-based lines and columns.

If a save is rebuilt, moved, or replaced, update `CODE_TERRAFORM_WORKSPACE` and restart the MCP server. The game must have exported the workspace and bundled language server, but the target script does not need to be running.

## Search behavior

Search is deterministic and entirely local. It boosts exact title matches, title phrases, hierarchy, inline code terms, headings, and body occurrences in that order. Results include stable numeric entry IDs, generated documentation URLs, scores, and short snippets.

There is no embedding service, database, network call, or OpenAI API key. Numeric IDs follow source order and may change when a new export adds or reorders entries, so callers should use IDs returned by the current search result.

## Development

```bash
npm run dev -- --help  # Run TypeScript directly while developing
npm run build         # Compile into dist/ and copy the Python relay
npm start             # Run the compiled server (build first)
npm run check         # Strict TypeScript checks for source, tests, and fixtures
npm run lint          # Oxlint with type-aware rules; warnings fail
npm run lint:fix      # Apply available lint fixes
npm run format        # Format with Oxfmt
npm run format:check  # Check formatting without changing files
npm test              # Build, compile fake servers, and run integration/unit tests
npm run verify        # All checks, formatting, build, and tests
```

TypeScript uses NodeNext ESM resolution with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and unused-code checks. Source imports retain `.js`
extensions so the compiled code runs directly in Node. `dist/` is generated and
ignored by Git; rebuild after updating the source. Existing MCP configurations
must change their executable path from `src/index.js` to `dist/index.js`.

[Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
uses `oxlint-tsgolint`. Oxfmt handles formatting separately. The exported game
manual is excluded from formatting to preserve its authoritative contents.

`npm ci` installs Husky hooks: pre-commit formats staged files with lint-staged
and checks project types and lint; commit-msg enforces Conventional Commits
(for example, `feat: add a manual tool`); pre-push runs `npm run verify`.
[Commitlint's local setup](https://commitlint.js.org/guides/local-setup) describes
the commit-message convention. CI runs verification on Node 22 and 24, and
checks every commit in pull requests. Python 3 is required for integration tests.

Project structure:

```text
src/
├── index.ts          # CLI and STDIO transport
├── language-service.ts # Isolated LSP lifecycle and normalized results
├── debug-service.ts   # Persistent game DAP sessions
├── extra-tools.ts     # Additional LSP, game-control, and debug tool schemas
├── manual-store.ts   # File resolution, caching, and live reload
├── parser.ts         # Markdown-to-entry parser
├── search.ts         # Ranking, filtering, snippets, and lookup
├── sections.ts       # Entry outlines and single-section reads
├── server.ts         # MCP server and tool schemas
├── stdio-proxy.py    # Transparent stdio relay for the bundled Node server
└── workspace-store.ts # Registered-target and workspace validation
```

The manual and workspace roots are fixed when the process starts. Language and debug tools resolve only game-registered targets, reject paths outside the workspace, and refuse language-server workspace edits. Game commands and debug controls can alter running scripts and their game state.
