import { JAVASCRIPT_FRONTMATTER_ERROR, parseFrontmatter, stringifyFrontmatter } from "../vault/frontmatter.js";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_NODES, exceedsOutputBudget, reusesValues } from "./budget.js";
import { ScopedDenied } from "./guard.js";

/**
 * Sets the token's front matter fields and adds its tags in a note's final text. Runs on the
 * result of every scoped write and patch, so a write or patch cannot remove or change them.
 * Also refuses front matter that reuses a list or mapping through a YAML alias, or that is too
 * large once written out (see checkFrontmatterSize): such a block can expand to billions of values
 * for every later reader and search, on both listeners.
 */
export function enforceFrontmatter(
  raw: string,
  fields: Record<string, string | number | boolean>,
  tags: string[],
  source = "-",
): string {
  const { content, data, javascript } = parseFrontmatter(raw, source);
  // Never store such a block for a scoped token, and never drop it silently either.
  if (javascript) throw new Error(JAVASCRIPT_FRONTMATTER_ERROR);
  if (reusesValues(data)) {
    throw new ScopedDenied(
      "yaml-alias",
      "Front matter that reuses a list or mapping through a YAML alias (*name) is not accepted from this token",
    );
  }
  checkFrontmatterSize(data);
  if (Object.keys(fields).length === 0 && tags.length === 0) return raw;
  const next: Record<string, unknown> = { ...data, ...fields };
  if (tags.length > 0) {
    const existing = Array.isArray(data.tags)
      ? data.tags.map(String)
      : typeof data.tags === "string" && data.tags !== ""
        ? [data.tags]
        : [];
    next.tags = [...new Set([...existing, ...tags])];
  }
  return stringifyFrontmatter(content, next);
}

/**
 * Refuses front matter that would be too large to write back or to print: more than the output
 * budget (about 2 MB as JSON, or 100 000 values). Measured on the parsed values, so a text anchor
 * reused thousands of times (`b: [*x, *x, ...]`, which the alias check above lets pass because it
 * only looks at lists and mappings) counts with its full length every time.
 */
export function checkFrontmatterSize(data: Record<string, unknown>): void {
  if (exceedsOutputBudget(data)) {
    throw new ScopedDenied(
      "yaml-too-large",
      `Front matter too large for this token (more than about ${MAX_OUTPUT_BYTES / 1024 / 1024} MB or ` +
        `${MAX_OUTPUT_NODES} values once written out; a YAML alias counts every time it is used)`,
    );
  }
}

/** Per-token sliding one-hour window for scoped writes. Lives as long as the scoped listener. */
export class WriteBudget {
  private readonly used = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records one write for `name` and returns true, or returns false when the hour is used up. */
  tryConsume(name: string, perHour: number): boolean {
    const now = this.now();
    const recent = (this.used.get(name) ?? []).filter((time) => time > now - 60 * 60 * 1000);
    const allowed = recent.length < perHour;
    if (allowed) recent.push(now);
    this.used.set(name, recent);
    return allowed;
  }
}
