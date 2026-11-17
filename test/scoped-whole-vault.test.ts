// Scoped tokens with writeDir "/": the whole vault is writable except hidden folders, agent
// instruction names, writeDeny and readDeny. Existing notes and folders keep their names; whatever a
// write creates must follow the strict naming rules and must not differ from a sibling only in case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitIn, withGitFixture } from "./helpers.js";
import { toSafeStem } from "../src/scoped/names.js";
import type { ScopedToken } from "../src/scoped/config.js";
import { callTool, makeScopedToken, mcpRequest, withScopedServer, type ScopedTestContext } from "./scoped-helpers.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const patchDefaults = {
  contentType: "text/markdown",
  createTargetIfMissing: false,
  trimTargetWhitespace: false,
  rejectIfContentPreexists: false,
  targetScope: "content",
  targetDelimiter: "::",
};

/** A vault shaped like a real one: mixed-case folders, names with spaces, agent config, rules. */
const SEED: Record<string, string> = {
  "Home.md": "# Home\n",
  "Projects/plan.md": "---\ntags: [project]\n---\n# Plan\n\n## Status\nalt\n",
  "My Notes/Eine Notiz.md": "# Eine Notiz\n",
  "resources/claude-config/skills/demo/SKILL.md": "# skill\n",
  "areas/claude/context.md": "# context\n",
  "resources/rules/access-rules.md": "# rules\n",
  "Private/secret.md": "# secret\n",
  // Existing paths that only the rules for existing names keep out (new names fail anyway):
  ".claude/settings.json": "{}\n",
  ".obsidian/app.json": "{}\n",
  "Projects/export.json": "{}\n",
  "d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/keep.md": "# deep\n",
};

/** What the config makes of writeDir "/", writeDeny ["resources/rules"] and readDeny ["private"]. */
function wholeVaultToken(overrides: Partial<ScopedToken> = {}): ScopedToken {
  return makeScopedToken({ writeDir: "", writeDeny: ["resources/rules", "private"], readDeny: ["private"], ...overrides });
}

