import { constants } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { hasBlockedSegment, resolveInVault } from "../vault/fs.js";
import {
  MAX_DEPTH_BELOW_WRITE_DIR,
  MAX_DEPTH_WHOLE_VAULT,
  MAX_NEW_FOLDERS,
  MAX_WRITE_PATH_LENGTH,
  pathSegmentProblem,
  segmentProblem,
} from "./names.js";

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
 * Checks the requested path as text, before touching the disk: at most `maxLength` characters in
 * total (existing folders count too), already in normal form (no "..", ".", "//" or "\"), below
 * `writeDir` (anywhere when `writeDir` is "", the whole vault), out of `writeDeny`, and every part
 * must follow `pathSegmentProblem`. Names that do not exist yet get the stricter `segmentProblem`
 * in `resolveWriteTarget`, which knows what exists. Returns the parts below `writeDir` (folders,
 * then the file name).
 */
export function checkWritePath(
  writeDir: string,
  writeDeny: string[],
  relativePath: string,
  maxLength = MAX_WRITE_PATH_LENGTH,
): string[] {
  const reject = (code: string, why: string): never => {
    throw new ScopedDenied(code, `Write rejected for ${JSON.stringify(relativePath)}: ${why}`);
  };
  if (relativePath.length > maxLength) reject("too-long", `at most ${maxLength} characters in total`);
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath !== path.posix.normalize(relativePath)
  ) {
    reject("not-normalized", 'use a plain relative path with "/" (no "..", "." or "//")');
  }
  let inner: string[];
  if (writeDir === "") {
    inner = relativePath.split("/");
    if (inner.length > MAX_DEPTH_WHOLE_VAULT) reject("too-deep", `at most ${MAX_DEPTH_WHOLE_VAULT} path parts`);
  } else {
    if (!relativePath.startsWith(`${writeDir}/`)) {
      reject("outside-write-dir", `this token can only write below ${writeDir}/`);
    }
    inner = relativePath.slice(writeDir.length + 1).split("/");
    if (inner.length > MAX_DEPTH_BELOW_WRITE_DIR) {
      reject("too-deep", `at most ${MAX_DEPTH_BELOW_WRITE_DIR} levels below ${writeDir}/`);
    }
  }
  inner.forEach((segment, index) => {
    const problem = pathSegmentProblem(segment, index === inner.length - 1 ? "file" : "dir");
    if (problem) reject("bad-name", problem);
  });
  if (isReadDenied(writeDeny, relativePath)) {
    reject("write-denied", "this path is not writable with this token");
  }
  return inner;
}

/**
 * Another entry in `parentDir` whose name differs from `name` only in case or Unicode form. On the
 * case-insensitive file systems the vault syncs to (Windows, macOS) both would be the same file.
 */
async function caseTwin(parentDir: string, name: string): Promise<string | undefined> {
  const wanted = fold(name);
  const entries = await readdir(parentDir);
  return entries.find((entry) => entry !== name && fold(entry) === wanted);
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
 * symlink (or junction). Before anything is created, every folder and the note that do not exist
 * yet must pass the strict naming rules (`segmentProblem`) and must not have a twin that differs
 * only in case; missing folders are then created only when `createDirs` is set. Finally the
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
  const writeDirParts = writeDir === "" ? [] : writeDir.split("/");
  const writeDirLexical = path.join(vaultReal, ...writeDirParts);
  const folders = [...writeDirParts, ...inner.slice(0, -1)];
  const fileName = inner[inner.length - 1];
  const notePath = [...writeDirParts, ...inner].join("/");
  const strictName = (name: string, kind: "dir" | "file") => {
    const problem = segmentProblem(name, kind);
    if (problem) throw new ScopedDenied("bad-name", `Write rejected for ${JSON.stringify(notePath)}: new ${problem}`);
  };
  const noTwin = async (parentDir: string, name: string) => {
    const twin = await caseTwin(parentDir, name);
    if (twin !== undefined) {
      throw new ScopedDenied(
        "case-twin",
        `Write rejected for ${JSON.stringify(notePath)}: "${twin}" already exists and differs only in case`,
      );
    }
  };
  const checkFolder = (folder: string, stat: Stats) => {
    if (stat.isSymbolicLink()) {
      throw new ScopedDenied("symlink", `Write rejected: "${folder}" on the way to the note is a symbolic link`);
    }
    if (!stat.isDirectory()) {
      throw new ScopedDenied("not-a-folder", `Write rejected: "${folder}" on the way to the note is not a folder`);
    }
  };

  // First pass, read only: how far does the path exist, and is everything we would create allowed?
  let current = vaultReal;
  let existing = 0;
  for (const folder of folders) {
    const next = path.join(current, folder);
    const stat = await lstatIfExists(next);
    if (!stat) break;
    checkFolder(folder, stat);
    current = next;
    existing += 1;
  }
  const missing = folders.slice(existing);
  if (missing.length > 0) {
    if (!options.createDirs) throw new Error(`No such note: ${notePath}`);
    if (writeDir === "" && missing.length > MAX_NEW_FOLDERS) {
      throw new ScopedDenied(
        "too-deep",
        `Write rejected for ${JSON.stringify(notePath)}: at most ${MAX_NEW_FOLDERS} new folders per write`,
      );
    }
    // Everything from the first missing folder on is new. Only that first folder has existing
    // siblings to collide with; below it there is nothing yet.
    missing.forEach((folder) => strictName(folder, "dir"));
    strictName(fileName, "file");
    await noTwin(current, missing[0]);
  } else if (!(await lstatIfExists(path.join(current, fileName)))) {
    strictName(fileName, "file");
    await noTwin(current, fileName);
  }

  // Second pass: create what is missing, re-checking every part in case something changed meanwhile.
  for (const folder of missing) {
    const next = path.join(current, folder);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    checkFolder(folder, await lstat(next));
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
 * True when a vault-relative path ("/"-separated) is covered by an entry of a deny list (readDeny
 * or writeDeny): it equals the entry or lies below it, and the same for the entry's namesake. In a
 * vault a note "x.md" and a folder "x/" belong together (a hub and its parts), so an entry "x.md"
 * also covers "x/" and everything below, and an entry "x" also covers "x.md". Compared
 * case-insensitively and Unicode-normalized, because the vault is also synced to file systems
 * where "Private/x.md" and "private/x.md" are the same file.
 */
export function isReadDenied(denyList: string[], relativePath: string): boolean {
  if (denyList.length === 0) return false;
  const candidate = fold(relativePath);
  const covers = (prefix: string) => candidate === prefix || candidate.startsWith(`${prefix}/`);
  return denyList.some((entry) => {
    const folded = fold(entry);
    const stem = folded.endsWith(".md") ? folded.slice(0, -".md".length) : folded;
    return covers(folded) || covers(stem) || covers(`${stem}.md`);
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
