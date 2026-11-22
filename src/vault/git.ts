import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function git(vaultRoot: string, args: string[]) {
  return execFileAsync("git", args, { cwd: vaultRoot });
}

function logGitError(step: string, error: unknown): void {
  console.error(`git ${step} failed:`, error instanceof Error ? error.message : error);
}

// Serializes every git call against VAULT_PATH within this process. This is only safe because the
// host-side cron auto-pull was removed in favor of this module owning the checkout exclusively —
// a mutex here does nothing against a second, external process also running `git pull` (see
// obsidian-mcp-remote project notes: that combination caused .git/index.lock races).
// Not reentrant: code running under the lock must call commitAndPushLocked, never commitAndPush.
let gitQueue: Promise<void> = Promise.resolve();
export function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = gitQueue.then(fn, fn);
  gitQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function hasStagedChanges(vaultRoot: string): Promise<boolean> {
  try {
    await git(vaultRoot, ["diff", "--cached", "--quiet", "--exit-code"]);
    return false;
  } catch {
    return true;
  }
}

async function currentBranch(vaultRoot: string): Promise<string> {
  const { stdout } = await git(vaultRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

/**
 * `git pull --rebase` fails for two very different reasons: a real same-file content conflict
 * (git pauses mid-rebase, leaving one of these marker directories behind), or a fetch-level
 * failure (network down, TLS/auth broken) that never got as far as starting a rebase at all. Only
 * the first case has anything to abort or quarantine.
 */
async function isRebaseInProgress(vaultRoot: string): Promise<boolean> {
  for (const marker of ["rebase-apply", "rebase-merge"]) {
    try {
      await access(path.join(vaultRoot, ".git", marker));
      return true;
    } catch {
      // marker absent, keep checking the other one
    }
  }
  return false;
}

/**
 * Best-effort freshness pull before a read. Never throws — a stale-but-working read beats a
 * broken one. Uses `--rebase` explicitly rather than plain `pull`: this repo has no configured
 * merge/rebase default, and git refuses to guess ("Need to specify how to reconcile divergent
 * branches") the moment origin has diverged at all. The working tree is always clean at this
 * point (reads never write), so there's nothing to autostash. If a stray rebase is somehow left
 * in progress (e.g. a previous write's own rebase got interrupted), aborts it rather than leaving
 * every subsequent git call blocked on it — reads have nothing of their own to quarantine.
 */
export async function pullBestEffort(vaultRoot: string): Promise<void> {
  await withGitLock(async () => {
    try {
      await git(vaultRoot, ["pull", "--rebase"]);
    } catch (error) {
      logGitError("pull --rebase (best-effort)", error);
      if (await isRebaseInProgress(vaultRoot)) {
        try {
          await git(vaultRoot, ["rebase", "--abort"]);
        } catch (abortError) {
          logGitError("rebase --abort (best-effort)", abortError);
        }
      }
    }
  });
}

/**
 * Saves the file's current (our-version) content under a sibling `*.claude-conflict.<ts>.md` path
 * so a rebase conflict never loses the write that triggered it, then resets the real path back to
 * origin's version. Keeping the branch clean (matching origin) is what stops one conflict from
 * blocking every subsequent write — the alternative (leaving the diverged commit in place) would
 * make the next rebase fail the same way, forever.
 */
async function quarantineConflict(vaultRoot: string, relativePath: string, ourContent: string): Promise<string> {
  const ext = path.extname(relativePath);
  const base = relativePath.slice(0, relativePath.length - ext.length);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const conflictRelative = `${base}.claude-conflict.${timestamp}${ext}`;
  await writeFile(path.join(vaultRoot, conflictRelative), ourContent, "utf-8");
  return conflictRelative;
}

export interface SyncResult {
  synced: boolean;
  conflict?: boolean;
  conflictPath?: string;
  /** false: the change was not kept (commitAndPushChecked drops what it cannot push right away). */
  saved?: false;
}

/**
 * Commits + pushes a file already written to disk at `relativePath`. Never throws: the file write
 * itself already succeeded by the time this runs, so any git failure degrades to
 * `{ synced: false }` (or `{ synced: false, conflict: true, conflictPath }` on a real content
 * conflict) instead of reporting the whole tool call as failed.
 */
export interface CommitOptions {
  /**
   * Writes the quarantined copy of a conflicting note and returns its vault-relative path.
   * Default: `<name>.claude-conflict.<timestamp>.md` next to the note, plain writeFile.
   */
  quarantine?: (relativePath: string, ourContent: string) => Promise<string>;
  /** Message of the quarantine commit. Default: `conflict: quarantined <path>`. */
  conflictMessage?: (relativePath: string, conflictPath: string) => string;
}

export interface CheckedCommitOptions extends CommitOptions {
  quarantine: (relativePath: string, ourContent: string) => Promise<string>;
  /**
   * Runs after a successful pull --rebase, still under the lock and before the push, when the
   * caller's commit is still HEAD and changes the same paths as before the rebase. `changed` lists
   * them, relative to the vault and without following renames. Returning false (or throwing)
   * handles the result like a conflict: the commit is dropped, its version goes to a copy.
   */
  acceptRebased: (relativePath: string, changed: string[]) => Promise<boolean>;
}

/**
 * Writes the quarantine copy of `ourContent`, commits it alone and pushes: the end of every
 * conflict, with the branch already back on a state that does not contain the caller's commit.
 */
async function quarantineAndPush(
  vaultRoot: string,
  relativePath: string,
  ourContent: string,
  options: CommitOptions,
): Promise<SyncResult> {
  const conflictPath = options.quarantine
    ? await options.quarantine(relativePath, ourContent)
    : await quarantineConflict(vaultRoot, relativePath, ourContent);
  await git(vaultRoot, ["add", "--", conflictPath]);
  const conflictMessage = options.conflictMessage?.(relativePath, conflictPath) ?? `conflict: quarantined ${relativePath}`;
  await git(vaultRoot, ["commit", "-m", conflictMessage]);
  await git(vaultRoot, ["push"]);
  return { synced: false, conflict: true, conflictPath };
}

const commitStamp = async (vaultRoot: string, rev: string) =>
  (await git(vaultRoot, ["log", "-1", "--format=%at%x00%ae%x00%B", rev])).stdout;

const succeeds = (vaultRoot: string, args: string[]) => git(vaultRoot, args).then(() => true, () => false);

/** Paths a commit changes (`from`..`to`), renames not followed, relative to the repository root. */
async function changedPaths(vaultRoot: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await git(vaultRoot, ["diff", "-z", "--name-only", "--no-renames", from, to]);
  return stdout.split("\0").filter((entry) => entry !== "");
}

/** The blob Git would store for a file in the working tree; undefined when there is no file. */
async function blobOf(vaultRoot: string, file: string): Promise<string | undefined> {
  try {
    // Relative to the vault folder: shorter than the absolute path (Windows limits path length).
    return (await git(vaultRoot, ["hash-object", "--", path.relative(vaultRoot, file)])).stdout.trim();
  } catch {
    return undefined;
  }
}

/** True while HEAD is the commit `ours`, also after a rebase (same author, date and message). */
async function headIs(vaultRoot: string, ours: string): Promise<boolean> {
  const head = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return head === ours || (await commitStamp(vaultRoot, head)) === (await commitStamp(vaultRoot, ours));
}

/**
 * Puts one path (relative to the repository root) back to HEAD: in the index always, in the
 * working tree only while the file still holds `wrote`, so a later change of another writer stays.
 */
async function restorePath(vaultRoot: string, top: string, rootPath: string, wrote: string | undefined): Promise<void> {
  const spec = `:(top,literal)${rootPath}`;
  const file = path.join(top, rootPath);
  const unchanged = wrote !== undefined && (await blobOf(vaultRoot, file)) === wrote;
  const inHead = await succeeds(vaultRoot, ["cat-file", "-e", `HEAD:${rootPath}`]);
  if (inHead) {
    await git(vaultRoot, ["restore", "--source=HEAD", "--staged", ...(unchanged ? ["--worktree"] : []), "--", spec]);
    return;
  }
  // Not in HEAD: the write created the file. Unstage it, and remove it while it is unchanged.
  await git(vaultRoot, ["rm", "--cached", "-q", "--ignore-unmatch", "--", spec]);
  if (unchanged) await unlink(file);
}

/**
 * Drops the commit `ours` while it is HEAD and puts back what it changed (see restorePath).
 * Nothing else changes: commits below it, other index entries and other files stay. Returns false,
 * dropping nothing, when HEAD is another commit.
 */
async function dropCommit(vaultRoot: string, top: string, ours: string): Promise<boolean> {
  if (!(await headIs(vaultRoot, ours))) return false;
  const changed = await changedPaths(vaultRoot, "HEAD~1", "HEAD");
  const wrote = new Map<string, string | undefined>();
  for (const rootPath of changed) {
    wrote.set(rootPath, await git(vaultRoot, ["rev-parse", `HEAD:${rootPath}`]).then((r) => r.stdout.trim(), () => undefined));
  }
  // First move HEAD off the commit, so a failure below can never leave it there to be pushed.
  await git(vaultRoot, ["reset", "--soft", "HEAD~1"]);
  for (const rootPath of changed) await restorePath(vaultRoot, top, rootPath, wrote.get(rootPath));
  return true;
}

/**
 * Why a checked write cannot start now (undefined when it can): another writer's change is
 * waiting in the index or working tree, or the path itself holds a file Git does not track (or
 * ignores). The write would otherwise commit, or later drop, what is not its own. Outside a Git
 * repository there is nothing to protect.
 */
export async function uncommittedChanges(
  vaultRoot: string,
  relativePath: string,
): Promise<"other-changes" | "untracked-path" | undefined> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "--is-inside-work-tree"]))) return undefined;
  const tracked = (await git(vaultRoot, ["status", "--porcelain", "-z", "--untracked-files=no"])).stdout;
  if (tracked !== "") return "other-changes";
  const here = (await git(vaultRoot, ["status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--", relativePath])).stdout;
  return here === "" ? undefined : "untracked-path";
}

