import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";
const markerSchema = z.object({
  documents: z.array(z.object({ path: z.string(), id: z.string(), kind: z.string() })),
  server: z.object({ path: z.string(), analysisVersion: z.string().optional() }),
  analysisVersion: z.string().optional(),
  language: z.string().optional(),
  saveId: z.string().optional(),
  context: z
    .object({
      machines: z
        .record(
          z.string(),
          z.object({ typeId: z.string().optional(), scriptSlots: z.array(z.string()).optional() }),
        )
        .optional(),
      customPanels: z.record(z.string(), z.object({ scriptId: z.string().optional() })).optional(),
      contractStatus: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
const MARKER_NAME = "codeterraform-workspace.json";

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label} in ${MARKER_NAME}.`);
  }
  return value;
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class WorkspaceStore {
  workspacePath: string | null;
  constructor(workspacePath: string | null = null) {
    this.workspacePath = workspacePath ? path.resolve(workspacePath) : null;
  }

  get configured() {
    return this.workspacePath !== null;
  }

  async load() {
    if (!this.workspacePath) {
      throw new Error(
        "Code: Terraform workspace is not configured. Start the MCP server with --workspace or CODE_TERRAFORM_WORKSPACE.",
      );
    }

    const rootPath = await realpath(this.workspacePath);
    const markerPath = path.join(rootPath, MARKER_NAME);
    let marker;
    try {
      marker = markerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
    } catch (error) {
      throw new Error(
        `Cannot read ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!Array.isArray(marker.documents)) {
      throw new Error(`${MARKER_NAME} has no documents array.`);
    }

    const documents = marker.documents.map((document) => {
      const documentPath = assertString(document?.path, "document path");
      const absolutePath = path.resolve(rootPath, documentPath);
      if (!inside(rootPath, absolutePath)) {
        throw new Error(`Registered document escapes the workspace: ${documentPath}`);
      }
      const id = assertString(document?.id, "document id");
      const kind = assertString(document?.kind, "document kind");
      const machines = marker.context?.machines ?? {};
      const machine =
        machines[id] ??
        Object.values(machines).find(
          (candidate) =>
            Array.isArray(candidate?.scriptSlots) && candidate.scriptSlots.includes(id),
        );
      const isPanel = Object.values(marker.context?.customPanels ?? {}).some(
        (panel) => panel?.scriptId === id,
      );
      const contractId = id.startsWith("contract_") ? id.slice("contract_".length) : null;
      const isContract =
        contractId !== null && marker.context?.contractStatus?.[contractId] !== undefined;
      return {
        id,
        path: documentPath,
        kind,
        ownerType:
          kind === "library"
            ? "library"
            : (machine?.typeId ?? (isPanel ? "panel" : isContract ? "contract" : null)),
        absolutePath,
        uri: pathToFileURL(absolutePath).href,
      };
    });

    const serverPath = path.resolve(assertString(marker.server?.path, "language server path"));
    const analysisVersion = assertString(
      marker.server?.analysisVersion ?? marker.analysisVersion,
      "analysis version",
    );
    return {
      rootPath,
      rootUri: pathToFileURL(rootPath).href,
      markerPath,
      analysisVersion,
      serverPath,
      language: typeof marker.language === "string" ? marker.language : null,
      saveId: typeof marker.saveId === "string" ? marker.saveId : null,
      documents,
    };
  }

  async resolveTarget(target: string) {
    const workspace = await this.load();
    const matches = workspace.documents.filter(
      (document) => document.id === target || document.path === target,
    );
    if (matches.length === 0) {
      throw new Error(
        `Unknown script target “${target}”. Call list_script_targets for registered IDs.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous script target “${target}”; use its registered path.`);
    }
    return { workspace, document: matches[0]! };
  }

  async verifyDocumentFile(workspace: Workspace, document: WorkspaceDocument) {
    const actualPath = await realpath(document.absolutePath);
    if (!inside(workspace.rootPath, actualPath)) {
      throw new Error(`Registered document resolves outside the workspace: ${document.path}`);
    }
    return actualPath;
  }
}

export { MARKER_NAME };

export type Workspace = Awaited<ReturnType<WorkspaceStore["load"]>>;
export type WorkspaceDocument = Workspace["documents"][number];
