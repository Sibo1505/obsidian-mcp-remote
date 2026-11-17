/**
 * Size checks for values a scoped request hands out or stores, without ever building the expensive
 * thing first. js-yaml returns a YAML alias (`*name`) as a shared reference, so 450 bytes of front
 * matter can stand for billions of values once something walks or prints them ("billion laughs").
 * Both checks walk a value the way JSON.stringify would and stop as soon as the answer is known.
 */

/** Largest scoped result (about this many bytes as indented JSON). */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Most values in a scoped result, at any depth; a shared value counts every time it appears. */
export const MAX_OUTPUT_NODES = 100_000;

export interface OutputBudget {
  maxNodes: number;
  maxBytes: number;
}

export const OUTPUT_BUDGET: OutputBudget = { maxNodes: MAX_OUTPUT_NODES, maxBytes: MAX_OUTPUT_BYTES };

/** UTF-8 bytes of `text` written as a JSON string: quotes and escapes included. */
function jsonStringBytes(text: string): number {
  let extra = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08 || code === 0x0c) {
      extra += 1;
    } else if (code < 0x20) {
      extra += 5;
    }
  }
  return Buffer.byteLength(text, "utf-8") + extra;
}

/**
 * True when `value`, as JSON.stringify(value, null, 2) would print it, has more values or bytes than
 * `budget` allows. Stops at the first value over budget, so it costs at most the budget.
 */
export function exceedsOutputBudget(value: unknown, budget: OutputBudget = OUTPUT_BUDGET): boolean {
  let nodes = 0;
  let bytes = 0;
  const stack: { item: unknown; depth: number }[] = [{ item: value, depth: 0 }];
  while (stack.length > 0) {
    const { item, depth } = stack.pop()!;
    nodes += 1;
    // Indentation, separator and line break around every value.
    bytes += 2 * depth + 2;
    if (typeof item === "string") {
      bytes += jsonStringBytes(item);
    } else if (item instanceof Date) {
      bytes += 26;
    } else if (item !== null && typeof item === "object") {
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (!Array.isArray(item)) bytes += jsonStringBytes(key) + 2;
        stack.push({ item: (item as Record<string, unknown>)[key], depth: depth + 1 });
        if (nodes + stack.length > budget.maxNodes || bytes > budget.maxBytes) return true;
      }
    } else {
      bytes += String(item).length;
    }
    if (nodes > budget.maxNodes || bytes > budget.maxBytes) return true;
  }
  return false;
}

/**
 * True when some list or mapping (or date) appears more than once in `value`. That is what a YAML
 * alias to it parses to. Without aliases, parsed front matter grows only with the text it came from.
 */
export function reusesValues(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (seen.has(item)) return true;
    seen.add(item);
    for (const key in item) {
      if (Object.prototype.hasOwnProperty.call(item, key)) stack.push((item as Record<string, unknown>)[key]);
    }
  }
  return false;
}
