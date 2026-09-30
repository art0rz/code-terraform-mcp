import type * as Lsp from "vscode-languageserver-types";

export interface SessionOptions {
  nodePath?: string;
  pythonPath?: string;
  proxyPath?: string;
  timeoutMs?: number;
  ruffPath?: string;
}
export interface Position {
  line: number;
  column: number;
}
export interface Pending<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}
export interface Capabilities {
  semanticTokensProvider?: { legend: Lsp.SemanticTokensLegend };
}
export interface GameStatus {
  ready?: boolean;
  [key: string]: unknown;
}
export interface Fleet {
  scripts?: Record<string, { status?: string; [key: string]: unknown }>;
  machines?: unknown[];
  panels?: unknown[];
  contracts?: unknown[];
  libraries?: unknown[];
  outposts?: unknown[];
  automations?: unknown[];
}
export interface DocumentResults {
  "textDocument/documentSymbol": Lsp.DocumentSymbol[] | null;
  "textDocument/references": Lsp.Location[] | null;
  "textDocument/rename": Lsp.WorkspaceEdit | null;
  "textDocument/semanticTokens/full": Lsp.SemanticTokens | null;
  "textDocument/formatting": Lsp.TextEdit[] | null;
  "textDocument/rangeFormatting": Lsp.TextEdit[] | null;
  "textDocument/codeAction": (Lsp.CodeAction | Lsp.Command)[] | null;
}
export interface RequestResults extends DocumentResults {
  initialize: { capabilities: Capabilities };
  shutdown: null;
  "textDocument/hover": Lsp.Hover | null;
  "textDocument/signatureHelp": Lsp.SignatureHelp | null;
  "textDocument/definition": Lsp.Location | (Lsp.Location | Lsp.LocationLink)[] | null;
  "textDocument/completion": Lsp.CompletionItem[] | Lsp.CompletionList | null;
  "codeterraform/gameCommand": Record<string, unknown>;
}
export type LspMessage =
  | { id: number; method?: undefined; result?: unknown; error?: { message?: string } }
  | { id: number; method: string; params?: { items?: unknown[] } }
  | {
      id?: undefined;
      method: "textDocument/publishDiagnostics";
      params: { uri: string; diagnostics?: Lsp.Diagnostic[] };
    }
  | { id?: undefined; method: "codeterraform/status"; params?: GameStatus }
  | { id?: undefined; method: "codeterraform/fleet"; params?: { fleet?: Fleet } };
