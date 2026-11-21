import { lstat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { vaultReadSchema, vaultRead } from "../tools/vault-read.js";
import { vaultWriteSchema } from "../tools/vault-write.js";
import { vaultPatchSchema, applyPatch, parseContentValue } from "../tools/vault-patch.js";
import { vaultListSchema } from "../tools/vault-list.js";
import { searchQuerySchema } from "../tools/search-query.js";
import { hasBlockedSegment, listDir, resolveInVault, statNote } from "../vault/fs.js";
import { SCOPED_SEARCH_LIMITS, SearchLimitError } from "../vault/search.js";
import { commitAndPushLocked, withGitLock, type CommitOptions, type SyncResult } from "../vault/git.js";
import type { ScopedToken } from "./config.js";
import {
  MAX_DEPTH_BELOW_WRITE_DIR,
  MAX_DEPTH_WHOLE_VAULT,
  MAX_NEW_FOLDERS,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  toSafeStem,
} from "./names.js";
import { checkFrontmatterSize, checkFrontmatterValue, enforceFrontmatter, isOwnNote, type WriteBudget } from "./enforce.js";
import { parseFrontmatter, type ParsedNote } from "../vault/frontmatter.js";
import { MAX_OUTPUT_BYTES, exceedsOutputBudget } from "./budget.js";
import type { ScopedSearch } from "./search-runner.js";
import {
  MAX_NOTE_BYTES,
  ScopedDenied,
  checkNoteSize,
  checkReadable,
  checkWritePath,
  isReadDenied,
  readFileNoFollow,
  resolveWriteTarget,
  writeFileNoFollow,
} from "./guard.js";

export interface ScopedToolContext {
  config: Config;
  token: ScopedToken;
  budget: WriteBudget;
  log: (line: string) => void;
  /** Freshness pull before a read, shared and throttled across requests (see pull.ts). */
  pull: () => Promise<void>;
  /** Runs search_query in a worker, one search at a time (see search-runner.ts). */
  search: ScopedSearch;
  /** Called when a tool call reaches its tool, which then writes the audit line. */
  reached?: () => void;
}

/** Names of the tools registered for a scoped token. */
export const SCOPED_TOOL_NAMES = new Set(["vault_read", "vault_write", "vault_patch", "vault_list", "search_query"]);

/**
 * What the client sees for an error that is not a policy denial. System errors (they carry a
 * code such as ENOENT) name absolute server paths in their message, so they become a fixed text;
 * the code goes to the log only. Other errors (heading not found, invalid patch input) are
 * written by this server and keep their message.
 */
function clientError(error: unknown, requestedPath: string): { text: string; logged: string } {
  if (error instanceof ScopedDenied) return { text: error.message, logged: `denied:${error.code}` };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") {
    const safeCode = /^[A-Z0-9_]{1,32}$/.test(code) ? code : "OTHER";
    const text = safeCode === "ENOENT" ? `Not found: ${requestedPath}` : `Request failed: ${requestedPath}`;
    return { text, logged: `error:${safeCode}` };
  }
  return { text: error instanceof Error ? error.message : String(error), logged: "error" };
}

/** Longest path an audit line shows; a longer one is cut, so one request cannot write a huge line. */
const MAX_LOGGED_PATH = 300;

const loggedPath = (requested: string) =>
  requested.length > MAX_LOGGED_PATH
    ? `${requested.slice(0, MAX_LOGGED_PATH)}…(+${requested.length - MAX_LOGGED_PATH})`
    : requested;

const MEGABYTES = MAX_OUTPUT_BYTES / 1024 / 1024;

/**
 * Runs one tool call and writes exactly one audit line for it: token name, tool, path and outcome.
 * Never the note content, never the token, and never a raw error message (some, like JSON.parse
 * errors, quote the input). Every result must fit the output budget (see budget.ts) before it is
 * turned into text.
 */
