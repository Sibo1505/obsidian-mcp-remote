import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, access, unlink, rm, mkdir } from "node:fs/promises";
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
      // Aborting resets index and working tree; what another writer changed meanwhile (the main
      // port writes outside the lock) is kept. Without such changes this is the plain abort.
      if (await isRebaseInProgress(vaultRoot)) await abortRebaseKeepingOthers(vaultRoot);
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

const succeeds = (vaultRoot: string, args: string[]) => git(vaultRoot, args).then(() => true, () => false);

/** Paths a commit changes (`from`..`to`), renames not followed, relative to the repository root. */
async function changedPaths(vaultRoot: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await git(vaultRoot, ["diff", "-z", "--name-only", "--no-renames", from, to]);
  return stdout.split("\0").filter((entry) => entry !== "");
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
    // This note is the owner's write: the cleanup never puts it back, and stages it again after.
    const held = await releaseHeldBack(vaultRoot, { keep: relativePath });
    if (held === "held") {
      // Staged, and the owner's: a later cleanup leaves it alone, the next sync takes it along.
      await markOwnerWrite(vaultRoot, relativePath);
      return { synced: false };
    }
    if (held === "cleared") await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) {
      return { synced: true };
    }
    await git(vaultRoot, ["commit", "-m", message]);
    // Its commit took the whole index, the owner writes included: their marks go.
    await clearOwnerWrites(vaultRoot);
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
/** Names one scoped write (a random id), so its commit is recognized exactly, also after a rebase. */
const WRITE_TRAILER = "Scoped-Write";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `step` up to three times, 200 ms apart (a ref or index lock of another Git process is short). */
async function withRetries<T>(what: string, step: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(200);
    try {
      return await step();
    } catch (error) {
      last = error;
      logGitError(what, error);
    }
  }
  throw last;
}

