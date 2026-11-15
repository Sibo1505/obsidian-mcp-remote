import { constants } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { hasBlockedSegment, resolveInVault } from "../vault/fs.js";
import { MAX_DEPTH_BELOW_WRITE_DIR, segmentProblem } from "./names.js";

/** A request a scoped token is not allowed to make. `code` goes to the audit log, `message` to the client. */
export class ScopedDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScopedDenied";
  }
}

/** Upper limit for a note written by a scoped token (UTF-8 bytes). */
export const MAX_NOTE_BYTES = 200 * 1024;

export function checkNoteSize(text: string): void {
  if (Buffer.byteLength(text, "utf-8") > MAX_NOTE_BYTES) {
    throw new ScopedDenied("too-large", `Note larger than ${MAX_NOTE_BYTES / 1024} KB`);
  }
}

/**
 * Checks the requested path as text, before touching the disk: it must already be in normal form
 * (no "..", ".", "//" or "\"), lie below `writeDir`, and every part must follow the naming rules.
 * Returns the parts below `writeDir` (folders, then the file name).
 */
export function checkWritePath(writeDir: string, relativePath: string): string[] {
  const reject = (code: string, why: string): never => {
    throw new ScopedDenied(code, `Write rejected for ${JSON.stringify(relativePath)}: ${why}`);
  };
  if (relativePath.includes("\\") || relativePath !== path.posix.normalize(relativePath)) {
    reject("not-normalized", 'use a plain relative path with "/" (no "..", "." or "//")');
  }
  if (!relativePath.startsWith(`${writeDir}/`)) {
    reject("outside-write-dir", `this token can only write below ${writeDir}/`);
  }
  const inner = relativePath.slice(writeDir.length + 1).split("/");
  if (inner.length > MAX_DEPTH_BELOW_WRITE_DIR) {
    reject("too-deep", `at most ${MAX_DEPTH_BELOW_WRITE_DIR} levels below ${writeDir}/`);
  }
  inner.forEach((segment, index) => {
    const problem = segmentProblem(segment, index === inner.length - 1 ? "file" : "dir");
    if (problem) reject("bad-name", problem);
  });
  return inner;
}

async function lstatIfExists(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Resolves where a scoped write lands on disk and refuses anything a symlink could redirect.
 * Walks from the vault root through `writeDir` and the requested folders: no part may be a
 * symlink (or junction), missing folders are created only when `createDirs` is set. Then the
 * resolved parent must lie inside realpath(vault/writeDir), and the target itself must not be a
 * symlink, a directory or a file with other hard links.
 */
export async function resolveWriteTarget(
  vaultRoot: string,
  writeDir: string,
  inner: string[],
  options: { createDirs: boolean },
): Promise<string> {
  const vaultReal = await realpath(vaultRoot);
  const writeDirLexical = path.join(vaultReal, ...writeDir.split("/"));
  const folders = [...writeDir.split("/"), ...inner.slice(0, -1)];

  let current = vaultReal;
  for (const folder of folders) {
    const next = path.join(current, folder);
    let stat = await lstatIfExists(next);
    if (!stat) {
      if (!options.createDirs) throw new Error(`No such note: ${[writeDir, ...inner].join("/")}`);
      try {
        await mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await lstat(next);
    }
    if (stat.isSymbolicLink()) {
      throw new ScopedDenied("symlink", `Write rejected: "${folder}" on the way to the note is a symbolic link`);
    }
    if (!stat.isDirectory()) {
      throw new ScopedDenied("not-a-folder", `Write rejected: "${folder}" on the way to the note is not a folder`);
    }
    current = next;
  }

  const writeDirReal = await realpath(writeDirLexical);
  const parentReal = await realpath(current);
  if (writeDirReal !== writeDirLexical || !isInside(parentReal, writeDirReal)) {
    throw new ScopedDenied("symlink", "Write rejected: the folder resolves outside the write folder");
  }

  const target = path.join(current, inner[inner.length - 1]);
  const stat = await lstatIfExists(target);
  if (stat) {
    if (stat.isSymbolicLink()) throw new ScopedDenied("symlink", "Write rejected: the note is a symbolic link");
    if (!stat.isFile()) throw new ScopedDenied("not-a-file", "Write rejected: the target is not a file");
    if (stat.nlink > 1) throw new ScopedDenied("hard-link", "Write rejected: the note has other hard links");
  }
  return target;
}

// O_NOFOLLOW makes the final open itself refuse a symlink that appeared after the checks above
// (POSIX only; Windows has no such flag, the lstat checks still apply there).
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export async function writeFileNoFollow(target: string, content: string): Promise<void> {
  await writeFile(target, content, {
    encoding: "utf-8",
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW,
  });
}

export async function readFileNoFollow(target: string): Promise<string> {
  return readFile(target, { encoding: "utf-8", flag: constants.O_RDONLY | NO_FOLLOW });
}

const fold = (value: string) => value.normalize("NFC").toLowerCase();

/**
 * True when a vault-relative path ("/"-separated) equals a readDeny entry or lies below one.
 * Compared case-insensitively and Unicode-normalized, because the vault is also synced to
 * file systems where "Private/x.md" and "private/x.md" are the same file.
 */
export function isReadDenied(readDeny: string[], relativePath: string): boolean {
  if (readDeny.length === 0) return false;
  const candidate = fold(relativePath);
  return readDeny.some((entry) => {
    const prefix = fold(entry);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

const toPosix = (relative: string) => relative.split(path.sep).join("/");

/**
 * Throws unless a scoped token may read `relativePath`. Checks the path as given and the path it
 * really resolves to (symlinks followed): both must stay inside the vault, outside .git/.obsidian,
 * and outside every readDeny entry. A path that does not exist passes; the read then fails normally.
 */
export async function checkReadable(vaultRoot: string, readDeny: string[], relativePath: string): Promise<void> {
  const denied = () => new ScopedDenied("read-denied", `Not readable with this token: ${relativePath}`);
  const root = path.resolve(vaultRoot);
  const absolute = resolveInVault(root, relativePath);
  if (isReadDenied(readDeny, toPosix(path.relative(root, absolute)))) throw denied();

  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const vaultReal = await realpath(root);
  if (!isInside(real, vaultReal)) {
    throw new ScopedDenied("outside-vault", `Not readable with this token: ${relativePath} resolves outside the vault`);
  }
  const realRelative = toPosix(path.relative(vaultReal, real));
  if (hasBlockedSegment(realRelative.split("/")) || isReadDenied(readDeny, realRelative)) throw denied();
}
