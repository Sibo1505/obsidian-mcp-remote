import path from "node:path";
import fg from "fast-glob";
import { parseFrontmatter } from "./frontmatter.js";
import jsonLogic from "json-logic-js";
import { Minimatch } from "minimatch";
import safeRegex from "safe-regex";
import { readNote, statNote } from "./fs.js";

export interface NoteJson {
  path: string;
  content: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  stat: { ctime: number; mtime: number; size: number };
  links: string[];
  backlinks: string[];
}

const WIKILINK_RE = /\[\[([^\]|#]+)/g;
const INLINE_TAG_RE = /(^|\s)#([A-Za-z0-9_/-]+)/g;

function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    links.add(match[1].trim());
  }
  return [...links];
}

function extractInlineTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(INLINE_TAG_RE)) {
    tags.add(match[2]);
  }
  return [...tags];
}

/** Decides whether a note (vault-relative, "/"-separated path) may be part of a search at all. */
export type NoteFilter = (relativePath: string) => Promise<boolean>;

async function listMarkdownFiles(vaultRoot: string, include?: NoteFilter): Promise<string[]> {
  const files = await fg("**/*.md", { cwd: vaultRoot, dot: false });
  if (!include) return files;
  const allowed = await Promise.all(files.map(include));
  return files.filter((_, index) => allowed[index]);
}

async function parseNote(vaultRoot: string, relativePath: string): Promise<Omit<NoteJson, "backlinks">> {
  const raw = await readNote(vaultRoot, relativePath);
  const { content, data } = parseFrontmatter(raw, relativePath);
  const frontmatterTags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  const tags = [...new Set([...frontmatterTags, ...extractInlineTags(content)])];
  const stat = await statNote(vaultRoot, relativePath);
  return {
    path: relativePath.split(path.sep).join("/"),
    content,
    tags,
    frontmatter: data,
    stat,
    links: extractLinks(content),
  };
}

/** Resolves an Obsidian-style wikilink target to a vault-relative .md path, if one exists. */
function resolveLinkTarget(link: string, allPaths: string[]): string | undefined {
  const linkBase = link.split("/").pop() ?? link;
  const wanted = linkBase.toLowerCase().endsWith(".md") ? linkBase.toLowerCase() : `${linkBase.toLowerCase()}.md`;
  return allPaths.find((p) => (p.split("/").pop() ?? p).toLowerCase() === wanted);
}

/**
 * Indexes every note `include` accepts (all notes without it). Excluded notes are left out
 * completely: they are not matched, and they contribute no backlinks to the notes they link to.
 */
export async function buildVaultIndex(vaultRoot: string, include?: NoteFilter): Promise<NoteJson[]> {
  const files = await listMarkdownFiles(vaultRoot, include);
  const partials = await Promise.all(files.map((f) => parseNote(vaultRoot, f)));

  const backlinkMap = new Map<string, Set<string>>();
  for (const note of partials) {
    for (const link of note.links) {
      const target = resolveLinkTarget(link, files);
      if (!target) continue;
      if (!backlinkMap.has(target)) backlinkMap.set(target, new Set());
      backlinkMap.get(target)!.add(note.path);
    }
  }

  return partials.map((note) => ({
    ...note,
    backlinks: [...(backlinkMap.get(note.path) ?? [])],
  }));
}

/**
 * Budget for one search. The main listener searches without one (as before); scoped tokens get
 * SCOPED_SEARCH_LIMITS, because their queries come from a less trusted client and one expensive
 * query blocks the event loop for both listeners.
 */
export interface SearchLimits {
  /** Size of the query as JSON, in UTF-8 bytes. */
  maxQueryBytes: number;
  /** Nesting depth of the query (objects and arrays). */
  maxDepth: number;
  /** Number of values in the query, at any depth. */
  maxNodes: number;
  /** Longest glob pattern; brace expansion ({a,b}) is off, braces match literally. */
  maxGlobLength: number;
  /** More matches than this is an error (narrow the query), never a silently cut list. */
  maxResults: number;
  /** Size of all results as JSON, in UTF-8 bytes. */
  maxResultBytes: number;
  /** Time for evaluating the query against all notes. */
  timeBudgetMs: number;
}

export const SCOPED_SEARCH_LIMITS: SearchLimits = {
  maxQueryBytes: 8 * 1024,
  maxDepth: 20,
  maxNodes: 500,
  maxGlobLength: 200,
  maxResults: 500,
  maxResultBytes: 1024 * 1024,
  timeBudgetMs: 5_000,
};

