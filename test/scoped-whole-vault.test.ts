// Scoped tokens with writeDir "/": the whole vault is writable except hidden folders, agent
// instruction names, writeDeny and readDeny. Existing notes and folders keep their names; whatever a
// write creates must follow the strict naming rules and must not differ from a sibling only in case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { gitIn, makeTestConfig, withGitFixture, withTestServer } from "./helpers.js";
import { createApp } from "../src/app.js";
import { withGitLock } from "../src/vault/git.js";
import { toSafeStem } from "../src/scoped/names.js";
import type { ScopedToken } from "../src/scoped/config.js";
import {
  WRITE_DIR,
  callTool,
  makeScopedToken,
  mcpRequest,
  withScopedServer,
  type ScopedTestContext,
} from "./scoped-helpers.js";

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
  "resources/claude-skills/skills/demo/SKILL.md": "# skill\n",
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
  // Agent configuration: "claude-skills" and "claude" are agent instruction names, without any writeDeny entry.
  ["resources/claude-skills/skills/demo/SKILL.md", "bad-name"],
  ["resources/claude-skills/new-note.md", "bad-name"],
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
  ["resources/claude-skills/skills/demo/SKILL.md", "bad-name"],
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

test('whole-vault token with modifyExisting "any": an existing note with spaces in its path can be overwritten (and is marked)', async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot }) => {
    const result = await callTool(baseUrl, "vault_write", { path: "My Notes/Eine Notiz.md", content: "# Neu\n" });
    assert.equal(result.isError, false, result.text);
    const text = await readFile(path.join(vaultRoot, "My Notes", "Eine Notiz.md"), "utf-8");
    assert.match(text, /^---\n[\s\S]*source: test-agent[\s\S]*---\n# Neu\n$/);
  }, wholeVaultToken({ modifyExisting: "any" }));
});

test('whole-vault token with modifyExisting "any": vault_patch on an existing note keeps its tags and adds the server\'s marks', async () => {
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
  }, wholeVaultToken({ modifyExisting: "any" }));
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
    // "own" tells the client the way out before it tries.
    assert.match(write.description, /Existing notes this token did not write cannot be changed; create a new note and link to it/);
  });
});

test('whole-vault token with modifyExisting "any": the description does not claim the "own" rule', async () => {
  await withWholeVault(async ({ baseUrl }) => {
    const res = await mcpRequest(baseUrl, makeScopedToken().secret, "tools/list");
    const tools = (res.body as { result: { tools: { name: string; description: string }[] } }).result.tools;
    assert.doesNotMatch(tools.find((tool) => tool.name === "vault_write")!.description, /did not write/);
  }, wholeVaultToken({ modifyExisting: "any" }));
});

// --- only its own notes (modifyExisting "own", the default for the whole vault) ---

/** A note the token wrote: it carries the token's front matter. */
const OWN_NOTE = "---\nsource: test-agent\ntags:\n  - scoped\n---\n# Own\n\n## Status\nold\n";

/** Every way a scoped token can change an existing note. */
const CHANGES: [label: string, tool: string, args: Record<string, unknown>][] = [
  ["vault_write replaces it", "vault_write", { content: "# replaced\n" }],
  [
    "vault_patch appends to a heading",
    "vault_patch",
    { ...patchDefaults, targetType: "heading", target: "Status", operation: "append", content: "injected", createTargetIfMissing: true },
  ],
  [
    "vault_patch replaces a heading",
    "vault_patch",
    { ...patchDefaults, targetType: "heading", target: "Status", operation: "replace", content: "injected", createTargetIfMissing: true },
  ],
  [
    "vault_patch sets a front matter field",
    "vault_patch",
    { ...patchDefaults, targetType: "frontmatter", target: "status", operation: "replace", content: "done", createTargetIfMissing: true },
  ],
  [
    "vault_patch appends to the tags",
    "vault_patch",
    { ...patchDefaults, targetType: "frontmatter", target: "tags", operation: "append", content: "injected", createTargetIfMissing: true },
  ],
  [
    "vault_patch on a block",
    "vault_patch",
    { ...patchDefaults, targetType: "block", target: "abc123", operation: "append", content: "injected" },
  ],
];