export async function commitAndPush(
  vaultRoot: string,
  relativePath: string,
  message: string,
  options: CommitOptions = {},
): Promise<SyncResult> {
  return withGitLock(() => commitAndPushLocked(vaultRoot, relativePath, message, options));
}

/**
 * commitAndPush for a caller that already holds the git lock (withGitLock), so that its own checks
 * and the file write happen under the same lock as the commit: no pull can land in between.
 */
export async function commitAndPushLocked(
  vaultRoot: string,
  relativePath: string,
  message: string,
  options: CommitOptions = {},
): Promise<SyncResult> {
  try {
    await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) {
      return { synced: true };
    }
    await git(vaultRoot, ["commit", "-m", message]);
  } catch (error) {
    logGitError("add/commit", error);
    return { synced: false };
  }

  try {
    await git(vaultRoot, ["pull", "--rebase"]);
  } catch (error) {
    logGitError("pull --rebase", error);

    if (!(await isRebaseInProgress(vaultRoot))) {
      // Failed before a rebase ever started (network/TLS/auth) - nothing to abort or
      // quarantine. Our commit is safe on disk, just not pushed yet; the next write's own
      // pull --rebase step will retry.
      return { synced: false };
    }

    try {
      await git(vaultRoot, ["rebase", "--abort"]);
      const ourContent = await readFile(path.join(vaultRoot, relativePath), "utf-8");
      const branch = await currentBranch(vaultRoot);
      await git(vaultRoot, ["reset", "--hard", `origin/${branch}`]);
      return await quarantineAndPush(vaultRoot, relativePath, ourContent, options);
    } catch (recoveryError) {
      logGitError("conflict recovery", recoveryError);
      return { synced: false, conflict: true };
    }
  }

  try {
    await git(vaultRoot, ["push"]);
  } catch (error) {
    logGitError("push", error);
    return { synced: false };
  }

  return { synced: true };
}

