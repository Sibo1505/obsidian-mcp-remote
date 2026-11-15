/**
 * Naming rules for everything a scoped token may create. They are deliberately much stricter than
 * what the vault itself allows: other machines sync this vault and treat some files as instructions
 * or configuration (`.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`, ...). Allowing only plain
 * lowercase names keeps a scoped writer from creating any of those, in any spelling, on any OS.
 */

const DIR_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;
const FILE_NAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/;

/**
 * Name prefixes of files that coding agents and their tools load as instructions or rules, in any
 * spelling (a case-insensitive file system treats gemini.md as GEMINI.md): CLAUDE.md, AGENT.md /
 * AGENTS.md, GEMINI.md, QWEN.md, CRUSH.md, WARP.md, copilot-instructions.md, cursor and windsurf
 * rules, Cline rules, CONVENTIONS.md, README.md. This is a known-names list, not a guarantee: a
 * tool that reads other names is not covered (see the docs' limits).
 */
export const RESERVED_PREFIXES = [
  "claude",
  "agent",
  "gemini",
  "qwen",
  "crush",
  "warp",
  "copilot",
  "cursor",
  "windsurf",
  "cline",
  "conventions",
  "readme",
];

/** Device names Windows refuses as file or folder names, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

export const MAX_SEGMENT_LENGTH = 100;
/** Most path parts (folders plus the file) allowed below the token's write folder. */
export const MAX_DEPTH_BELOW_WRITE_DIR = 4;

/** Returns why `segment` is not an allowed folder (or `.md` file) name, or undefined if it is. */
export function segmentProblem(segment: string, kind: "dir" | "file"): string | undefined {
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return `name longer than ${MAX_SEGMENT_LENGTH} characters`;
  }
  if (kind === "file" && !FILE_NAME_RE.test(segment)) {
    return `file name "${segment}" must be lowercase letters, digits and "-", ending in ".md"`;
  }
  if (kind === "dir" && !DIR_SEGMENT_RE.test(segment)) {
    return `folder name "${segment}" must be lowercase letters, digits and "-"`;
  }
  const stem = (kind === "file" ? segment.slice(0, -".md".length) : segment).toLowerCase();
  const reserved = RESERVED_PREFIXES.find((prefix) => stem.startsWith(prefix));
  if (reserved) {
    return `names starting with "${reserved}" are not allowed (agent instruction files)`;
  }
  if (WINDOWS_RESERVED.has(stem)) {
    return `"${stem}" is a reserved name on Windows`;
  }
  return undefined;
}

/** Returns why `writeDir` (from the config) is not a usable write folder, or undefined if it is. */
export function writeDirProblem(writeDir: string): string | undefined {
  if (writeDir === "") return "must name a folder inside the vault, not the vault root";
  for (const segment of writeDir.split("/")) {
    const problem = segmentProblem(segment, "dir");
    if (problem) return problem;
  }
  return undefined;
}