for (const [label, tool, args] of CHANGES) {
  test(`whole-vault token ("own"): ${label} is refused for notes it did not write, which stay byte for byte`, async () => {
    await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
      const before = await snapshot(vaultRoot);
      // No front matter, front matter without the token's fields, a free-form name.
      const foreign = ["Home.md", "Projects/plan.md", "My Notes/Eine Notiz.md"];
      for (const notePath of foreign) {
        const result = await callTool(baseUrl, tool, { ...args, path: notePath });
        assert.equal(result.isError, true, `${notePath}: ${result.text}`);
        assert.match(result.text, /create a new note and link to it/, notePath);
      }
      assert.equal(logs.filter((l) => l.includes(`tool=${tool}`) && l.endsWith("result=denied:foreign-note")).length, foreign.length);
      assert.deepEqual(await snapshot(vaultRoot), before);
    });
  });
}

test('whole-vault token ("own"): its own note stays changeable in every way, and stays its own', async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot }) => {
    await writeFile(path.join(vaultRoot, "Projects", "own.md"), OWN_NOTE);
    for (const [label, tool, args] of CHANGES.filter(([, , a]) => a.targetType !== "block")) {
      const result = await callTool(baseUrl, tool, { ...args, path: "Projects/own.md" });
      assert.equal(result.isError, false, `${label}: ${result.text}`);
    }
    const text = await readFile(path.join(vaultRoot, "Projects", "own.md"), "utf-8");
    assert.match(text, /^---\n[\s\S]*source: test-agent\n[\s\S]*---\n/);
    assert.match(text, /status: done/);
    // A new note anywhere is still fine.
    assert.equal((await callTool(baseUrl, "vault_write", { path: "Projects/new-note.md", content: "x\n" })).isError, false);
  });
});

test('whole-vault token ("own"): a note with only some of the fields, another value or another type is not its own', async () => {
  const token = wholeVaultToken({ frontmatter: { source: "test-agent", reviewed: false } });
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    const notes: Record<string, string> = {
      "only-source.md": "---\nsource: test-agent\n---\n# x\n",
      "other-value.md": "---\nsource: test-agent-2\nreviewed: false\n---\n# x\n",
      "text-not-boolean.md": '---\nsource: test-agent\nreviewed: "false"\n---\n# x\n',
      "other-case-key.md": "---\nSource: test-agent\nreviewed: false\n---\n# x\n",
      "nested.md": "---\nmeta:\n  source: test-agent\n  reviewed: false\n---\n# x\n",
    };
    for (const [name, content] of Object.entries(notes)) await writeFile(path.join(vaultRoot, "Projects", name), content);
    const before = await snapshot(vaultRoot);
    for (const name of Object.keys(notes)) {
      for (const [label, tool, args] of CHANGES.slice(0, 2)) {
        const result = await callTool(baseUrl, tool, { ...args, path: `Projects/${name}` });
        assert.equal(result.isError, true, `${name}, ${label}: ${result.text}`);
      }
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:foreign-note")).length, Object.keys(notes).length * 2);
    assert.deepEqual(await snapshot(vaultRoot), before);

    // Both fields with exactly these values: its own.
    await writeFile(path.join(vaultRoot, "Projects", "both.md"), "---\nsource: test-agent\nreviewed: false\n---\n# x\n");
    assert.equal((await callTool(baseUrl, "vault_write", { path: "Projects/both.md", content: "# y\n" })).isError, false);
  }, token);
});