async function audited(
  ctx: ScopedToolContext,
  tool: string,
  requestedPath: string,
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  ctx.reached?.();
  const line = (result: string) =>
    `scoped token=${ctx.token.name} tool=${tool} path=${JSON.stringify(loggedPath(requestedPath))} result=${result}`;
  try {
    const value = await fn();
    if (exceedsOutputBudget(value)) {
      throw new ScopedDenied(
        "too-large",
        `Result too large for this token (more than about ${MEGABYTES} MB); read a heading or a front matter field, or narrow the query`,
      );
    }
    ctx.log(line("ok"));
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const { text, logged } = clientError(error, requestedPath);
    ctx.log(line(logged));
    return { isError: true, content: [{ type: "text", text }] };
  }
}

function consumeWrite(ctx: ScopedToolContext): void {
  if (!ctx.budget.tryConsume(ctx.token.name, ctx.token.writesPerHour)) {
    throw new ScopedDenied("write-limit", `Write limit reached for this token (${ctx.token.writesPerHour} per hour)`);
  }
}

/** Reads a note a scoped request is about to change: never through a symlink, at most 2 MB. */
async function readForChange(target: string, notePath: string): Promise<string> {
  if ((await lstat(target)).size > MAX_OUTPUT_BYTES) {
    throw new ScopedDenied("too-large", `Note too large to change with this token (more than ${MEGABYTES} MB): ${notePath}`);
  }
  return readFileNoFollow(target);
}

const OWN_RULE = "Existing notes this token did not write cannot be changed; create a new note and link to it instead.";

/**
 * With modifyExisting "own", an existing note may only be changed when it carries all of the
 * token's front matter fields with exactly their values (see isOwnNote). Anything else belongs to
 * someone else: no front matter, other values, front matter that cannot be read. Once a person
 * removes the marks, the note is theirs and the token can no longer change it.
 */
function checkOwnNote(ctx: ScopedToolContext, note: ParsedNote, notePath: string): void {
  if (ctx.token.modifyExisting === "own" && !isOwnNote(note, ctx.token.frontmatter)) {
    throw new ScopedDenied(
      "foreign-note",
      `Write rejected for ${JSON.stringify(notePath)}: an existing note this token did not write; ` +
        `create a new note and link to it instead`,
    );
  }
}

