import matter from "gray-matter";

export interface ParsedNote {
  content: string;
  data: Record<string, unknown>;
  /** True when the note opens with a JavaScript front matter block ("---js" / "---javascript"). */
  javascript: boolean;
}

// gray-matter picks the front matter language from the text after the opening "---". "---js" and
// "---javascript" select its built-in JavaScript engine, which runs the block through eval(). A note
// is untrusted input (anyone with write access, and every device syncing the vault, can create one),
// so that would let a note run code inside this server. This engine replaces it and never evaluates
// anything.
const inertEngine = {
  parse: () => ({}),
  stringify: () => {
    throw new Error("JavaScript front matter is not supported");
  },
};

// Defense in depth: also replace the engine in gray-matter's shared default registry, so even a
// call without our options (matter(x), matter.stringify(x, ...)) can never reach eval(). The engine
// lookup in gray-matter resolves "js" and "javascript" (any case) to this one entry.
type Engine = { parse: (input: string) => object; stringify?: (data: object, options?: object) => string };
const sharedEngines = (matter as unknown as { engines: Record<string, Engine> }).engines;
sharedEngines.javascript = inertEngine;

// Passing options also turns off gray-matter's module-level cache, which keeps every parsed string
// forever and hands out shared, mutable `data` objects.
const MATTER_OPTIONS = { engines: { javascript: inertEngine } };

const JAVASCRIPT_LANGUAGES = new Set(["js", "javascript"]);

const isMapping = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

/**
 * Splits a note into front matter and body without ever executing front matter.
 *
 * Front matter that cannot be parsed (invalid YAML or JSON, an unknown "---<language>") does not
 * fail the call: the whole note is returned as body with no front matter, and one line naming
 * `source` (never the content or the parser message, which quotes it) goes to the log. This is
 * what gray-matter's cache used to do from the second call on; failing instead would let a single
 * broken note break every search.
 */
export function parseFrontmatter(raw: string, source = "-"): ParsedNote {
  let file: matter.GrayMatterFile<string>;
  try {
    file = matter(raw, MATTER_OPTIONS);
  } catch {
    console.error(`Front matter could not be parsed, treating it as body: ${JSON.stringify(source)}`);
    return { content: raw, data: {}, javascript: false };
  }
  // Front matter is a mapping. A block that reads as text, a number, a date, a list or null is
  // something else (a rule above a paragraph, say), so the whole note stays body. Spreading such a
  // value would turn a sentence into "0", "1", ... keys and drop it from the body.
  if (!isMapping(file.data)) return { content: raw, data: {}, javascript: false };
  return {
    content: file.content,
    data: { ...file.data },
    javascript: JAVASCRIPT_LANGUAGES.has(String(file.language ?? "").trim().toLowerCase()),
  };
}

/** Message for every write path that refuses a note with JavaScript front matter. */
export const JAVASCRIPT_FRONTMATTER_ERROR =
  "This note has JavaScript front matter (---js). The server never runs it and will not rewrite it, " +
  "because that would drop the block; change this note outside the server.";

const newline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * Joins a body and front matter back into a note (YAML front matter), byte for byte the way
 * gray-matter's stringify did. Built here instead of calling matter.stringify(): that function
 * parses `content` again with the default engines, so a body that itself starts with a front
 * matter block would be evaluated (and merged into the data). Here the body is never parsed.
 */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  // gray-matter's YAML engine: js-yaml safeDump (no custom types, no functions).
  const yaml = sharedEngines.yaml.stringify!(data, {}).trim();
  const head = yaml === "{}" ? "" : `---\n${newline(yaml)}---\n`;
  return head + newline(content);
}