test('whole-vault token ("own"): front matter that cannot be read counts as not its own', async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    const notes: Record<string, string> = {
      "invalid-yaml.md": "---\nsource: test-agent\nbroken: [unclosed\n---\n# x\n",
      "duplicate-key.md": "---\nsource: test-agent\nsource: test-agent\n---\n# x\n",
      "javascript.md": '---js\n{ source: "test-agent" }\n---\n# x\n',
      "not-a-mapping.md": "---\n- source: test-agent\n---\n# x\n",
      "only-in-the-body.md": "# x\n\nsource: test-agent\n",
    };
    for (const [name, content] of Object.entries(notes)) await writeFile(path.join(vaultRoot, "Projects", name), content);
    const before = await snapshot(vaultRoot);
    for (const name of Object.keys(notes)) {
      for (const [label, tool, args] of CHANGES.slice(0, 2)) {
        const result = await callTool(baseUrl, tool, { ...args, path: `Projects/${name}` });
        assert.equal(result.isError, true, `${name}, ${label}: ${result.text}`);
      }
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:foreign-note")).length, Object.keys(notes).length * 2);
    assert.deepEqual(await snapshot(vaultRoot), before);
  });
});

test('whole-vault token ("own"): a refused change counts against writesPerHour', async () => {
  await withWholeVault(async ({ baseUrl, logs }) => {
    assert.equal((await callTool(baseUrl, "vault_write", { path: "Home.md", content: "x\n" })).isError, true);
    const next = await callTool(baseUrl, "vault_write", { path: "Projects/new-note.md", content: "x\n" });
    assert.equal(next.isError, true, next.text);
    assert.deepEqual(
      logs.filter((l) => l.startsWith("scoped token=")).map((l) => l.split(" result=")[1]),
      ["denied:foreign-note", "denied:write-limit"],
    );
  }, wholeVaultToken({ writesPerHour: 1 }));
});

test('whole-vault token ("own"): a note over 2 MB is refused before it is read, also its own', async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    // The same ceiling as for vault_read: the check never loads more than that.
    const big = `${OWN_NOTE}${"x".repeat(2 * 1024 * 1024)}\n`;
    await writeFile(path.join(vaultRoot, "Projects", "big.md"), big);
    for (const [label, tool, args] of CHANGES.slice(0, 2)) {
      const result = await callTool(baseUrl, tool, { ...args, path: "Projects/big.md" });
      assert.equal(result.isError, true, label);
      assert.match(result.text, /^Note too large to change with this token \(more than 2 MB\)/, label);
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:too-large")).length, 2);
    assert.equal(await readFile(path.join(vaultRoot, "Projects", "big.md"), "utf-8"), big);
  });
});

test('whole-vault token ("own"): a symlink to its own note is still refused as a symlink', async (t) => {
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    await writeFile(path.join(vaultRoot, "Projects", "own.md"), OWN_NOTE);
    try {
      await symlink("own.md", path.join(vaultRoot, "Projects", "link.md"));
      await symlink(path.join("..", "Home.md"), path.join(vaultRoot, "Projects", "home-link.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating symlinks needs extra rights on this system (the server's Linux allows it)");
        return;
      }
      throw error;
    }
    const before = await snapshot(vaultRoot);
    for (const linkPath of ["Projects/link.md", "Projects/home-link.md"]) {
      for (const [label, tool, args] of CHANGES.slice(0, 2)) {
        const result = await callTool(baseUrl, tool, { ...args, path: linkPath });
        assert.equal(result.isError, true, `${linkPath}, ${label}: ${result.text}`);
      }
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:symlink")).length, 4);
    assert.deepEqual(await snapshot(vaultRoot), before);
  });
});

