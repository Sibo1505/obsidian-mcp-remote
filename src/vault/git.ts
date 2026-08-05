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
let gitQueue: Promise<void> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
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
export async function commitAndPush(vaultRoot: string, relativePath: string, message: string): Promise<SyncResult> {
  return withGitLock(async () => {
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
        const conflictPath = await quarantineConflict(vaultRoot, relativePath, ourContent);
        await git(vaultRoot, ["add", "--", conflictPath]);
        await git(vaultRoot, ["commit", "-m", `conflict: quarantined ${relativePath}`]);
        await git(vaultRoot, ["push"]);
        return { synced: false, conflict: true, conflictPath };
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
  });
}
