import matter from "gray-matter";

export interface ParsedNote {
  content: string;
  data: Record<string, unknown>;
}

// gray-matter picks the front matter language from the text after the opening "---". "---js" and
// "---javascript" select its built-in JavaScript engine, which runs the block through eval(). A note
// is untrusted input (anyone with write access, and every device syncing the vault, can create one),
// so that would let a note run code inside this server on the next read or search. This engine
// replaces it and never evaluates anything: such a note simply has no front matter here.
const inertEngine = {
  parse: () => ({}),
  stringify: () => {
    throw new Error("JavaScript front matter is not supported");
  },
};

// Passing options also turns off gray-matter's module-level cache, which keeps every parsed string
// forever and hands out shared, mutable `data` objects.
const MATTER_OPTIONS = { engines: { javascript: inertEngine } };

/** Splits a note into front matter and body without ever executing front matter. */
export function parseFrontmatter(raw: string): ParsedNote {
  const { content, data } = matter(raw, MATTER_OPTIONS);
  return { content, data: { ...(data as Record<string, unknown>) } };
}

/** Joins a body and front matter back into a note (YAML front matter). */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  return matter.stringify(content, data);
}
