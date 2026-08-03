const HEADING_RE = /^(#{1,6})\s+(.*)$/;

interface HeadingMatch {
  lines: string[];
  markerIndex: number;
  level: number;
  contentStart: number;
  contentEnd: number;
}

/** Walks the document tracking a breadcrumb stack of headings to resolve a `A::B::C` nested target. */
function findHeadingSection(content: string, target: string, delimiter: string): HeadingMatch | undefined {
  const lines = content.split("\n");
  const segments = target.split(delimiter).map((s) => s.trim());
  const stack: { level: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack.push({ level, text });

    const tail = stack.slice(-segments.length).map((s) => s.text);
    if (tail.length === segments.length && tail.every((t, idx) => t === segments[idx])) {
      let contentEnd = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const nextMatch = HEADING_RE.exec(lines[j]);
        if (nextMatch && nextMatch[1].length <= level) {
          contentEnd = j;
          break;
        }
      }
      return { lines, markerIndex: i, level, contentStart: i + 1, contentEnd };
    }
  }
  return undefined;
}

export function extractHeadingSection(content: string, target: string, delimiter: string) {
  const match = findHeadingSection(content, target, delimiter);
  if (!match) return undefined;
  return { text: match.lines.slice(match.contentStart, match.contentEnd).join("\n") };
}

export type HeadingOperation = "replace" | "prepend" | "append";
export type HeadingScope = "content" | "marker" | "markerAndContent";

export interface PatchHeadingOptions {
  operation: HeadingOperation;
  newContent: string;
  scope: HeadingScope;
  createTargetIfMissing: boolean;
  trimTargetWhitespace: boolean;
  rejectIfContentPreexists: boolean;
}

export function patchHeadingSection(
  content: string,
  target: string,
  delimiter: string,
  opts: PatchHeadingOptions,
): string {
  const match = findHeadingSection(content, target, delimiter);
  const newLines = opts.newContent.split("\n");

  if (!match) {
    if (!opts.createTargetIfMissing) {
      throw new Error(`Heading not found: ${target}`);
    }
    const segments = target.split(delimiter).map((s) => s.trim());
    const level = Math.min(segments.length + 1, 6);
    const heading = `${"#".repeat(level)} ${segments[segments.length - 1]}`;
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    return `${content}${separator}\n${heading}\n${opts.newContent}\n`;
  }

  const { lines, markerIndex, contentStart, contentEnd } = match;

  let rangeStart: number;
  let rangeEnd: number;
  switch (opts.scope) {
    case "marker":
      rangeStart = markerIndex;
      rangeEnd = markerIndex + 1;
      break;
    case "markerAndContent":
      rangeStart = markerIndex;
      rangeEnd = contentEnd;
      break;
    default:
      rangeStart = contentStart;
      rangeEnd = contentEnd;
  }

  let sectionLines = lines.slice(rangeStart, rangeEnd);
  if (opts.trimTargetWhitespace) {
    while (sectionLines.length > 0 && sectionLines[0].trim() === "") sectionLines.shift();
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === "") sectionLines.pop();
  }

  if (opts.rejectIfContentPreexists && sectionLines.join("\n").includes(opts.newContent)) {
    throw new Error(`Content already present in target section: ${target}`);
  }

  let replacement: string[];
  if (opts.operation === "replace") {
    replacement = newLines;
  } else if (opts.operation === "prepend") {
    replacement = [...newLines, ...sectionLines];
  } else {
    replacement = [...sectionLines, ...newLines];
  }

  const result = [...lines.slice(0, rangeStart), ...replacement, ...lines.slice(rangeEnd)];
  return result.join("\n");
}
