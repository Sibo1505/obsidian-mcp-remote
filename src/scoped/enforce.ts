import { JAVASCRIPT_FRONTMATTER_ERROR, parseFrontmatter, stringifyFrontmatter } from "../vault/frontmatter.js";
import { DUMP_BUDGET, MAX_DUMP_VALUES, MAX_OUTPUT_BYTES, exceedsOutputBudget, reusesValues } from "./budget.js";
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

const dumpLimits = `more than ${MAX_DUMP_VALUES} values or about ${MAX_OUTPUT_BYTES / 1024 / 1024} MB once written out`;

/**
 * Refuses front matter that would be too costly to write back or to print: more than the dump
 * budget (10 000 values, about 2 MB). Measured on the parsed values, so a text anchor reused
 * thousands of times (`b: [*x, *x, ...]`, which the alias check above lets pass because it only
 * looks at lists and mappings) counts with its full length every time, and so does every list.
 */
export function checkFrontmatterSize(data: Record<string, unknown>): void {
  if (exceedsOutputBudget(data, DUMP_BUDGET)) {
    throw new ScopedDenied(
      "yaml-too-large",
      `Front matter too large for this token (${dumpLimits}; a YAML alias counts every time it is used)`,
    );
  }
}

/** Refuses a value a patch would put into the front matter when it is over the dump budget. */
export function checkFrontmatterValue(value: unknown): void {
  if (exceedsOutputBudget(value, DUMP_BUDGET)) {
    throw new ScopedDenied("value-too-large", `Front matter value too large for this token (${dumpLimits})`);
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
