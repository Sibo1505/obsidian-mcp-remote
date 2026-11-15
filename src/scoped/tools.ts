import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { vaultReadSchema, vaultRead } from "../tools/vault-read.js";
import { vaultWriteSchema } from "../tools/vault-write.js";
import { vaultPatchSchema, applyPatch } from "../tools/vault-patch.js";
import { vaultListSchema } from "../tools/vault-list.js";
import { searchQuerySchema } from "../tools/search-query.js";
import { hasBlockedSegment, listDir, resolveInVault } from "../vault/fs.js";
import { runJsonLogicQuery, SCOPED_SEARCH_LIMITS, SearchLimitError } from "../vault/search.js";
import { commitAndPush } from "../vault/git.js";
import type { ScopedToken } from "./config.js";
import { MAX_DEPTH_BELOW_WRITE_DIR } from "./names.js";
import { enforceFrontmatter, type WriteBudget } from "./enforce.js";
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

/**
 * Runs one tool call and writes exactly one audit line for it: token name, tool, path and outcome.
 * Never the note content, never the token, and never a raw error message (some, like JSON.parse
 * errors, quote the input).
 */
async function audited(
  ctx: ScopedToolContext,
  tool: string,
  requestedPath: string,
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  const line = (result: string) =>
    `scoped token=${ctx.token.name} tool=${tool} path=${JSON.stringify(requestedPath)} result=${result}`;
  try {
    const value = await fn();
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

function enforce(ctx: ScopedToolContext, text: string, source: string): string {
  return enforceFrontmatter(text, ctx.token.frontmatter, ctx.token.tags, source);
}

/** The five vault tools, bound to one scoped token: read everything not denied, write one folder. */
export function registerScopedTools(server: McpServer, ctx: ScopedToolContext): void {
  const vault = ctx.config.VAULT_PATH;
  const { writeDir, readDeny } = ctx.token;
  const writeRules =
    `This token can only write Markdown notes below ${writeDir}/: names of lowercase letters, digits and "-", ` +
    `files ending in .md, at most ${MAX_DEPTH_BELOW_WRITE_DIR} levels, at most ${MAX_NOTE_BYTES / 1024} KB.`;

  server.registerTool(
    "vault_read",
    { description: "Read a vault file, optionally extracting a heading or frontmatter section.", inputSchema: vaultReadSchema },
    (input) =>
      audited(ctx, "vault_read", input.path, async () => {
        await ctx.pull();
        await checkReadable(vault, readDeny, input.path);
        return vaultRead(vault, input);
      }),
  );

  server.registerTool(
    "vault_write",
    { description: `Create or overwrite a vault note with the given content. ${writeRules}`, inputSchema: vaultWriteSchema },
    (input) =>
      audited(ctx, "vault_write", input.path, async () => {
        const inner = checkWritePath(writeDir, input.path);
        checkNoteSize(input.content);
        const output = enforce(ctx, input.content, input.path);
        checkNoteSize(output);
        consumeWrite(ctx);
        const target = await resolveWriteTarget(vault, writeDir, inner, { createDirs: true });
        await writeFileNoFollow(target, output);
        const sync = await commitAndPush(vault, input.path, `${ctx.token.name}: vault_write ${input.path}`);
        return { path: input.path, written: true, ...sync };
      }),
  );

  server.registerTool(
    "vault_patch",
    { description: `Patch a heading section or frontmatter field of a vault note. ${writeRules}`, inputSchema: vaultPatchSchema },
    (input) =>
      audited(ctx, "vault_patch", input.path, async () => {
        const inner = checkWritePath(writeDir, input.path);
        const target = await resolveWriteTarget(vault, writeDir, inner, { createDirs: false });
        const patched = applyPatch(await readFileNoFollow(target), input);
        checkNoteSize(patched);
        const output = enforce(ctx, patched, input.path);
        checkNoteSize(output);
        consumeWrite(ctx);
        await writeFileNoFollow(target, output);
        const sync = await commitAndPush(vault, input.path, `${ctx.token.name}: vault_patch ${input.path}`);
        return { path: input.path, patched: true, ...sync };
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
        const readable = async (relativePath: string) => {
          try {
            await checkReadable(vault, readDeny, relativePath);
            return true;
          } catch {
            return false;
          }
        };
        try {
          return await runJsonLogicQuery(vault, input.query as object, readable, SCOPED_SEARCH_LIMITS);
        } catch (error) {
          if (error instanceof SearchLimitError) throw new ScopedDenied("search-limit", error.message);
          throw error;
        }
      }),
  );
}
