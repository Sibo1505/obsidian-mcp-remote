import { JAVASCRIPT_FRONTMATTER_ERROR, parseFrontmatter, stringifyFrontmatter } from "../vault/frontmatter.js";

/**
 * Sets the token's front matter fields and adds its tags in a note's final text. Runs on the
 * result of every scoped write and patch, so a write or patch cannot remove or change them.
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
