import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, unlink, rm } from "node:fs/promises";
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
    // A no-op unless a scoped change could not be undone earlier: then try again now.
    await releaseHeldBack(vaultRoot);
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
  /** Why it was not kept: its commit failed, or the pull or push did. */
  reason?: "commit" | "sync";
  /** The change could not be undone either; it stays on the server and nothing goes out (releaseHeldBack). */
  heldBack?: true;
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
  /** The token's name, written into every commit of it as the trailer `Scoped-Token: <name>`. */
  scopedToken: string;
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
  if (!(await pushAllowed(vaultRoot))) throw new Error("a held-back scoped commit is on the branch");
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
 * Why a checked write cannot start now (undefined when it can): another writer's change is
 * waiting in the index or working tree, or the path itself holds a file Git does not track (or
 * ignores). The write would otherwise commit, or later drop, what is not its own. Outside a Git
 * repository there is nothing to protect.
 */
export async function uncommittedChanges(
  vaultRoot: string,
  relativePath: string,
): Promise<
  | { reason: "other-changes"; count: number; first: string }
  | { reason: "untracked-path" }
  | { reason: "ignored-path" }
  | undefined
> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "--is-inside-work-tree"]))) return undefined;
  const tracked = (await git(vaultRoot, ["status", "--porcelain", "-z", "--untracked-files=no"])).stdout;
  if (tracked !== "") {
    // Entries are "XY path"; a rename or copy adds its old path as an extra entry.
    const entries = tracked.split("\0").filter((entry) => /^.. ./.test(entry));
    return { reason: "other-changes", count: entries.length, first: entries[0]?.slice(3) ?? "" };
  }
  const here = (await git(vaultRoot, ["status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--", relativePath])).stdout;
  if (here !== "") return { reason: "untracked-path" };
  // An ignored path (no file yet): Git would refuse to add it, so the write could never be kept.
  if (await succeeds(vaultRoot, ["check-ignore", "-q", "--", relativePath])) return { reason: "ignored-path" };
  return undefined;
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
    // Only in an error state: a scoped change the server could not undo must not go into this
    // commit (it takes the whole index) or out with this push. The file stays staged for later.
    if (!(await releaseHeldBack(vaultRoot))) return { synced: false };
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

  if (!(await pushAllowed(vaultRoot))) return { synced: false };
  try {
    await git(vaultRoot, ["push"]);
  } catch (error) {
    logGitError("push", error);
    return { synced: false };
  }

  return { synced: true };
}

const NOT_SAVED_SYNC: SyncResult = { synced: false, saved: false, reason: "sync" };

/** Marks a commit as a scoped token's, in Git itself, so it is recognized after a restart too. */
const SCOPED_TRAILER = "Scoped-Token";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Logs a scoped change the server could not undo. Nothing goes out while it is there. */
function logHeldBack(what: string): void {
  console.error(
    `scoped change held back: ${what}. The server sends nothing out until it is gone: ` +
      "it retries on the next write or read; or remove it by hand (git status, git log @{upstream}..HEAD)",
  );
}

