import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseManual } from "./parser.js";

export const DEFAULT_MANUAL_PATH = path.resolve(process.cwd(), "Code-Terraform-DOCS-Manual.md");

export class ManualStore {
  #manualPath;
  #cached;
  #signature;

  constructor(manualPath = DEFAULT_MANUAL_PATH) {
    this.#manualPath = path.resolve(manualPath);
  }

  get manualPath() {
    return this.#manualPath;
  }

  async load() {
    let fileStat;
    try {
      fileStat = await stat(this.#manualPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Manual not found at ${this.#manualPath}. Place Code-Terraform-DOCS-Manual.md in the working directory, set CODE_TERRAFORM_DOCS_MANUAL, or pass --manual.`);
      }
      throw error;
    }

    if (!fileStat.isFile()) throw new Error(`Manual path is not a file: ${this.#manualPath}`);
    const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
    if (this.#cached && signature === this.#signature) return this.#cached;

    const markdown = await readFile(this.#manualPath, "utf8");
    const parsed = parseManual(markdown, this.#manualPath);
    this.#cached = {
      ...parsed,
      loadedAt: new Date().toISOString(),
      modifiedAt: fileStat.mtime.toISOString(),
      byteSize: fileStat.size
    };
    this.#signature = signature;
    return this.#cached;
  }
}