/** Logs a scoped change the server could not undo. Nothing goes out while it is there. */
function logHeldBack(what: string): void {
  console.error(
    `scoped change held back: ${what}. The server sends nothing out until it is gone: ` +
      "it retries on the next write; or remove it by hand (git status, git log @{upstream}..HEAD, .git/scoped-pending.json)",
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

/** The blob Git would store for a file (relative to the repository root); undefined without a file. */
async function blobAt(top: string, rootPath: string): Promise<string | undefined> {
  try {
    // From the repository root, with the path as Git knows it: no detour over the vault folder.
    return (await execFileAsync("git", ["hash-object", "--", rootPath], { cwd: top })).stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * One path a scoped write changed (relative to the repository root) and the blob it put there.
 * `owner`: the main port wrote this path while a change was held back, so it is the owner's now and
 * the cleanup leaves it alone, whatever bytes it holds (until the main port's next commit).
 */
interface PendingPath {
  rootPath: string;
  wrote: string | null;
  owner?: true;
}

/**
 * Everything a scoped write has staged or committed and not yet sent out or undone: the requested
 * note, and before a commit is dropped every path that commit changes (after a rebase that may be
 * another one). Kept in a file in the Git folder, so a later write, or the server after a restart,
 * can still put them back.
 */
const pendingFile = (gitDir: string) => path.join(gitDir, "scoped-pending.json");

async function readPending(gitDir: string): Promise<PendingPath[]> {
  try {
    const parsed = JSON.parse(await readFile(pendingFile(gitDir), "utf-8")) as unknown;
    // Round 8 wrote one entry; a list since round 9.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (entry): entry is PendingPath =>
        typeof entry === "object" && entry !== null && typeof (entry as PendingPath).rootPath === "string",
    );
  } catch {
    return [];
  }
}

async function writePending(gitDir: string, entries: PendingPath[]): Promise<void> {
  if (entries.length === 0) await rm(pendingFile(gitDir), { force: true });
  else await writeFile(pendingFile(gitDir), JSON.stringify(entries), "utf-8");
}

/** Adds entries to the pending list (an entry for the same path and blob only once). */
async function addPending(gitDir: string, entries: PendingPath[]): Promise<void> {
  const list = await readPending(gitDir);
  for (const entry of entries) {
    if (!list.some((known) => known.rootPath === entry.rootPath && known.wrote === entry.wrote)) list.push(entry);
  }
  await writePending(gitDir, list);
}

async function removePending(gitDir: string, entries: PendingPath[]): Promise<void> {
  const list = (await readPending(gitDir)).filter(
    (known) => !entries.some((entry) => entry.rootPath === known.rootPath && entry.wrote === known.wrote),
  );
  await writePending(gitDir, list);
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
 * Puts one path back to HEAD, but only as far as it still holds what the scoped write put there
 * (`wrote`): the index entry while it is that blob, the file while it is. A change of another
 * writer to the same path stays.
 */
async function restorePath(vaultRoot: string, top: string, entry: PendingPath): Promise<void> {
  if (entry.wrote === null) return;
  const spec = `:(top,literal)${entry.rootPath}`;
  const indexOurs = (await indexBlob(vaultRoot, entry.rootPath)) === entry.wrote;
  const unchanged = (await blobAt(top, entry.rootPath)) === entry.wrote;
  const inHead = (await headBlob(vaultRoot, entry.rootPath)) !== undefined;
  if (inHead) {
    const what = [...(indexOurs ? ["--staged"] : []), ...(unchanged ? ["--worktree"] : [])];
    if (what.length > 0) await git(vaultRoot, ["restore", "--source=HEAD", ...what, "--", spec]);
    return;
  }
  // Not in HEAD: the write created the file. Unstage it, and remove it while it is unchanged.
  if (indexOurs) await git(vaultRoot, ["rm", "--cached", "-q", "--ignore-unmatch", "--", spec]);
  if (unchanged) await unlink(path.join(top, entry.rootPath));
}

/** True while the index still holds the scoped write's version of the path, different from HEAD. */
async function stillStaged(vaultRoot: string, entry: PendingPath): Promise<boolean> {
  if (entry.wrote === null) return false;
  return (await indexBlob(vaultRoot, entry.rootPath)) === entry.wrote && (await headBlob(vaultRoot, entry.rootPath)) !== entry.wrote;
}

/** The trailers of a commit: token name and write id (empty when it has none). */
async function scopedTrailers(vaultRoot: string, rev: string): Promise<{ token: string; write: string }> {
  const { stdout } = await git(vaultRoot, [
    "log",
    "-1",
    `--format=%(trailers:key=${SCOPED_TRAILER},valueonly,separator=%x2C)%x00%(trailers:key=${WRITE_TRAILER},valueonly,separator=%x2C)`,
    rev,
  ]);
  const [token = "", write = ""] = stdout.trim().split("\0");
  return { token: token.trim(), write: write.trim() };
}

/** True while HEAD is the commit of the scoped write `writeId` (exactly that one, also after a rebase). */
async function headIsWrite(vaultRoot: string, writeId: string): Promise<boolean> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "-q", "--verify", "HEAD"]))) return false;
  return (await scopedTrailers(vaultRoot, "HEAD")).write === writeId;
}

/** Every path HEAD's commit changes, with the blob it put there (null: the commit deletes it). */
async function pathsOfHead(vaultRoot: string): Promise<PendingPath[]> {
  const entries: PendingPath[] = [];
  for (const rootPath of await changedPaths(vaultRoot, "HEAD~1", "HEAD")) {
    entries.push({ rootPath, wrote: (await headBlob(vaultRoot, rootPath)) ?? null });
  }
  return entries;
}

