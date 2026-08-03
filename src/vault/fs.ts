import { promises as fs } from "node:fs";
import path from "node:path";

export class VaultPathError extends Error {
  constructor(relativePath: string) {
    super(`Path escapes vault root: ${relativePath}`);
    this.name = "VaultPathError";
  }
}

/**
 * Resolves a vault-relative path against vaultRoot and rejects anything
 * that would escape it (../, absolute paths, symlink-free traversal tricks).
 */
export function resolveInVault(vaultRoot: string, relativePath: string): string {
  const root = path.resolve(vaultRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new VaultPathError(relativePath);
  }
  return resolved;
}

export async function readNote(vaultRoot: string, relativePath: string): Promise<string> {
  const absolute = resolveInVault(vaultRoot, relativePath);
  return fs.readFile(absolute, "utf-8");
}

export async function writeNote(vaultRoot: string, relativePath: string, content: string): Promise<void> {
  const absolute = resolveInVault(vaultRoot, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf-8");
}

export interface VaultEntry {
  name: string;
  isDirectory: boolean;
}

export async function listDir(vaultRoot: string, relativePath = ""): Promise<VaultEntry[]> {
  const absolute = resolveInVault(vaultRoot, relativePath);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function statNote(vaultRoot: string, relativePath: string) {
  const absolute = resolveInVault(vaultRoot, relativePath);
  const stat = await fs.stat(absolute);
  return { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
}