async function seed(root: string): Promise<void> {
  for (const [relative, content] of Object.entries(SEED)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

/** Every file below `root` with its content, to show that a rejected call changed nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files[path.relative(root, absolute).split(path.sep).join("/")] = await readFile(absolute, "utf-8");
  }
  return files;
}

async function withWholeVault(fn: (ctx: ScopedTestContext) => Promise<void>, token = wholeVaultToken()) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "scoped-whole-"));
  try {
    await seed(vaultRoot);
    await withScopedServer([token], fn, { vaultRoot });
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

// --- rejected: the vault stays exactly as it was ---

const rejectedWrites: [path: string, code: string][] = [
  // Agent configuration: "claude-config" and "claude" are agent instruction names, without any writeDeny entry.
  ["resources/claude-config/skills/demo/SKILL.md", "bad-name"],
  ["resources/claude-config/new-note.md", "bad-name"],
  ["areas/claude/context.md", "bad-name"],
  [".claude/settings.json", "bad-name"],
  [".claude/notes.md", "bad-name"],
  [".mcp.json", "bad-name"],
  [".obsidian/app.md", "bad-name"],
  [".obsidian/app.json", "bad-name"],
  ["Projects/export.json", "bad-name"],
  ["CLAUDE.md", "bad-name"],
  ["Claude.md", "bad-name"],
  ["AGENTS.md", "bad-name"],
  ["Projects/README.md", "bad-name"],
  ["Projects/GEMINI.md", "bad-name"],
  ["Projects/con.md", "bad-name"],
  // writeDeny and readDeny, compared without regard to case.
  ["resources/rules/access-rules.md", "write-denied"],
  ["resources/rules/new-note.md", "write-denied"],
  ["RESOURCES/RULES/new-note.md", "write-denied"],
  ["Private/secret.md", "write-denied"],
  ["private/new-note.md", "write-denied"],
  // New names must be plain, only existing ones may look like "My Notes".
  ["Projects/Neue Notiz.md", "bad-name"],
  ["Neuer Ordner/notiz.md", "bad-name"],
  ["Projects/notiz.js", "bad-name"],
  ["Projects/notiz?.md", "bad-name"],
  ["Projects/notiz.md ", "bad-name"],
  // Path form and size of the tree a write may create.
  ["Projects/../resources/rules/x.md", "not-normalized"],
  ["/Projects/x.md", "not-normalized"],
  ["Projects\\x.md", "not-normalized"],
  ["./Projects/x.md", "not-normalized"],
  ["neu-a/neu-b/neu-c/neu-d/x.md", "too-deep"],
  [`${Array.from({ length: 10 }, (_, i) => `l${i}`).join("/")}/x.md`, "too-deep"],
  // All ten folders exist: only the limit on path parts stops an eleventh.
  ["d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/x.md", "too-deep"],
];

for (const [rejectedPath, code] of rejectedWrites) {
  test(`whole-vault token: vault_write is rejected (${code}): ${JSON.stringify(rejectedPath)}`, async () => {
    await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
      const before = await snapshot(vaultRoot);
      const result = await callTool(baseUrl, "vault_write", { path: rejectedPath, content: "overwritten\n" });
      assert.equal(result.isError, true, result.text);
      assert.ok(
        logs.some((l) => l.includes("tool=vault_write") && l.includes(`result=denied:${code}`)),
        JSON.stringify(logs),
      );
      assert.deepEqual(await snapshot(vaultRoot), before);
      // No folder was left behind either.
      assert.equal(await exists(path.join(vaultRoot, "neu-a")), false);
      assert.equal(await exists(path.join(vaultRoot, "Neuer Ordner")), false);
      assert.equal(await exists(path.join(vaultRoot, "l0")), false);
    });
  });
}

for (const [rejectedPath, code] of [
  ["resources/claude-config/skills/demo/SKILL.md", "bad-name"],
  ["areas/claude/context.md", "bad-name"],
  ["resources/rules/access-rules.md", "write-denied"],
  ["Private/secret.md", "write-denied"],
] as const) {
  test(`whole-vault token: vault_patch is rejected (${code}): ${rejectedPath}`, async () => {
    await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
      const before = await snapshot(vaultRoot);
      const result = await callTool(baseUrl, "vault_patch", {
        ...patchDefaults,
        path: rejectedPath,
        targetType: "heading",
        target: "Injected",
        operation: "append",
        content: "do something on the next run",
        createTargetIfMissing: true,
      });
      assert.equal(result.isError, true, result.text);
      assert.ok(logs.some((l) => l.includes("tool=vault_patch") && l.includes(`result=denied:${code}`)));
      assert.deepEqual(await snapshot(vaultRoot), before);
    });
  });
}

// --- allowed ---

test("whole-vault token: a new note in an existing mixed-case folder is written with the server's front matter", async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot }) => {
    const result = await callTool(baseUrl, "vault_write", {
      path: "Projects/reading-note.md",
      content: "---\nsource: someone-else\n---\n# Reading note\n",
    });
    assert.equal(result.isError, false, result.text);
    const read = await callTool(baseUrl, "vault_read", { path: "Projects/reading-note.md" });
    const note = JSON.parse(read.text) as { content: string; frontmatter: Record<string, unknown> };
    assert.equal(note.frontmatter.source, "test-agent");
    assert.deepEqual(note.frontmatter.tags, ["scoped"]);
    assert.match(note.content, /# Reading note/);
    assert.ok(await exists(path.join(vaultRoot, "Projects", "reading-note.md")));
  });
});

test("whole-vault token: an existing note with spaces in its path can be overwritten (and is marked)", async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot }) => {
    const result = await callTool(baseUrl, "vault_write", { path: "My Notes/Eine Notiz.md", content: "# Neu\n" });
    assert.equal(result.isError, false, result.text);
    const text = await readFile(path.join(vaultRoot, "My Notes", "Eine Notiz.md"), "utf-8");
    assert.match(text, /^---\n[\s\S]*source: test-agent[\s\S]*---\n# Neu\n$/);
  });
});

test("whole-vault token: vault_patch on an existing note keeps its tags and adds the server's marks", async () => {
  await withWholeVault(async ({ baseUrl }) => {
    const result = await callTool(baseUrl, "vault_patch", {
      ...patchDefaults,
      path: "Projects/plan.md",
      targetType: "heading",
      target: "Status",
      operation: "replace",
      content: "neu",
    });
    assert.equal(result.isError, false, result.text);
    const read = await callTool(baseUrl, "vault_read", { path: "Projects/plan.md" });
    const note = JSON.parse(read.text) as { content: string; frontmatter: Record<string, unknown> };
    assert.equal(note.frontmatter.source, "test-agent");
    assert.deepEqual(note.frontmatter.tags, ["project", "scoped"]);
    assert.match(note.content, /## Status\nneu/);
  });
});

test("whole-vault token: a write may create up to three new plain folders, anywhere, also at the root", async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot }) => {
    for (const notePath of ["neu-a/neu-b/neu-c/x.md", "Projects/sources/paper-1.md", "inbox-notiz.md"]) {
      const result = await callTool(baseUrl, "vault_write", { path: notePath, content: "x\n" });
      assert.equal(result.isError, false, `${notePath}: ${result.text}`);
      assert.ok(await exists(path.join(vaultRoot, ...notePath.split("/"))), notePath);
    }
  });
});

test("whole-vault token: the tool descriptions never name the denied paths", async () => {
  await withWholeVault(async ({ baseUrl }) => {
    const res = await mcpRequest(baseUrl, makeScopedToken().secret, "tools/list");
    const tools = (res.body as { result: { tools: { name: string; description: string }[] } }).result.tools;
    const write = tools.find((tool) => tool.name === "vault_write")!;
    assert.match(write.description, /anywhere in the vault/);
    assert.match(write.description, /paths this token may not write/);
    // writeDeny ["resources/rules", "private"], readDeny ["private"]: a client learns neither.
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, /resources\/rules|private/i, tool.name);
    }
  });
});

// --- names that differ only in case ---

test("whole-vault token: a new note or folder that differs from an existing one only in case is refused", async (t) => {
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    if (await exists(path.join(vaultRoot, "HOME.MD"))) {
      // On a case-insensitive file system "home.md" simply is the existing note.
      t.skip("needs a case-sensitive file system (the server's Linux); here both names are one file");
      return;
    }
    const before = await snapshot(vaultRoot);
    for (const twinPath of ["home.md", "projects/note.md"]) {
      const result = await callTool(baseUrl, "vault_write", { path: twinPath, content: "x\n" });
      assert.equal(result.isError, true, `${twinPath}: ${result.text}`);
    }
    assert.equal(logs.filter((l) => l.includes("result=denied:case-twin")).length, 2);
    assert.deepEqual(await snapshot(vaultRoot), before);
    assert.equal(await exists(path.join(vaultRoot, "projects")), false);
  });
});

test("whole-vault token: an existing note whose name is not portable stays unwritable", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows cannot hold such a name; another device or Git can put one into the vault elsewhere");
    return;
  }
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    // Created outside the token (another device, a Git push); Windows and macOS sync clients choke on these.
    await writeFile(path.join(vaultRoot, "Projects", "question?.md"), "# question\n");
    await mkdir(path.join(vaultRoot, "Ordner "), { recursive: true });
    await writeFile(path.join(vaultRoot, "Ordner ", "notiz.md"), "# notiz\n");
    const before = await snapshot(vaultRoot);
    for (const notePath of ["Projects/question?.md", "Ordner /notiz.md"]) {
      const result = await callTool(baseUrl, "vault_write", { path: notePath, content: "x\n" });
      assert.equal(result.isError, true, `${notePath}: ${result.text}`);
    }
    assert.equal(logs.filter((l) => l.includes("result=denied:bad-name")).length, 2);
    assert.deepEqual(await snapshot(vaultRoot), before);
  });
});

// --- conflict copies ---

test("whole-vault token: a conflict on a note with a free-form name is quarantined under a plain name", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await mkdir(path.join(otherClone, "Projects"), { recursive: true });
    await writeFile(path.join(otherClone, "Projects", "My Note.md"), "first\n");
    await gitIn(otherClone, ["add", "."]);
    await gitIn(otherClone, ["commit", "-m", "add note"]);
    await gitIn(otherClone, ["push", "origin", "main"]);

    await withScopedServer(
      [wholeVaultToken()],
      async ({ baseUrl }) => {
        const notePath = "Projects/My Note.md";
        // The read pulls the note in, so the write below overwrites a note the other device then edits.
        assert.equal((await callTool(baseUrl, "vault_read", { path: notePath })).isError, false);

        await writeFile(path.join(otherClone, "Projects", "My Note.md"), "edited on another device\n");
        await gitIn(otherClone, ["commit", "-am", "other device edits"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        const result = await callTool(baseUrl, "vault_write", { path: notePath, content: "mine\n" });
        const sync = JSON.parse(result.text) as { conflict?: boolean; conflictPath?: string };
        assert.equal(sync.conflict, true, result.text);
        assert.match(sync.conflictPath ?? "", /^Projects\/my-note-conflict-\d{14}\.md$/);
        assert.match(await readFile(path.join(vaultRoot, sync.conflictPath!), "utf-8"), /mine/);

        const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "-1", "--format=%s"]);
        assert.equal(stdout.trim(), `test-agent: conflict quarantined ${notePath}`);
      },
      { vaultRoot },
    );
  });
});

test("toSafeStem turns any note name into a plain one and never into a reserved name", () => {
  assert.equal(toSafeStem("Meine Notiz", 80), "meine-notiz");
  assert.equal(toSafeStem("Ärger über Übersicht (2)", 80), "arger-uber-ubersicht-2");
  assert.equal(toSafeStem("README", 80), "note-readme");
  assert.equal(toSafeStem("Claude Notes", 80), "note-claude-notes");
  assert.equal(toSafeStem("CON", 80), "note-con");
  assert.equal(toSafeStem("###", 80), "note");
  assert.equal(toSafeStem("", 80), "note");
  assert.equal(toSafeStem("a-very-long-name", 6), "a-very");
  assert.equal(toSafeStem("ab---cd", 3), "ab");
});