test('one write folder with modifyExisting "own": a note someone else put there is not the token\'s', async () => {
  const token = makeScopedToken({ modifyExisting: "own" });
  await withScopedServer([token], async ({ baseUrl, vaultRoot, logs }) => {
    await mkdir(path.join(vaultRoot, WRITE_DIR), { recursive: true });
    await writeFile(path.join(vaultRoot, WRITE_DIR, "task.md"), "# task from the PC\n");
    const result = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/task.md`, content: "# done\n" });
    assert.equal(result.isError, true, result.text);
    assert.ok(logs.some((l) => l.endsWith("result=denied:foreign-note")));
    assert.equal(await readFile(path.join(vaultRoot, WRITE_DIR, "task.md"), "utf-8"), "# task from the PC\n");
    // Its own notes in that folder stay changeable.
    assert.equal((await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/mine.md`, content: "a\n" })).isError, false);
    assert.equal((await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/mine.md`, content: "b\n" })).isError, false);
  });
  // The default for one folder ("any"): as before, the same note can be changed.
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    await mkdir(path.join(vaultRoot, WRITE_DIR), { recursive: true });
    await writeFile(path.join(vaultRoot, WRITE_DIR, "task.md"), "# task from the PC\n");
    assert.equal((await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/task.md`, content: "# done\n" })).isError, false);
  });
});

