import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access } from "node:fs/promises";
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
  /**
   * Runs after a successful pull --rebase, still under the lock and before the push, when the
   * caller's commit is still HEAD. `changed` lists the paths that commit changes now, relative to
   * the vault and without following renames: Git follows a rename made on another device, so the
   * change may have moved to another note. Returning false (or throwing) handles the result like a
   * conflict: the rebased commit is dropped, and the caller's version goes to a quarantine copy.
   */
  acceptRebased?: (relativePath: string, changed: string[]) => Promise<boolean>;
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

/** Paths the HEAD commit changes, renames not followed, relative to `vaultRoot`. */
async function changedByHead(vaultRoot: string): Promise<string[]> {
  const prefix = (await git(vaultRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
  const { stdout } = await git(vaultRoot, ["diff", "-z", "--name-only", "--no-renames", "HEAD~1", "HEAD"]);
  // A path outside the vault folder (when the vault is a subfolder of the repository) keeps a
  // marker, so it never equals a vault path.
  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : `(outside the vault) ${entry}`));
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
  // The caller's commit before the pull, to recognize it (and its version) after the rebase.
  let ours: string | undefined;
  try {
    await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) {
      return { synced: true };
    }
    await git(vaultRoot, ["commit", "-m", message]);
    if (options.acceptRebased) ours = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
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

  if (options.acceptRebased && ours !== undefined) {
    // The rebase went through, but Git may have carried the change somewhere else (a note moved or
    // taken over on another device). The caller decides whether this result may be pushed.
    let accepted = false;
    try {
      const head = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
      // A replayed commit keeps its author, date and message. Without one at HEAD, the rebase
      // dropped the caller's commit because the remote already had that change: nothing to check.
      const stillOurs = head === ours || (await commitStamp(vaultRoot, head)) === (await commitStamp(vaultRoot, ours));
      accepted = !stillOurs || (await options.acceptRebased(relativePath, await changedByHead(vaultRoot)));
    } catch (error) {
      logGitError("check after pull --rebase", error);
    }
    if (!accepted) {
      try {
        const ourContent = (await git(vaultRoot, ["show", `${ours}:${relativePath}`])).stdout;
        // Drop only the caller's rebased commit; everything below it stays as the pull left it.
        await git(vaultRoot, ["reset", "--hard", "HEAD~1"]);
        return await quarantineAndPush(vaultRoot, relativePath, ourContent, options);
      } catch (recoveryError) {
        logGitError("quarantine after pull --rebase", recoveryError);
        return { synced: false, conflict: true };
      }
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