/** Scoped commits on the branch that the remote does not have, newest first (none without one). */
async function heldScopedCommits(vaultRoot: string): Promise<{ commit: string; write: string }[]> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "-q", "--verify", "@{upstream}"]))) return [];
  // Only real trailers count (the last paragraph of the message, never the subject), and only a
  // token name: a line that merely starts like a trailer, in any commit, is not one.
  const { stdout } = await git(vaultRoot, [
    "log",
    `--format=%H%x00%(trailers:key=${SCOPED_TRAILER},valueonly,separator=%x2C)%x00%(trailers:key=${WRITE_TRAILER},valueonly,separator=%x2C)`,
    "@{upstream}..HEAD",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([commit, token]) => commit !== undefined && commit !== "" && /^[a-z0-9-]+$/.test((token ?? "").trim()))
    .map(([commit, , write]) => ({ commit, write: (write ?? "").trim() }));
}

/**
 * Aborts a rebase left half-way, and keeps what other writers changed meanwhile: `git rebase
 * --abort` resets index and working tree to the state before the rebase, so every tracked change
 * outside the commit being replayed is saved first and written (and staged) again afterwards. A
 * change on a path of that commit itself cannot be told apart from the rebase's own and goes with
 * it. A rename meanwhile: the rebase stays (false). True when no rebase is in progress (any more).
 * Never throws.
 */
export async function abortRebaseKeepingOthers(vaultRoot: string): Promise<boolean> {
  try {
    const gitDir = await gitDirOf(vaultRoot);
    if (!(await rebaseInProgressAt(gitDir))) return true;
    const top = (await git(vaultRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const replayed = (await succeeds(vaultRoot, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]))
      ? await changedPaths(vaultRoot, "REBASE_HEAD~1", "REBASE_HEAD")
      : [];
    const { stdout } = await git(vaultRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
    const others: { rootPath: string; staged: boolean; content: Buffer | null }[] = [];
    const entries = stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!/^.. ./.test(entry)) continue;
      const [x, y] = [entry[0], entry[1]];
      const rootPath = entry.slice(3);
      if (x === "R" || x === "C") i += 1; // the old path follows as its own entry
      const unmerged = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
      if (unmerged || replayed.includes(rootPath)) continue;
      if (x === "R" || x === "C") {
        logHeldBack(`a rebase is still in progress, and ${rootPath} was renamed meanwhile; abort it by hand`);
        return false;
      }
      const content = await readFile(path.join(top, rootPath)).catch(() => null);
      others.push({ rootPath, staged: x !== " ", content });
    }
    await withRetries("rebase --abort", () => git(vaultRoot, ["rebase", "--abort"]));
    for (const other of others) {
      const file = path.join(top, other.rootPath);
      if (other.content === null) await rm(file, { force: true });
      else {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, other.content);
      }
      if (other.staged) await git(vaultRoot, ["add", "-A", "--", `:(top,literal)${other.rootPath}`]);
    }
    return true;
  } catch (error) {
    logGitError("abort a rebase left in progress", error);
    return false;
  }
}

/** What releaseHeldBack found: nothing to do, something cleared, or something still held back. */
export type HeldBackState = "clean" | "cleared" | "held";

/**
 * Clears what a scoped write left behind because undoing it failed earlier (or the server stopped
 * in the middle): a rebase left half-way (abortRebaseKeepingOthers), scoped commits the remote does
 * not have (dropped while they are HEAD), and what is on the pending list (put back while it
 * still holds the token's version). `keep` is a path the caller is writing right now (the main
 * port's own note): it is never put back, so the owner's write wins even when it has the same
 * bytes as the held-back change. Never throws; outside a Git repository there is nothing to clear.
 */
