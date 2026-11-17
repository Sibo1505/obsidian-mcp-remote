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
/** Most path parts (folders plus the file) of a write when the token may write the whole vault. */
export const MAX_DEPTH_WHOLE_VAULT = 10;
/** Most folders one write may create when the token may write the whole vault. */
export const MAX_NEW_FOLDERS = 3;
/**
 * Longest vault-relative path (in characters) of a note a scoped token writes. Windows allows 260
 * characters for the whole path, the vault folder included, and Git for Windows stops a pull at a
 * longer one. A conflict copy may use all of it; ordinary writes leave room for the
 * "-conflict-<time>" that a copy adds to the name.
 */
export const MAX_PATH_LENGTH = 200;
export const MAX_WRITE_PATH_LENGTH = MAX_PATH_LENGTH - 30;

/** Characters that are not allowed in a file or folder name on every OS the vault syncs to. */
const UNPORTABLE_RE = /[\u0000-\u001f<>:"|?*\\/]/;

function reservedProblem(stem: string): string | undefined {
  const folded = stem.normalize("NFC").toLowerCase();
  const reserved = RESERVED_PREFIXES.find((prefix) => folded.startsWith(prefix));
  if (reserved) return `names starting with "${reserved}" are not allowed (agent instruction files)`;
  if (WINDOWS_RESERVED.has(folded)) return `"${folded}" is a reserved name on Windows`;
  return undefined;
}

/**
 * The rules every part of a scoped write path must meet, including folders and notes that already
 * exist (and so may carry names like "Projects" or "My Note.md" that a scoped token could not
 * create itself): no hidden names, nothing that is not portable, Markdown only, and none of the
 * agent instruction or Windows device names, in any spelling. Names the write would create must
 * additionally pass `segmentProblem`.
 */
export function pathSegmentProblem(segment: string, kind: "dir" | "file"): string | undefined {
  if (segment.length === 0) return "empty name";
  if (segment.length > MAX_SEGMENT_LENGTH) return `name longer than ${MAX_SEGMENT_LENGTH} characters`;
  if (segment.startsWith(".")) return `hidden name "${segment}" (starts with ".")`;
  if (UNPORTABLE_RE.test(segment) || /[ .]$/.test(segment)) {
    return `name "${segment}" contains characters that are not allowed on every OS`;
  }
  if (kind === "file" && !segment.endsWith(".md")) return `only Markdown notes (".md") can be written`;
  return reservedProblem(kind === "file" ? segment.slice(0, -".md".length) : segment);
}

/** Returns why `segment` is not an allowed name for a new folder (or new `.md` file), or undefined if it is. */
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
  return reservedProblem(kind === "file" ? segment.slice(0, -".md".length) : segment);
}

/**
 * Turns any note name stem into one a scoped token may create ("Mein Ärger 2" -> "mein-arger-2"),
 * for files the server names itself, such as conflict copies. Never returns a reserved name.
 */
export function toSafeStem(stem: string, maxLength: number): string {
  const slug = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  const candidate = slug === "" ? "note" : slug;
  return reservedProblem(candidate) ? `note-${candidate}`.slice(0, maxLength).replace(/-+$/, "") : candidate;
}

/**
 * Returns why `writeDir` (from the config) is not a usable write folder, or undefined if it is.
 * "/" is the explicit way to allow the whole vault; an empty value is never taken to mean that.
 */
export function writeDirProblem(writeDir: string): string | undefined {
  if (writeDir === "/") return undefined;
  if (writeDir === "") return 'must name a folder inside the vault, or "/" for the whole vault';
  if (writeDir.startsWith("/")) return 'no leading "/" (a folder is relative to the vault; "/" alone means the whole vault)';
  for (const segment of writeDir.split("/")) {
    const problem = segmentProblem(segment, "dir");
    if (problem) return problem;
  }
  return undefined;
}