const NOT_SAVED: SyncResult = { synced: false, saved: false };

/**
 * The commit of a scoped write. The caller holds the git lock, has just written `relativePath` and
 * has made sure nothing else is uncommitted (uncommittedChanges). The change goes out right away,
 * checked against the state it goes out with, or it is not kept at all:
 * - the commit holds only `relativePath`;
 * - after the pull --rebase it must change the same paths as before (Git follows a rename made on
 *   another device, also into a denied folder) and `acceptRebased` must agree; otherwise the commit
 *   is dropped and its version goes to a quarantine copy, which goes out the same way;
 * - when a commit, the pull or the push fails, the change is dropped and the result says
 *   `saved: false`. A token's commit never waits on the server for a later push, which would send
 *   it out unchecked.
 * Dropping touches only what this write changed (dropCommit): older commits of other writers,
 * their index entries and their files stay. Outside a Git repository, as before: `synced: false`.
 */
export async function commitAndPushChecked(
  vaultRoot: string,
  relativePath: string,
  message: string,
  options: CheckedCommitOptions,
): Promise<SyncResult> {
  let top: string;
  let prefix: string;
  try {
    top = (await git(vaultRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    prefix = (await git(vaultRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
  } catch (error) {
    logGitError("rev-parse", error);
    return { synced: false };
  }
  const rootPath = `${prefix}${relativePath}`;
  const wrote = await blobOf(vaultRoot, path.join(top, rootPath));

  let ours: string | undefined;
  const dropOurs = async () => {
    try {
      // Not committed: put back only what is still uncommitted of this write. Committed: drop the
      // commit while it is HEAD (after a rebase that dropped it, there is nothing left to drop).
      if (ours === undefined) await restorePath(vaultRoot, top, rootPath, wrote);
      else await dropCommit(vaultRoot, top, ours);
    } catch (error) {
      logGitError("drop the scoped change", error);
    }
  };

  try {
    await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) return { synced: true };
    await git(vaultRoot, ["commit", "-m", message, "--", relativePath]);
    ours = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
  } catch (error) {
    logGitError("add/commit", error);
    await dropOurs();
    return NOT_SAVED;
  }

  /** The version goes to a copy next to the note: dropped from HEAD first, also without it. */
  const toCopy = async (rebaseOthersFirst: boolean): Promise<SyncResult> => {
    let ourContent: string | undefined;
    try {
      // cat-file, not show: show first tries the argument as a file name, which fails for a long path
      // on Windows. "./" makes the path relative to the vault folder, not to the repository root.
      ourContent = (await git(vaultRoot, ["cat-file", "blob", `${ours}:./${relativePath}`])).stdout;
    } catch (error) {
      logGitError("show the scoped version", error);
    }
    await dropOurs();
    if (ourContent === undefined) return { synced: false, conflict: true, saved: false };
    if (rebaseOthersFirst) {
      // The branch is still on the old remote state: bring the older commits (of other writers)
      // onto the new one, so the copy can go out on top.
      try {
        await git(vaultRoot, ["pull", "--rebase"]);
      } catch (error) {
        logGitError("pull --rebase before the copy", error);
        if (await isRebaseInProgress(vaultRoot)) await git(vaultRoot, ["rebase", "--abort"]).catch(() => undefined);
        return { synced: false, conflict: true, saved: false };
      }
    }
    let conflictPath: string | undefined;
    let copy: string | undefined;
    let copyWrote: string | undefined;
    try {
      conflictPath = await options.quarantine(relativePath, ourContent);
      copyWrote = await blobOf(vaultRoot, path.join(top, prefix + conflictPath));
      await git(vaultRoot, ["add", "--", conflictPath]);
      const conflictMessage = options.conflictMessage?.(relativePath, conflictPath) ?? `conflict: quarantined ${relativePath}`;
      await git(vaultRoot, ["commit", "-m", conflictMessage, "--", conflictPath]);
      copy = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
      await git(vaultRoot, ["push"]);
      return { synced: false, conflict: true, conflictPath };
    } catch (error) {
      logGitError("quarantine copy", error);
      try {
        if (copy !== undefined) await dropCommit(vaultRoot, top, copy);
        else if (conflictPath !== undefined) await restorePath(vaultRoot, top, prefix + conflictPath, copyWrote);
      } catch (dropError) {
        logGitError("drop the quarantine copy", dropError);
      }
      return { synced: false, conflict: true, saved: false };
    }
  };

  try {
    await git(vaultRoot, ["pull", "--rebase"]);
  } catch (error) {
    logGitError("pull --rebase", error);
    if (!(await isRebaseInProgress(vaultRoot))) {
      // The remote cannot be reached (or refused): the change does not wait here for a later push.
      await dropOurs();
      return NOT_SAVED;
    }
    try {
      await git(vaultRoot, ["rebase", "--abort"]);
    } catch (abortError) {
      logGitError("rebase --abort", abortError);
      return { synced: false, conflict: true, saved: false };
    }
    return toCopy(true);
  }

  // The rebase went through, but Git may have carried the change somewhere else.
  let accepted = false;
  try {
    if (!(await headIs(vaultRoot, ours))) {
      // The rebase dropped the commit because the remote already had that change: nothing of
      // this write is left to check.
      accepted = true;
    } else {
      const before = await changedPaths(vaultRoot, `${ours}~1`, ours);
      const after = await changedPaths(vaultRoot, "HEAD~1", "HEAD");
      const same = before.length === after.length && before.every((entry) => after.includes(entry));
      const vaultRelative = after.map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : `(outside the vault) ${entry}`));
      accepted = same && (await options.acceptRebased(relativePath, vaultRelative));
    }
  } catch (error) {
    logGitError("check after pull --rebase", error);
  }
  if (!accepted) return toCopy(false);

  try {
    await git(vaultRoot, ["push"]);
  } catch (error) {
    logGitError("push", error);
    await dropOurs();
    return NOT_SAVED;
  }
  return { synced: true };
}