test('whole-vault token ("own"): the check and the write hold the git lock, so a pull cannot slip in between', async () => {
  await withWholeVault(async ({ baseUrl, vaultRoot, logs }) => {
    const note = path.join(vaultRoot, "Projects", "own.md");
    const takenOver = "# taken over on another device\n";
    for (const [label, tool, args] of CHANGES.slice(0, 2)) {
      await writeFile(note, OWN_NOTE);
      // Stands in for a pull that brings in another device's version of the note, which no longer
      // carries the token's front matter: it holds the git lock while it changes the file.
      let release!: () => void;
      const pull = withGitLock(() => new Promise<void>((resolve) => (release = resolve)));
      const change = callTool(baseUrl, tool, { ...args, path: "Projects/own.md" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(note, takenOver);
      release();
      await pull;
      const result = await change;
      assert.equal(result.isError, true, `${label}: ${result.text}`);
      assert.equal(await readFile(note, "utf-8"), takenOver, label);
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:foreign-note")).length, 2);
  });
});

test('whole-vault token ("own"): a conflict copy never replaces a note the token did not write', async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await mkdir(path.join(otherClone, "Projects"), { recursive: true });
    await writeFile(path.join(otherClone, "Projects", "note.md"), "---\nsource: test-agent\n---\nfirst\n");
    await gitIn(otherClone, ["add", "."]);
    await gitIn(otherClone, ["commit", "-m", "add note"]);
    await gitIn(otherClone, ["push", "origin", "main"]);

    await withScopedServer(
      [wholeVaultToken()],
      async ({ baseUrl }) => {
        assert.equal((await callTool(baseUrl, "vault_read", { path: "Projects/note.md" })).isError, false);
        await writeFile(path.join(otherClone, "Projects", "note.md"), "---\nsource: test-agent\n---\nedited on another device\n");
        await gitIn(otherClone, ["commit", "-am", "other device edits"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        // Notes of another writer under every name the copy could get in the next half minute.
        const planted: string[] = [];
        for (let second = -2; second < 30; second++) {
          const stamp = new Date(Date.now() + second * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const name = path.join(vaultRoot, "Projects", `note-conflict-${stamp}.md`);
          await writeFile(name, "# someone else's note\n");
          planted.push(name);
        }

        const result = await callTool(baseUrl, "vault_write", { path: "Projects/note.md", content: "mine\n" });
        const sync = JSON.parse(result.text) as { conflict?: boolean; conflictPath?: string };
        assert.equal(sync.conflict, true, result.text);
        assert.equal(sync.conflictPath, undefined, result.text);
        for (const name of planted) assert.equal(await readFile(name, "utf-8"), "# someone else's note\n");
      },
      { vaultRoot },
    );
  });
});

test("main listener: TOKEN_INTERNAL still changes every note, also one the scoped token may not change", async () => {
  await withTestServer(async (mainUrl, config) => {
    await seed(config.VAULT_PATH);
    await withScopedServer(
      [wholeVaultToken()],
      async ({ baseUrl }) => {
        assert.equal((await callTool(baseUrl, "vault_write", { path: "Home.md", content: "# scoped\n" })).isError, true);

        const call = async (name: string, args: Record<string, unknown>) => {
          const res = await mcpRequest(mainUrl, config.TOKEN_INTERNAL, "tools/call", { name, arguments: args }, {
            "X-Forwarded-For": "100.64.0.10",
          });
          return (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
        };
        const write = await call("vault_write", { path: "Home.md", content: "# Home, rewritten\n" });
        assert.equal(write.isError, undefined, write.content[0].text);
        const patch = await call("vault_patch", {
          ...patchDefaults,
          path: "Projects/plan.md",
          targetType: "heading",
          target: "Status",
          operation: "replace",
          content: "from the main port",
        });
        assert.equal(patch.isError, undefined, patch.content[0].text);
        // Unchanged rules there: no scoped marks, no ownership check.
        assert.equal(await readFile(path.join(config.VAULT_PATH, "Home.md"), "utf-8"), "# Home, rewritten\n");
        const plan = await readFile(path.join(config.VAULT_PATH, "Projects", "plan.md"), "utf-8");
        assert.match(plan, /## Status\nfrom the main port/);
        assert.doesNotMatch(plan, /test-agent/);
      },
      { vaultRoot: config.VAULT_PATH },
    );
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

test("whole-vault token: a conflict on its own note with a free-form name is quarantined under a plain name", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await mkdir(path.join(otherClone, "Projects"), { recursive: true });
    // The token's own note (it carries its front matter), so "own" lets the token change it.
    await writeFile(path.join(otherClone, "Projects", "My Note.md"), "---\nsource: test-agent\n---\nfirst\n");
    await gitIn(otherClone, ["add", "."]);
    await gitIn(otherClone, ["commit", "-m", "add note"]);
    await gitIn(otherClone, ["push", "origin", "main"]);

    await withScopedServer(
      [wholeVaultToken()],
      async ({ baseUrl }) => {
        const notePath = "Projects/My Note.md";
        // The read pulls the note in, so the write below overwrites a note the other device then edits.
        assert.equal((await callTool(baseUrl, "vault_read", { path: notePath })).isError, false);

        await writeFile(path.join(otherClone, "Projects", "My Note.md"), "---\nsource: test-agent\n---\nedited on another device\n");
        await gitIn(otherClone, ["commit", "-am", "other device edits"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        const result = await callTool(baseUrl, "vault_write", { path: notePath, content: "mine\n" });
        const sync = JSON.parse(result.text) as { conflict?: boolean; conflictPath?: string };
        assert.equal(sync.conflict, true, result.text);
        assert.match(sync.conflictPath ?? "", /^Projects\/my-note-conflict-\d{14}\.md$/);
        assert.match(await readFile(path.join(vaultRoot, sync.conflictPath!), "utf-8"), /mine/);

        const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "-1", "--format=%s"]);
        assert.equal(stdout.trim(), `test-agent: conflict quarantined ${notePath} as ${sync.conflictPath}`);
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

// --- after the rebase: the token's change lands only in the note it asked for (SEC-022) ---

/** A note the token writes first; another device then takes it over or moves it. */
const IDEA = "# Idea\n\nfirst thoughts\n\nmore thoughts\n\n## Log\n- one\n- two\n- three\n\n## End\nlast line\n";
const APPEND = {
  ...patchDefaults,
  targetType: "heading",
  target: "Idea::Log",
  operation: "append",
  content: "- TOKEN-WAS-HERE",
};

/**
 * The token writes `notePath` (so it is its own and on the remote). Then the other device pulls,
 * changes the note (takes it over by replacing the token's field, and/or moves it) and pushes.
 * The server does not pull in between: scoped writes do not pull before they check.
 */
async function adoptedOnOtherDevice(
  baseUrl: string,
  otherClone: string,
  notePath: string,
  change: { removeFields: boolean; moveTo?: string },
): Promise<{ adoptedPath: string; adoptedText: string }> {
  const seeded = await callTool(baseUrl, "vault_write", { path: notePath, content: IDEA });
  assert.equal(seeded.isError, false, seeded.text);
  assert.equal((JSON.parse(seeded.text) as { synced: boolean }).synced, true, seeded.text);
  await gitIn(otherClone, ["pull", "--no-rebase"]);
  const adoptedPath = change.moveTo ?? notePath;
  let text = await readFile(path.join(otherClone, notePath), "utf-8");
  if (change.removeFields) text = text.replace("source: test-agent\n", "owner: person\n");
  if (change.moveTo) {
    await mkdir(path.dirname(path.join(otherClone, change.moveTo)), { recursive: true });
    await gitIn(otherClone, ["mv", notePath, change.moveTo]);
  }
  await writeFile(path.join(otherClone, adoptedPath), text);
  await gitIn(otherClone, ["add", "-A"]);
  await gitIn(otherClone, ["commit", "-m", "other device takes the note over"]);
  await gitIn(otherClone, ["push", "origin", "main"]);
  return { adoptedPath, adoptedText: text };
}

/** The remote as the other device sees it after pulling. */
async function remoteAfterPull(otherClone: string): Promise<void> {
  await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
}

const rebaseCases: {
  name: string;
  scoped: () => ScopedToken;
  notePath: string;
  change: { removeFields: boolean; moveTo?: string };
}[] = [
  {
    name: "5a: the other device removed the token's fields and pushed",
    scoped: () => wholeVaultToken(),
    notePath: "inbox/idea.md",
    change: { removeFields: true },
  },
  {
    name: "5b: the other device removed the fields and moved the note",
    scoped: () => wholeVaultToken(),
    notePath: "inbox/idea.md",
    change: { removeFields: true, moveTo: "Projects/idea.md" },
  },
  {
    name: "5d: the other device moved the note into a writeDeny folder",
    scoped: () => wholeVaultToken({ writeDeny: ["resources/rules", "private", "rules"] }),
    notePath: "inbox/idea.md",
    change: { removeFields: false, moveTo: "rules/idea.md" },
  },
  {
    name: '5f: one write folder ("any"), the other device moved the note out of writeDir',
    scoped: () => makeScopedToken(),
    notePath: `${WRITE_DIR}/idea.md`,
    change: { removeFields: false, moveTo: "Projects/idea.md" },
  },
];

for (const { name, scoped, notePath, change } of rebaseCases) {
  test(`after the rebase (${name}): the note stays as the other device left it, the token's version becomes a copy`, async () => {
    await withGitFixture(async (vaultRoot, otherClone) => {
      await withScopedServer(
        [scoped()],
        async ({ baseUrl, logs }) => {
          const { adoptedPath, adoptedText } = await adoptedOnOtherDevice(baseUrl, otherClone, notePath, change);

          const result = await callTool(baseUrl, "vault_patch", { ...APPEND, path: notePath });
          assert.equal(result.isError, false, result.text);
          const sync = JSON.parse(result.text) as { synced: boolean; conflict?: boolean; conflictPath?: string; note?: string };
          assert.equal(sync.synced, false, result.text);
          assert.equal(sync.conflict, true, result.text);
          const folder = notePath.slice(0, notePath.lastIndexOf("/"));
          assert.match(sync.conflictPath ?? "", new RegExp(`^${folder}/idea-conflict-\\d{14}\\.md$`), result.text);
          assert.match(sync.note ?? "", /changed, moved or taken over/, result.text);

          await remoteAfterPull(otherClone);
          // Byte for byte what the other device pushed, wherever it put the note.
          assert.equal(await readFile(path.join(otherClone, adoptedPath), "utf-8"), adoptedText);
          const copy = await readFile(path.join(otherClone, sync.conflictPath!), "utf-8");
          assert.match(copy, /TOKEN-WAS-HERE/);
          assert.match(copy, /^---\nsource: test-agent\n/);
          // The only commit the token pushed names the file it really added.
          const { stdout } = await gitIn(otherClone, ["log", "-1", "--format=%s", "--name-status"]);
          assert.equal(
            stdout.trim(),
            `test-agent: conflict quarantined ${notePath} as ${sync.conflictPath}\n\nA\t${sync.conflictPath}`,
          );
          assert.ok(logs.some((l) => l.includes("tool=vault_patch") && l.endsWith("result=ok")));
        },
        { vaultRoot },
      );
    });
  });
}

test("after the rebase: when the server has pulled first, the change is refused before anything is written (5e)", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVaultToken({ writeDeny: ["rules"] })],
      async ({ baseUrl }) => {
        const { adoptedPath, adoptedText } = await adoptedOnOtherDevice(baseUrl, otherClone, "inbox/idea.md", {
          removeFields: false,
          moveTo: "rules/idea.md",
        });
        // Any read pulls first.
        await callTool(baseUrl, "vault_list", { path: "." });
        const result = await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" });
        assert.equal(result.isError, true, result.text);
        await remoteAfterPull(otherClone);
        assert.equal(await readFile(path.join(otherClone, adoptedPath), "utf-8"), adoptedText);
      },
      { vaultRoot },
    );
  });
});

test("after the rebase: without a change elsewhere, and with a change to another note, the write syncs as before", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVaultToken()],
      async ({ baseUrl }) => {
        assert.equal((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).isError, false);
        const plain = await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" });
        assert.deepEqual(JSON.parse(plain.text), { path: "inbox/idea.md", patched: true, synced: true });

        await gitIn(otherClone, ["pull", "--no-rebase"]);
        await writeFile(path.join(otherClone, "other.md"), "# another note\n");
        await gitIn(otherClone, ["add", "-A"]);
        await gitIn(otherClone, ["commit", "-m", "other device adds another note"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        const next = await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md", content: "- second" });
        assert.deepEqual(JSON.parse(next.text), { path: "inbox/idea.md", patched: true, synced: true });
        await remoteAfterPull(otherClone);
        assert.match(await readFile(path.join(otherClone, "inbox", "idea.md"), "utf-8"), /TOKEN-WAS-HERE[\s\S]*- second/);
        assert.equal(await readFile(path.join(otherClone, "other.md"), "utf-8"), "# another note\n");
      },
      { vaultRoot },
    );
  });
});

test("after the rebase: the main listener merges a moved note as before (no check there)", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    const stores = await mkdtemp(path.join(tmpdir(), "main-stores-"));
    const config = makeTestConfig(vaultRoot, {
      OAUTH_STORE_PATH: path.join(stores, "oauth-store.json"),
      WEBAUTHN_STORE_PATH: path.join(stores, "webauthn-credential.json"),
    });
    const server = createApp(config).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const mainUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpRequest(mainUrl, config.TOKEN_INTERNAL, "tools/call", { name, arguments: args }, {
        "X-Forwarded-For": "100.64.0.10",
      });
      return (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    try {
      const written = await call("vault_write", { path: "inbox/idea.md", content: IDEA });
      assert.equal(written.isError, undefined, written.content[0].text);
      await gitIn(otherClone, ["pull", "--no-rebase"]);
      await mkdir(path.join(otherClone, "Projects"), { recursive: true });
      await gitIn(otherClone, ["mv", "inbox/idea.md", "Projects/idea.md"]);
      await gitIn(otherClone, ["commit", "-m", "other device moves the note"]);
      await gitIn(otherClone, ["push", "origin", "main"]);

      // The main port patches its stale copy; Git follows the move as it always did.
      const patched = await call("vault_patch", { ...APPEND, path: "inbox/idea.md" });
      assert.equal(patched.isError, undefined, patched.content[0].text);
      assert.deepEqual(JSON.parse(patched.content[0].text), { path: "inbox/idea.md", patched: true, synced: true });
      await remoteAfterPull(otherClone);
      assert.match(await readFile(path.join(otherClone, "Projects", "idea.md"), "utf-8"), /TOKEN-WAS-HERE/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(stores, { recursive: true, force: true });
    }
  });
});
