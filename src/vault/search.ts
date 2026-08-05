import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
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

async function listMarkdownFiles(vaultRoot: string): Promise<string[]> {
  return fg("**/*.md", { cwd: vaultRoot, dot: false });
}

async function parseNote(vaultRoot: string, relativePath: string): Promise<Omit<NoteJson, "backlinks">> {
  const raw = await readNote(vaultRoot, relativePath);
  const { content, data } = matter(raw);
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

export async function buildVaultIndex(vaultRoot: string): Promise<NoteJson[]> {
  const files = await listMarkdownFiles(vaultRoot);
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

jsonLogic.add_operation("glob", (pattern: string, value: string) => {
  return new Minimatch(pattern, { nocase: true }).match(value ?? "");
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

export async function runJsonLogicQuery(vaultRoot: string, query: object): Promise<SearchQueryResult[]> {
  const index = await buildVaultIndex(vaultRoot);
  const results: SearchQueryResult[] = [];
  for (const note of index) {
    const result = jsonLogic.apply(query, note);
    if (result) {
      results.push({ filename: note.path, result });
    }
  }
  return results;
}