async function gitDirOf(vaultRoot: string): Promise<string> {
  return (await git(vaultRoot, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
}

/** Like isRebaseInProgress, but also for a vault in a subfolder of the repository. */
async function rebaseInProgressAt(gitDir: string): Promise<boolean> {
  for (const marker of ["rebase-apply", "rebase-merge"]) {
    try {
      await access(path.join(gitDir, marker));
      return true;
    } catch {
      // not there
    }
  }
  return false;
}

/**
 * What a scoped write has staged and not yet sent out or undone: path (relative to the repository
 * root) and the blob it wrote. Kept in a file in the Git folder, so a later write, or the server
 * after a restart, can still undo it.
 */
interface PendingWrite {
  rootPath: string;
  wrote: string | null;
}

const pendingFile = (gitDir: string) => path.join(gitDir, "scoped-pending.json");

async function readPending(gitDir: string): Promise<PendingWrite | undefined> {
  try {
    return JSON.parse(await readFile(pendingFile(gitDir), "utf-8")) as PendingWrite;
  } catch {
    return undefined;
  }
}

/** The blob the index holds for a path (relative to the repository root), if any. */
async function indexBlob(vaultRoot: string, rootPath: string): Promise<string | undefined> {
  const { stdout } = await git(vaultRoot, ["ls-files", "-s", "--", `:(top,literal)${rootPath}`]);
  return stdout.split(/\s+/)[1] || undefined;
}

async function headBlob(vaultRoot: string, rootPath: string): Promise<string | undefined> {
  return git(vaultRoot, ["rev-parse", "-q", "--verify", `HEAD:${rootPath}`]).then((r) => r.stdout.trim() || undefined, () => undefined);
}

/**
 * Puts one path (relative to the repository root) back to HEAD, but only as far as it still holds
 * what this write wrote (`wrote`): the index entry while it is that blob, the file while it is.
 * A change of another writer to the same path stays.
 */
async function restorePath(vaultRoot: string, top: string, rootPath: string, wrote: string | undefined): Promise<void> {
  if (wrote === undefined) return;
  const spec = `:(top,literal)${rootPath}`;
  const file = path.join(top, rootPath);
  const indexOurs = (await indexBlob(vaultRoot, rootPath)) === wrote;
  const unchanged = (await blobOf(vaultRoot, file)) === wrote;
  const inHead = (await headBlob(vaultRoot, rootPath)) !== undefined;
  if (inHead) {
    const what = [...(indexOurs ? ["--staged"] : []), ...(unchanged ? ["--worktree"] : [])];
    if (what.length > 0) await git(vaultRoot, ["restore", "--source=HEAD", ...what, "--", spec]);
    return;
  }
  // Not in HEAD: the write created the file. Unstage it, and remove it while it is unchanged.
  if (indexOurs) await git(vaultRoot, ["rm", "--cached", "-q", "--ignore-unmatch", "--", spec]);
  if (unchanged) await unlink(file);
}

/** True while the index still holds this write's version of the path, different from HEAD. */
async function stillStaged(vaultRoot: string, rootPath: string, wrote: string | undefined): Promise<boolean> {
  if (wrote === undefined) return false;
  return (await indexBlob(vaultRoot, rootPath)) === wrote && (await headBlob(vaultRoot, rootPath)) !== wrote;
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
  for (const rootPath of changed) wrote.set(rootPath, await headBlob(vaultRoot, rootPath));
  // First move HEAD off the commit, so a failure below can never leave it there to be pushed.
  await git(vaultRoot, ["reset", "--soft", "HEAD~1"]);
  for (const rootPath of changed) await restorePath(vaultRoot, top, rootPath, wrote.get(rootPath));
  return true;
}

/** Scoped commits on the branch that the remote does not have, newest first (none without one). */
async function heldScopedCommits(vaultRoot: string): Promise<string[]> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "-q", "--verify", "@{upstream}"]))) return [];
  const { stdout } = await git(vaultRoot, ["log", "--format=%H", `--grep=^${SCOPED_TRAILER}: `, "@{upstream}..HEAD"]);
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * Clears what a scoped write left behind because undoing it failed earlier (or the server stopped
 * in the middle): a rebase left half-way, scoped commits the remote does not have (dropped while
 * they are HEAD), and what a scoped write still has staged (see PendingWrite). True when nothing of
 * the kind is left, so a commit or push cannot take it along. Never throws; outside a Git
 * repository there is nothing to clear.
 */