/** checkOwnNote for a path that may not exist yet: a new note is always fine. */
async function checkOwnIfExists(ctx: ScopedToolContext, target: string, notePath: string): Promise<void> {
  if (ctx.token.modifyExisting !== "own") return;
  let existing: string;
  try {
    existing = await readForChange(target, notePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  checkOwnNote(ctx, parseFrontmatter(existing, notePath), notePath);
}

/** `20261115203001` for 2026-11-15 20:30:01 UTC. */
function compactUtcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * On a rebase conflict the server keeps the scoped token's version under a new name. That copy
 * follows the same rules as any scoped write: `<stem>-conflict-<yyyymmddhhmmss>.md` next to the
 * note, checked path, no symlink on the way, opened without following one, and a commit message
 * that names the token. The stem is reduced to the names a scoped token may create, so an existing
 * note like "My Note.md" gets "my-note-conflict-….md".
 */
function commitOptions(ctx: ScopedToolContext): CommitOptions {
  const { writeDir, writeDeny, name } = ctx.token;
  return {
    quarantine: async (relativePath, ourContent) => {
      const parts = relativePath.split("/");
      const fileName = parts.pop()!;
      const suffix = `-conflict-${compactUtcStamp()}.md`;
      // The copy's name must fit one path part and the whole path.
      const folders = parts.length > 0 ? parts.join("/").length + 1 : 0;
      const room = Math.min(MAX_SEGMENT_LENGTH, MAX_PATH_LENGTH - folders) - suffix.length;
      const stem = toSafeStem(fileName.slice(0, -".md".length), room);
      const conflictPath = [...parts, `${stem}${suffix}`].join("/");
      const inner = checkWritePath(writeDir, writeDeny, conflictPath, MAX_PATH_LENGTH);
      const target = await resolveWriteTarget(ctx.config.VAULT_PATH, writeDir, inner, { createDirs: true });
      // A copy that would land on an existing note follows the same rule as any other change.
      await checkOwnIfExists(ctx, target, conflictPath);
      await writeFileNoFollow(target, ourContent);
      return conflictPath;
    },
    conflictMessage: (relativePath, conflictPath) => `${name}: conflict quarantined ${relativePath} as ${conflictPath}`,
    acceptRebased: async (relativePath, changed) => {
      // Git follows renames: had another device moved the note, the change would now land in the
      // moved note, in any folder (a denied one, or outside writeDir). Push only a change to the
      // note that was asked for.
      if (changed.length === 0) return true;
      if (changed.length !== 1 || changed[0] !== relativePath) return false;
      // With "own", the merged note must still be the token's: another device may have taken it over.
      if (ctx.token.modifyExisting !== "own") return true;
      const merged = await readForChange(path.join(ctx.config.VAULT_PATH, ...relativePath.split("/")), relativePath);
      return isOwnNote(parseFrontmatter(merged, relativePath), ctx.token.frontmatter);
    },
  };
}

/** For a conflict, what happened to the note and where the token's version went. */
function conflictNote(notePath: string, sync: SyncResult): { note?: string } {
  if (!sync.conflict) return {};
  return {
    note: sync.conflictPath
      ? `${notePath} was changed, moved or taken over on another device meanwhile and stays as it is there; ` +
        `this version was saved as ${sync.conflictPath}`
      : `${notePath} was changed on another device meanwhile, and this version could not be saved; read the note again`,
  };
}

function enforce(ctx: ScopedToolContext, text: string, source: string): string {
  return enforceFrontmatter(text, ctx.token.frontmatter, ctx.token.tags, source);
}

/**
 * The five vault tools, bound to one scoped token: read everything not denied, write one folder
 * (or the whole vault minus writeDeny).
 */
export function registerScopedTools(server: McpServer, ctx: ScopedToolContext): void {
  const vault = ctx.config.VAULT_PATH;
  const { writeDir, writeDeny, readDeny } = ctx.token;
  const newNames = `new folders and notes need names of lowercase letters, digits and "-" (notes ending in .md)`;
  const ownRule = ctx.token.modifyExisting === "own" ? ` ${OWN_RULE}` : "";
  const writeRules =
    writeDir === ""
      ? // The deny lists stay out of the description: they would tell every client which notes
        // matter most. A denied write says so when it happens ("not writable with this token").
        `This token can write Markdown notes anywhere in the vault except hidden folders, agent instruction ` +
        `files and paths this token may not write.${ownRule} Existing notes keep ` +
        `their names; ${newNames}; at most ${MAX_DEPTH_WHOLE_VAULT} path parts and ${MAX_NEW_FOLDERS} new ` +
        `folders per write, at most ${MAX_NOTE_BYTES / 1024} KB.`
      : `This token can only write Markdown notes below ${writeDir}/: ${newNames}, ` +
        `at most ${MAX_DEPTH_BELOW_WRITE_DIR} levels, at most ${MAX_NOTE_BYTES / 1024} KB.${ownRule}`;

  server.registerTool(
    "vault_read",
    { description: "Read a vault file, optionally extracting a heading or frontmatter section.", inputSchema: vaultReadSchema },
    (input) =>
      audited(ctx, "vault_read", input.path, async () => {
        await ctx.pull();
        await checkReadable(vault, readDeny, input.path);
        // Refuse before reading: the whole file would be loaded and then refused anyway.
        if ((await statNote(vault, input.path)).size > MAX_OUTPUT_BYTES) {
          throw new ScopedDenied("too-large", `File too large to read with this token (more than ${MEGABYTES} MB): ${input.path}`);
        }
        return vaultRead(vault, input);
      }),
  );

  server.registerTool(
    "vault_write",
    { description: `Create or overwrite a vault note with the given content. ${writeRules}`, inputSchema: vaultWriteSchema },
    (input) =>
      audited(ctx, "vault_write", input.path, async () => {
        const inner = checkWritePath(writeDir, writeDeny, input.path);
        checkNoteSize(input.content);
        // Counted from here on, also when the front matter is refused below: the limit then caps
        // the work a token can cause, not only the notes it stores.
        consumeWrite(ctx);
        const output = enforce(ctx, input.content, input.path);
        checkNoteSize(output);
        // From the look at the note on disk to the commit under the git lock: no pull can bring in
        // another device's version of the note between the check and the write.
        const sync = await withGitLock(async () => {
          const target = await resolveWriteTarget(vault, writeDir, inner, { createDirs: true });
          await checkOwnIfExists(ctx, target, input.path);
          await writeFileNoFollow(target, output);
          return commitAndPushLocked(vault, input.path, `${ctx.token.name}: vault_write ${input.path}`, commitOptions(ctx));
        });
        return { path: input.path, written: true, ...sync, ...conflictNote(input.path, sync) };
      }),
  );

  server.registerTool(
    "vault_patch",
    { description: `Patch a heading section or frontmatter field of a vault note. ${writeRules}`, inputSchema: vaultPatchSchema },
    (input) =>
      audited(ctx, "vault_patch", input.path, async () => {
        const inner = checkWritePath(writeDir, writeDeny, input.path);
        // Read, check, patch, write and commit under the git lock (see vault_write).
        const sync = await withGitLock(async () => {
          const target = await resolveWriteTarget(vault, writeDir, inner, { createDirs: false });
          const current = await readForChange(target, input.path);
          consumeWrite(ctx);
          const note = parseFrontmatter(current, input.path);
          checkOwnNote(ctx, note, input.path);
          // Patching writes the note's front matter back out, so check its size before that happens:
          // the note may come from another writer.
          checkFrontmatterSize(note.data);
          // A front matter patch writes its value out too: same budget, checked before that happens.
          if (input.targetType === "frontmatter") checkFrontmatterValue(parseContentValue(input));
          const patched = applyPatch(current, input);
          checkNoteSize(patched);
          const output = enforce(ctx, patched, input.path);
          checkNoteSize(output);
          await writeFileNoFollow(target, output);
          return commitAndPushLocked(vault, input.path, `${ctx.token.name}: vault_patch ${input.path}`, commitOptions(ctx));
        });
        return { path: input.path, patched: true, ...sync, ...conflictNote(input.path, sync) };
      }),
  );

  server.registerTool(
    "vault_list",
    { description: "List files and subdirectories inside a vault directory.", inputSchema: vaultListSchema },
    (input) =>
      audited(ctx, "vault_list", input.path, async () => {
        await ctx.pull();
        await checkReadable(vault, readDeny, input.path);
        const root = path.resolve(vault);
        const base = path.relative(root, resolveInVault(root, input.path)).split(path.sep).join("/");
        const entries = await listDir(vault, input.path);
        return entries
          .filter((entry) => !hasBlockedSegment([entry.name]))
          .filter((entry) => !isReadDenied(readDeny, base ? `${base}/${entry.name}` : entry.name))
          .map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name));
      }),
  );

  server.registerTool(
    "search_query",
    { description: "Search vault notes using a JsonLogic query evaluated against each note's metadata.", inputSchema: searchQuerySchema },
    (input) =>
      audited(ctx, "search_query", "-", async () => {
        await ctx.pull();
        try {
          return await ctx.search.run({
            vaultRoot: vault,
            readDeny,
            query: input.query as object,
            limits: SCOPED_SEARCH_LIMITS,
          });
        } catch (error) {
          if (error instanceof SearchLimitError) throw new ScopedDenied("search-limit", error.message);
          throw error;
        }
      }),
  );
}