/** A search that would exceed its SearchLimits. The message says which limit. */
export class SearchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchLimitError";
  }
}

function checkQueryShape(query: object, limits: SearchLimits): void {
  if (Buffer.byteLength(JSON.stringify(query), "utf-8") > limits.maxQueryBytes) {
    throw new SearchLimitError(`Search query larger than ${limits.maxQueryBytes} bytes`);
  }
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    nodes++;
    if (nodes > limits.maxNodes) throw new SearchLimitError(`Search query has more than ${limits.maxNodes} values`);
    if (value === null || typeof value !== "object") return;
    if (depth >= limits.maxDepth) throw new SearchLimitError(`Search query nested deeper than ${limits.maxDepth} levels`);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(query, 0);
}

// Limits of the search that is evaluating right now. The evaluation loop below is synchronous, so
// no other search can run in between; operators read this instead of their `this`, which
// json-logic rebinds inside map/filter/reduce.
let activeLimits: SearchLimits | undefined;

// Compiled glob patterns, so a query is not recompiled for every note.
const globCache = new Map<string, Minimatch>();

jsonLogic.add_operation("glob", (pattern: string, value: string) => {
  const limits = activeLimits;
  if (limits && (typeof pattern !== "string" || pattern.length > limits.maxGlobLength)) {
    throw new SearchLimitError(`glob pattern must be text of at most ${limits.maxGlobLength} characters`);
  }
  const options = { nocase: true, nobrace: limits !== undefined };
  // Only text patterns are cached: the key is text, and anything else must keep failing in
  // Minimatch ("invalid pattern") instead of hitting the entry of its text form.
  if (typeof pattern !== "string") return new Minimatch(pattern, options).match(value ?? "");
  const key = `${limits ? "nobrace" : "brace"}:${pattern}`;
  let matcher = globCache.get(key);
  if (!matcher) {
    matcher = new Minimatch(pattern, options);
    if (globCache.size >= 100) globCache.clear();
    globCache.set(key, matcher);
  }
  return matcher.match(value ?? "");
});

// `pattern` comes straight from an MCP tool call, evaluated against arbitrary-length note
// content - an unbounded, user-supplied regex against attacker-influenceable input is a classic
// ReDoS: a catastrophic-backtracking pattern (e.g. "(a+)+$") can block Node's single-threaded
// event loop for every caller, not just the one that sent it. safe-regex statically rejects
// patterns whose worst-case backtracking is unbounded, rather than trying to bound the danger
// with a length cap (exponential blowup makes even a few dozen characters of input enough to hang
// indefinitely, so truncating the input doesn't actually help).
const MAX_REGEXP_PATTERN_LENGTH = 200;

jsonLogic.add_operation("regexp", (pattern: string, value: string) => {
  if (typeof pattern !== "string" || pattern.length > MAX_REGEXP_PATTERN_LENGTH || !safeRegex(pattern)) {
    return false;
  }
  return new RegExp(pattern).test(value ?? "");
});

export interface SearchQueryResult {
  filename: string;
  result: unknown;
}

export async function runJsonLogicQuery(
  vaultRoot: string,
  query: object,
  include?: NoteFilter,
  limits?: SearchLimits,
): Promise<SearchQueryResult[]> {
  if (limits) checkQueryShape(query, limits);
  const index = await buildVaultIndex(vaultRoot, include);
  const results: SearchQueryResult[] = [];
  let resultBytes = 2;
  const deadline = limits ? Date.now() + limits.timeBudgetMs : Number.POSITIVE_INFINITY;
  activeLimits = limits;
  try {
    for (const note of index) {
      if (Date.now() > deadline) throw new SearchLimitError(`Search took longer than ${limits!.timeBudgetMs} ms`);
      const result = jsonLogic.apply(query, note);
      if (!result) continue;
      const entry = { filename: note.path, result };
      results.push(entry);
      if (limits) {
        if (results.length > limits.maxResults) {
          throw new SearchLimitError(`More than ${limits.maxResults} matches; narrow the query`);
        }
        resultBytes += Buffer.byteLength(JSON.stringify(entry) ?? "", "utf-8") + 1;
        if (resultBytes > limits.maxResultBytes) {
          throw new SearchLimitError(`Result larger than ${limits.maxResultBytes} bytes; narrow the query`);
        }
      }
    }
  } finally {
    activeLimits = undefined;
  }
  return results;
}