export async function releaseHeldBack(vaultRoot: string, options: { keep?: string } = {}): Promise<HeldBackState> {
  if (!(await succeeds(vaultRoot, ["rev-parse", "--is-inside-work-tree"]))) return "clean";
  try {
    const gitDir = await gitDirOf(vaultRoot);
    const top = (await git(vaultRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const prefix = (await git(vaultRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
    const keep = options.keep === undefined ? undefined : `${prefix}${options.keep}`;
    let state: HeldBackState = "clean";
    if (await rebaseInProgressAt(gitDir)) {
      if (!(await abortRebaseKeepingOthers(vaultRoot))) return "held";
      state = "cleared";
    }
    for (const held of await heldScopedCommits(vaultRoot)) {
      // Newest first: each one is HEAD in turn, or it cannot be dropped without touching others.
      const head = (await git(vaultRoot, ["rev-parse", "HEAD"])).stdout.trim();
      if (held.commit !== head) {
        logHeldBack(`scoped commit ${held.commit} is not on top of the branch and cannot be dropped automatically`);
        return "held";
      }
      const paths = await pathsOfHead(vaultRoot);
      await addPending(gitDir, paths);
      await git(vaultRoot, ["reset", "--soft", "HEAD~1"]);
      state = "cleared";
    }
    const entries = await readPending(gitDir);
    const owners = entries.filter((entry) => entry.owner);
    const owned = new Set(owners.map((entry) => entry.rootPath));
    if (keep !== undefined) owned.add(keep);
    const left: PendingPath[] = [];
    for (const entry of entries) {
      // A path the owner wrote is never put back: the token's entry for it goes, whatever it held.
      if (entry.owner || owned.has(entry.rootPath)) continue;
      await restorePath(vaultRoot, top, entry);
      if (await stillStaged(vaultRoot, entry)) left.push(entry);
      else state = "cleared";
    }
    await writePending(gitDir, [...left, ...owners]);
    if (left.length > 0) {
      logHeldBack(`the staged scoped change of ${left.map((entry) => entry.rootPath).join(", ")}`);
      return "held";
    }
    return state;
  } catch (error) {
    logGitError("release a held-back scoped change", error);
    return "held";
  }
}

/**
 * The main port wrote `relativePath` while a scoped change is held back: from now on the cleanup
 * leaves that path alone (see PendingPath.owner). Never throws.
 */
export async function markOwnerWrite(vaultRoot: string, relativePath: string): Promise<void> {
  try {
    const gitDir = await gitDirOf(vaultRoot);
    const prefix = (await git(vaultRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
    await addPending(gitDir, [{ rootPath: `${prefix}${relativePath}`, wrote: null, owner: true }]);
  } catch (error) {
    logGitError("note the main port's write", error);
  }
}

/** After the main port's commit (it takes the whole index, owner writes included): the marks go. */
async function clearOwnerWrites(vaultRoot: string): Promise<void> {
  try {
    const gitDir = await gitDirOf(vaultRoot);
    const entries = await readPending(gitDir);
    if (entries.some((entry) => entry.owner)) await writePending(gitDir, entries.filter((entry) => !entry.owner));
  } catch (error) {
    logGitError("clear the main port's marks", error);
  }
}

/**
 * Refuses a push while a scoped commit other than the write `exceptWrite` is on the branch and not
 * on the remote.
 */
async function pushAllowed(vaultRoot: string, exceptWrite?: string): Promise<boolean> {
  try {
    const held = (await heldScopedCommits(vaultRoot)).filter((commit) => exceptWrite === undefined || commit.write !== exceptWrite);
    if (held.length === 0) return true;
    logHeldBack(`scoped commit ${held[0].commit} is still on the branch, so nothing is pushed`);
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
 * - the commit holds only `relativePath` and carries the trailers `Scoped-Token: <name>` and
 *   `Scoped-Write: <random id>` (the id tells this commit from any other, also after a rebase);
 * - after the pull --rebase it must change the same paths as before (Git follows a rename made on
 *   another device, also into a denied folder) and `acceptRebased` must agree; otherwise the commit
 *   is dropped and its version goes to a quarantine copy, which goes out the same way;
 * - when a commit, the pull or the push fails, the change is dropped and the result says
 *   `saved: false`.
 * Dropping touches only what this write changed and is checked afterwards for every path the
 * commit changed (after a rebase also the path it moved to), with a few short retries. If it still
 * fails, the change is held back: nothing more happens (no copy, no push), the result says
 * `heldBack: true`, one log line names it, and every later write first clears it (releaseHeldBack)
 * or does not happen. Outside a Git repository, as before: `synced: false`.
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
  const base = await git(vaultRoot, ["rev-parse", "-q", "--verify", "HEAD"]).then((r) => r.stdout.trim(), () => "");

  /** One change of this call: its requested path, its write id, and every path it touched. */
  interface Change {
    entry: PendingPath;
    writeId: string;
    committed: boolean;
    paths: PendingPath[];
  }
  const newChange = async (vaultPath: string): Promise<Change> => {
    const rootPath = `${prefix}${vaultPath}`;
    const entry: PendingPath = { rootPath, wrote: (await blobAt(top, rootPath)) ?? null };
    return { entry, writeId: randomUUID(), committed: false, paths: [entry] };
  };
  const trailers = (change: Change) => `\n\n${SCOPED_TRAILER}: ${options.scopedToken}\n${WRITE_TRAILER}: ${change.writeId}`;

  /** Makes the commit of `change` (only its path). */
  const commitChange = async (change: Change, vaultPath: string, text: string) => {
    await git(vaultRoot, ["commit", "-m", text + trailers(change), "--", vaultPath]);
    change.committed = true;
  };

  /**
   * Undoes `change` and checks that nothing of it is left: its commit is no longer HEAD, and no
   * path it touched still holds its version in the index. Each try puts all those paths back
   * again, also when an earlier try already moved HEAD off the commit. A few short retries; false
   * when something stays.
   */
  const undo = async (change: Change): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(200);
      try {
        if (await headIsWrite(vaultRoot, change.writeId)) {
          // Every path the commit changes (after a rebase maybe not the requested one) is noted
          // first, here and in the pending list, so a failure after the reset cannot hide one.
          for (const entry of await pathsOfHead(vaultRoot)) {
            if (!change.paths.some((known) => known.rootPath === entry.rootPath && known.wrote === entry.wrote)) change.paths.push(entry);
          }
          await addPending(gitDir, change.paths);
          // Moving HEAD off the commit first means a failure below can never leave it there to be pushed.
          await git(vaultRoot, ["reset", "--soft", "HEAD~1"]);
        }
        for (const entry of change.paths) await restorePath(vaultRoot, top, entry);
        if (await headIsWrite(vaultRoot, change.writeId)) continue;
        let left = false;
        for (const entry of change.paths) if (await stillStaged(vaultRoot, entry)) left = true;
        if (!left) {
          await removePending(gitDir, change.paths);
          return true;
        }
      } catch (error) {
        logGitError("undo the scoped change", error);
      }
    }
    logHeldBack(`the scoped write of ${change.paths.map((entry) => entry.rootPath).join(", ")}${change.committed ? " (committed)" : ""}`);
    return false;
  };
  const heldBack = (conflict = false): SyncResult => ({ synced: false, saved: false, heldBack: true, ...(conflict ? { conflict } : {}) });

  const ours = await newChange(relativePath);
  try {
    await addPending(gitDir, [ours.entry]);
    await git(vaultRoot, ["add", "--", relativePath]);
    if (!(await hasStagedChanges(vaultRoot))) {
      await removePending(gitDir, [ours.entry]);
      return { synced: true };
    }
    await commitChange(ours, relativePath, message);
  } catch (error) {
    logGitError("add/commit", error);
    if (!(await undo(ours))) return heldBack();
    return { synced: false, saved: false, reason: "commit" };
  }
  // The commit id, as it is before the pull (its version is read from it later).
  const oursBefore = await git(vaultRoot, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => undefined);

  /** Aborts a rebase of this write, with retries; false when it stays (then nothing is undone). */
  const abortOurRebase = async (): Promise<boolean> => {
    try {
      await withRetries("rebase --abort", () => git(vaultRoot, ["rebase", "--abort"]));
      return true;
    } catch {
      logHeldBack(`the scoped write of ${ours.entry.rootPath} (a rebase is still in progress)`);
      return false;
    }
  };

  /** The version goes to a copy next to the note, but only once this write's commit is gone. */
  const toCopy = async (rebaseOthersFirst: boolean): Promise<SyncResult> => {
    let ourContent: string | undefined;
    try {
      // cat-file, not show: show first tries the argument as a file name, which fails for a long path
      // on Windows. "./" makes the path relative to the vault folder, not to the repository root.
      if (oursBefore !== undefined) ourContent = (await git(vaultRoot, ["cat-file", "blob", `${oursBefore}:./${relativePath}`])).stdout;
    } catch (error) {
      logGitError("show the scoped version", error);
    }
    if (!(await undo(ours))) return heldBack(true);
    if (ourContent === undefined) return { synced: false, conflict: true, saved: false };
    if (rebaseOthersFirst) {
      // The branch is still on the old remote state: bring the older commits (of other writers)
      // onto the new one, so the copy can go out on top.
      try {
        await git(vaultRoot, ["pull", "--rebase"]);
      } catch (error) {
        logGitError("pull --rebase before the copy", error);
        if ((await rebaseInProgressAt(gitDir)) && !(await abortOurRebase())) return heldBack(true);
        return { synced: false, conflict: true, saved: false };
      }
    }
    let copy: Change | undefined;
    try {
      const conflictPath = await options.quarantine(relativePath, ourContent);
      copy = await newChange(conflictPath);
      await addPending(gitDir, [copy.entry]);
      await git(vaultRoot, ["add", "--", conflictPath]);
      const conflictMessage = options.conflictMessage?.(relativePath, conflictPath) ?? `conflict: quarantined ${relativePath}`;
      await commitChange(copy, conflictPath, conflictMessage);
      if (!(await pushAllowed(vaultRoot, copy.writeId))) throw new Error("a held-back scoped commit is on the branch");
      await git(vaultRoot, ["push"]);
      await removePending(gitDir, copy.paths);
      return { synced: false, conflict: true, conflictPath };
    } catch (error) {
      logGitError("quarantine copy", error);
      if (copy !== undefined && !(await undo(copy))) return heldBack(true);
      return { synced: false, conflict: true, saved: false };
    }
  };

  try {
    await git(vaultRoot, ["pull", "--rebase"]);
  } catch (error) {
    logGitError("pull --rebase", error);
    if (!(await rebaseInProgressAt(gitDir))) {
      // The remote cannot be reached (or refused): the change does not wait here for a later push.
      if (!(await undo(ours))) return heldBack();
      return NOT_SAVED_SYNC;
    }
    // Half-way through a rebase nothing can be undone safely; releaseHeldBack retries the abort.
    if (!(await abortOurRebase())) return heldBack(true);
    return toCopy(true);
  }

  // The rebase went through, but Git may have carried the change somewhere else.
  let accepted = false;
  try {
    if (!(await headIsWrite(vaultRoot, ours.writeId))) {
      // The rebase dropped the commit because the remote already had that change: nothing of
      // this write is left to check.
      accepted = true;
    } else {
      const before = oursBefore === undefined ? [] : await changedPaths(vaultRoot, `${oursBefore}~1`, oursBefore);
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
    if (!(await pushAllowed(vaultRoot, ours.writeId))) throw new Error("a held-back scoped commit is on the branch");
    await git(vaultRoot, ["push"]);
  } catch (error) {
    logGitError("push", error);
    if (!(await undo(ours))) return heldBack();
    return NOT_SAVED_SYNC;
  }
  await removePending(gitDir, ours.paths);
  return { synced: true };
}