export async function releaseHeldBack(vaultRoot: string): Promise<boolean> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "--is-inside-work-tree"]))) return true;
  try {
    const gitDir = await gitDirOf(vaultRoot);
    const top = (await git(vaultRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (await rebaseInProgressAt(gitDir)) await git(vaultRoot, ["rebase", "--abort"]);
    for (const commit of await heldScopedCommits(vaultRoot)) {
      // Newest first: each one is HEAD in turn, or it cannot be dropped without touching others.
      if (!(await dropCommit(vaultRoot, top, commit))) {
        logHeldBack(`scoped commit ${commit} is not on top of the branch and cannot be dropped automatically`);
        return false;
      }
    }
    if ((await heldScopedCommits(vaultRoot)).length > 0) return false;
    const pending = await readPending(gitDir);
    if (pending !== undefined) {
      const wrote = pending.wrote ?? undefined;
      await restorePath(vaultRoot, top, pending.rootPath, wrote);
      if (await stillStaged(vaultRoot, pending.rootPath, wrote)) {
        logHeldBack(`the staged scoped change of ${pending.rootPath} (${pending.wrote})`);
        return false;
      }
      await rm(pendingFile(gitDir), { force: true });
    }
    return true;
  } catch (error) {
    logGitError("release a held-back scoped change", error);
    return false;
  }
}

/**
 * Refuses a push while a scoped commit other than `except` is on the branch and not on the remote.
 * `except` is recognized like headIs does, so also after a rebase gave it a new hash.
 */
async function pushAllowed(vaultRoot: string, except?: string): Promise<boolean> {
  try {
    const exceptStamp = except === undefined ? undefined : await commitStamp(vaultRoot, except);
    const held: string[] = [];
    for (const commit of await heldScopedCommits(vaultRoot)) {
      if (commit !== except && (await commitStamp(vaultRoot, commit)) !== exceptStamp) held.push(commit);
    }
    if (held.length === 0) return true;
    logHeldBack(`scoped commit ${held[0]} is still on the branch, so nothing is pushed`);
    return false;
  } catch (error) {
    logGitError("check for held-back scoped commits", error);
    return false;
  }
}

/**
 * The commit of a scoped write. The caller holds the git lock, has called releaseHeldBack, has just
 * written `relativePath` and has made sure nothing else is uncommitted (uncommittedChanges). The
 * change goes out right away, checked against the state it goes out with, or it is not kept:
 * - the commit holds only `relativePath` and carries the trailer `Scoped-Token: <name>`;
 * - after the pull --rebase it must change the same paths as before (Git follows a rename made on
 *   another device, also into a denied folder) and `acceptRebased` must agree; otherwise the commit
 *   is dropped and its version goes to a quarantine copy, which goes out the same way;
 * - when a commit, the pull or the push fails, the change is dropped and the result says
 *   `saved: false`.
 * Dropping touches only what this write changed (dropCommit, restorePath) and is checked
 * afterwards, with a few short retries (a ref lock of another Git process is short). If it still
 * fails, the change is held back: nothing more happens (no copy, no push), the result says
 * `heldBack: true`, one log line names it, and every later commit or push first clears it
 * (releaseHeldBack) or does not happen. Outside a Git repository, as before: `synced: false`.
 */
export async function commitAndPushChecked(
  vaultRoot: string,
  relativePath: string,
  message: string,
  options: CheckedCommitOptions,
): Promise<SyncResult> {
  let top: string;
  let prefix: string;
  let gitDir: string;
  try {
    top = (await git(vaultRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    prefix = (await git(vaultRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
    gitDir = await gitDirOf(vaultRoot);
  } catch (error) {
    logGitError("rev-parse", error);
    return { synced: false };
  }
  const trailer = `\n\n${SCOPED_TRAILER}: ${options.scopedToken}`;
  const base = await git(vaultRoot, ["rev-parse", "-q", "--verify", "HEAD"]).then((r) => r.stdout.trim(), () => "");

  /** One change of this call: a commit (once made) or what it staged at `rootPath`. */
  interface Change {
    rootPath: string;
    wrote: string | undefined;
    commit?: string;
  }
  const remember = async (change: Change) => {
    const entry: PendingWrite = { rootPath: change.rootPath, wrote: change.wrote ?? null };
    await writeFile(pendingFile(gitDir), JSON.stringify(entry), "utf-8");
  };
  const forget = () => rm(pendingFile(gitDir), { force: true });

  /** Makes the commit of `change` (only its path) and notes its hash. */
  const commitChange = async (change: Change, vaultPath: string, text: string, parent: string) => {
    await git(vaultRoot, ["commit", "-m", text + trailer, "--", vaultPath]);
    const head = await git(vaultRoot, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => undefined);
    if (head !== undefined) change.commit = head;
    else change.commit = await recognize(parent);
  };
  /** After a failed rev-parse: HEAD is this call's commit when it sits right on `parent`. */
  const recognize = async (parent: string): Promise<string | undefined> => {
    try {
      const head = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const below = (await git(vaultRoot, ["rev-parse", "-q", "--verify", "HEAD~1"])).stdout.trim();
      return head !== parent && below === parent ? head : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Undoes `change` and checks that nothing of it is left: its commit is no longer HEAD, and the
   * index no longer holds its version. A few short retries; false when it stays.
   */
  const undo = async (change: Change, parent: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(200);
      try {
        if (change.commit === undefined) change.commit = await recognize(parent);
        if (change.commit !== undefined) await dropCommit(vaultRoot, top, change.commit);
        else await restorePath(vaultRoot, top, change.rootPath, change.wrote);
        const commitLeft = change.commit !== undefined && (await headIs(vaultRoot, change.commit));
        if (!commitLeft && !(await stillStaged(vaultRoot, change.rootPath, change.wrote))) {
          await forget();
          return true;
        }
      } catch (error) {
        logGitError("undo the scoped change", error);
      }
    }
    logHeldBack(`${change.commit ? `commit ${change.commit}` : "the staged change"} of ${change.rootPath}`);
    return false;
  };
  const heldBack = (conflict = false): SyncResult => ({ synced: false, saved: false, heldBack: true, ...(conflict ? { conflict } : {}) });

  const ours: Change = { rootPath: `${prefix}${relativePath}`, wrote: await blobOf(vaultRoot, path.join(top, `${prefix}${relativePath}`)) };
  try {
    await remember(ours);
    await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) {
      await forget();
      return { synced: true };
    }
    await commitChange(ours, relativePath, message, base);
  } catch (error) {
    logGitError("add/commit", error);
    if (!(await undo(ours, base))) return heldBack();
    return { synced: false, saved: false, reason: "commit" };
  }

  /** The version goes to a copy next to the note, but only once this write's commit is gone. */
  const toCopy = async (rebaseOthersFirst: boolean): Promise<SyncResult> => {
    let ourContent: string | undefined;
    try {
      // cat-file, not show: show first tries the argument as a file name, which fails for a long path
      // on Windows. "./" makes the path relative to the vault folder, not to the repository root.
      ourContent = (await git(vaultRoot, ["cat-file", "blob", `${ours.commit}:./${relativePath}`])).stdout;
    } catch (error) {
      logGitError("show the scoped version", error);
    }
    if (!(await undo(ours, base))) return heldBack(true);
    if (ourContent === undefined) return { synced: false, conflict: true, saved: false };
    if (rebaseOthersFirst) {
      // The branch is still on the old remote state: bring the older commits (of other writers)
      // onto the new one, so the copy can go out on top.
      try {
        await git(vaultRoot, ["pull", "--rebase"]);
      } catch (error) {
        logGitError("pull --rebase before the copy", error);
        if (await rebaseInProgressAt(gitDir)) await git(vaultRoot, ["rebase", "--abort"]).catch(() => undefined);
        return { synced: false, conflict: true, saved: false };
      }
    }
    const copyParent = await git(vaultRoot, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => "");
    let copy: Change | undefined;
    try {
      const conflictPath = await options.quarantine(relativePath, ourContent);
      copy = { rootPath: prefix + conflictPath, wrote: await blobOf(vaultRoot, path.join(top, prefix + conflictPath)) };
      await remember(copy);
      await git(vaultRoot, ["add", "--", conflictPath]);
      const conflictMessage = options.conflictMessage?.(relativePath, conflictPath) ?? `conflict: quarantined ${relativePath}`;
      await commitChange(copy, conflictPath, conflictMessage, copyParent);
      if (!(await pushAllowed(vaultRoot, copy.commit))) throw new Error("a held-back scoped commit is on the branch");
      await git(vaultRoot, ["push"]);
      await forget();
      return { synced: false, conflict: true, conflictPath };
    } catch (error) {
      logGitError("quarantine copy", error);
      if (copy !== undefined && !(await undo(copy, copyParent))) return heldBack(true);
      return { synced: false, conflict: true, saved: false };
    }
  };

  try {
    await git(vaultRoot, ["pull", "--rebase"]);
  } catch (error) {
    logGitError("pull --rebase", error);
    if (!(await rebaseInProgressAt(gitDir))) {
      // The remote cannot be reached (or refused): the change does not wait here for a later push.
      if (!(await undo(ours, base))) return heldBack();
      return NOT_SAVED_SYNC;
    }
    try {
      await git(vaultRoot, ["rebase", "--abort"]);
    } catch (abortError) {
      // Half-way through a rebase nothing can be undone safely; releaseHeldBack retries the abort.
      logGitError("rebase --abort", abortError);
      logHeldBack(`commit ${ours.commit} of ${ours.rootPath} (a rebase is still in progress)`);
      return heldBack(true);
    }
    return toCopy(true);
  }

  // The rebase went through, but Git may have carried the change somewhere else.
  let accepted = false;
  try {
    if (!(await headIs(vaultRoot, ours.commit!))) {
      // The rebase dropped the commit because the remote already had that change: nothing of
      // this write is left to check.
      accepted = true;
    } else {
      const before = await changedPaths(vaultRoot, `${ours.commit}~1`, ours.commit!);
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
    if (!(await pushAllowed(vaultRoot, ours.commit))) throw new Error("a held-back scoped commit is on the branch");
    await git(vaultRoot, ["push"]);
  } catch (error) {
    logGitError("push", error);
    // After the rebase the commit sits on the new remote state, so that is where undoing goes back to.
    const parent = await git(vaultRoot, ["rev-parse", "-q", "--verify", "HEAD~1"]).then((r) => r.stdout.trim(), () => base);
    if (!(await undo(ours, parent))) return heldBack();
    return NOT_SAVED_SYNC;
  }
  await forget();
  return { synced: true };
}
