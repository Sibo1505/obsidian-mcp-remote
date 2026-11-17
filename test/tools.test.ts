import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { parseFrontmatter, stringifyFrontmatter } from "../src/vault/frontmatter.js";
import { runJsonLogicQuery, SCOPED_SEARCH_LIMITS, SearchLimitError, type SearchLimits } from "../src/vault/search.js";
import { vaultRead } from "../src/tools/vault-read.js";
import { vaultWrite } from "../src/tools/vault-write.js";
import { vaultPatch } from "../src/tools/vault-patch.js";
import { vaultList } from "../src/tools/vault-list.js";
import { searchQuery } from "../src/tools/search-query.js";
import { writeNote } from "../src/vault/fs.js";
import { withTempVault } from "./helpers.js";

// --- vault_write ---

test("vaultWrite creates a new file and reports it as written", async () => {
  await withTempVault(async (vaultRoot) => {
    const result = await vaultWrite(vaultRoot, { path: "note.md", content: "hello world" });
    assert.deepEqual(result, { path: "note.md", written: true });
    const { content } = await vaultRead(vaultRoot, { path: "note.md" });
    assert.equal(content, "hello world");
  });
});

test("vaultWrite overwrites an existing file", async () => {
  await withTempVault(async (vaultRoot) => {
    await vaultWrite(vaultRoot, { path: "note.md", content: "first" });
    await vaultWrite(vaultRoot, { path: "note.md", content: "second" });
    const { content } = await vaultRead(vaultRoot, { path: "note.md" });
    assert.equal(content, "second");
  });
});

// --- vault_read ---

test("vaultRead with no target returns content, frontmatter and stat", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntitle: Test\n---\nBody text");
    const result = await vaultRead(vaultRoot, { path: "note.md" });
    assert.equal(result.content, "Body text");
    assert.deepEqual(result.frontmatter, { title: "Test" });
    assert.ok(result.stat.mtime);
  });
});

test("vaultRead with targetType frontmatter returns the requested key", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntags: [a, b]\n---\nBody");
    const value = await vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "tags" });
    assert.deepEqual(value, ["a", "b"]);
  });
});

test("vaultRead with targetType frontmatter throws when key is missing", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntitle: Test\n---\nBody");
    await assert.rejects(() => vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "missing" }));
  });
});

test("vaultRead with targetType heading returns the section text", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "# Top\n\n## Section\nSection body\n\n## Other\nOther body");
    const section = await vaultRead(vaultRoot, { path: "note.md", targetType: "heading", target: "Section" });
    assert.equal(section, "Section body\n");
  });
});

test("vaultRead with targetType heading throws when heading is missing", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "# Top\nBody");
    await assert.rejects(() => vaultRead(vaultRoot, { path: "note.md", targetType: "heading", target: "Nope" }));
  });
});

// gray-matter ships a "javascript" front matter engine that runs the block through eval() when a
// note starts with "---js" or "---javascript". Anyone who can write a note could otherwise run code
// inside this server on the next read or search.
const JS_FRONTMATTER_NOTE = "---js\n{ title: (globalThis.__frontmatterEvaluated = true, 'x') }\n---\nBody";

test("vaultRead never evaluates JavaScript front matter", async () => {
  await withTempVault(async (vaultRoot) => {
    const g = globalThis as { __frontmatterEvaluated?: boolean };
    delete g.__frontmatterEvaluated;
    await writeNote(vaultRoot, "note.md", JS_FRONTMATTER_NOTE);
    const result = await vaultRead(vaultRoot, { path: "note.md" });
    assert.equal(g.__frontmatterEvaluated, undefined);
    assert.deepEqual(result.frontmatter, {});
  });
});

test("searchQuery never evaluates JavaScript front matter", async () => {
  await withTempVault(async (vaultRoot) => {
    const g = globalThis as { __frontmatterEvaluated?: boolean };
    delete g.__frontmatterEvaluated;
    await writeNote(vaultRoot, "note.md", JS_FRONTMATTER_NOTE);
    await searchQuery(vaultRoot, { query: { "==": [1, 1] } });
    assert.equal(g.__frontmatterEvaluated, undefined);
  });
});

// Second layer behind the safe helpers: loading src/vault/frontmatter.ts also replaces the engine in
// gray-matter's shared registry, so even a direct call without options cannot reach eval().
test("even a direct gray-matter call without options never evaluates JavaScript front matter", () => {
  const g = globalThis as { __frontmatterEvaluated?: boolean };
  delete g.__frontmatterEvaluated;
  const unique = `${process.pid}-${Date.now()}-${Math.random()}`;
  matter(`${JS_FRONTMATTER_NOTE} parse-${unique}`);
  try {
    // Usually throws (JavaScript front matter cannot be written back); what matters here is only
    // that parsing the string first did not run it.
    matter.stringify(`${JS_FRONTMATTER_NOTE} stringify-${unique}`, { title: "t" });
  } catch {
    // expected
  }
  assert.equal(g.__frontmatterEvaluated, undefined);
});

test("front matter parsing and writing never fill gray-matter's module-level cache", () => {
  const cache = (matter as unknown as { cache: Record<string, unknown> }).cache;
  const before = Object.keys(cache).length;
  const marker = `cache-probe-${Date.now()}`;
  parseFrontmatter(`---\ntitle: ${marker}\n---\nBody ${marker}`);
  stringifyFrontmatter(`---\nnested: ${marker}\n---\nBody ${marker}`, { title: marker });
  assert.equal(Object.keys(cache).length, before);
});

test("writing front matter keeps the body as it is, even when the body starts with a front matter block", () => {
  const body = "---\nnested: 1\n---\nBody\n";
  assert.equal(stringifyFrontmatter(body, { title: "t" }), `---\ntitle: t\n---\n${body}`);
  assert.equal(stringifyFrontmatter("Body", {}), "Body\n");
});

test("only src/vault/frontmatter.ts talks to gray-matter", async () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (await readdir(srcRoot, { recursive: true })).filter((f) => f.endsWith(".ts"));
  const importers = [];
  for (const file of files) {
    const text = await readFile(path.join(srcRoot, file), "utf-8");
    if (/from\s+["']gray-matter["']|require\(\s*["']gray-matter["']\s*\)/.test(text)) importers.push(file.split(path.sep).join("/"));
  }
  assert.deepEqual(importers, ["vault/frontmatter.ts"]);
});

/** Collects console.error lines while `fn` runs. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("searchQuery keeps answering when a note has front matter that is not valid YAML, and logs only its path", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "broken.md", "---\ntitle: [unclosed-secret-marker\n---\nBroken body");
    await writeNote(vaultRoot, "fine.md", "---\nstatus: done\n---\nFine");
    const logs = await captureErrors(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const byStatus = await searchQuery(vaultRoot, { query: { "==": [{ var: "frontmatter.status" }, "done"] } });
        assert.deepEqual(byStatus.map((r) => r.filename), ["fine.md"]);
        // The broken note is still searched, as plain text without front matter.
        const byText = await searchQuery(vaultRoot, { query: { regexp: ["Broken body", { var: "content" }] } });
        assert.deepEqual(byText.map((r) => r.filename), ["broken.md"]);
      }
    });
    assert.ok(logs.some((l) => l.includes('"broken.md"')));
    assert.ok(logs.every((l) => !l.includes("unclosed-secret-marker")));
  });
});

test("vaultRead returns a note with invalid YAML front matter as plain body, every time", async () => {
  await withTempVault(async (vaultRoot) => {
    const raw = "---\ntitle: [unclosed\n---\nBody";
    await writeNote(vaultRoot, "broken.md", raw);
    await captureErrors(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await vaultRead(vaultRoot, { path: "broken.md" });
        assert.equal(result.content, raw);
        assert.deepEqual(result.frontmatter, {});
      }
    });
  });
});

test("front matter that is not a mapping (text, number, date, list) is body, not front matter", () => {
  for (const raw of [
    "---\n\nMy meeting notes\n",
    "---\nIntro paragraph\n---\n# Notes",
    "---\n- first\n- second\n---\nBody",
    "---\n42\n---\nBody",
    "---\n2024-01-01\n---\nBody",
  ]) {
    assert.deepEqual(parseFrontmatter(raw), { content: raw, data: {}, javascript: false }, JSON.stringify(raw));
  }
  // An empty block (only comments, or null, which gray-matter itself reads as empty) stays an
  // empty front matter block, as before.
  for (const raw of ["---\n---\nBody", "---\n# note\n---\nBody", "---\nnull\n---\nBody"]) {
    assert.deepEqual(parseFrontmatter(raw), { content: "Body", data: {}, javascript: false }, JSON.stringify(raw));
  }
});

test("vaultRead with targetType block explicitly rejects instead of silently falling back", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "Body ^block-id");
    await assert.rejects(
      () => vaultRead(vaultRoot, { path: "note.md", targetType: "block", target: "block-id" }),
      /not supported/,
    );
  });
});

// --- vault_list ---

test("vaultList defaults to the vault root and marks directories with a trailing slash", async () => {
  await withTempVault(async (vaultRoot) => {
    await mkdir(path.join(vaultRoot, "sub"));
    await writeNote(vaultRoot, "file.md", "x");
    const entries = await vaultList(vaultRoot, {});
    assert.deepEqual(entries.sort(), ["file.md", "sub/"]);
  });
});

// --- vault_patch: frontmatter ---

test("vaultPatch frontmatter replace overwrites the existing value", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\nstatus: draft\n---\nBody");
    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "frontmatter",
      target: "status",
      operation: "replace",
      content: "done",
      contentType: "text/markdown",
      createTargetIfMissing: false,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const value = await vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "status" });
    assert.equal(value, "done");
  });
});

test("vaultPatch frontmatter throws on a missing key unless createTargetIfMissing is set", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntitle: Test\n---\nBody");
    await assert.rejects(() =>
      vaultPatch(vaultRoot, {
        path: "note.md",
        targetType: "frontmatter",
        target: "tags",
        operation: "append",
        content: ["new"],
        contentType: "application/json",
        createTargetIfMissing: false,
        trimTargetWhitespace: false,
        rejectIfContentPreexists: false,
        targetScope: "content",
        targetDelimiter: "::",
      }),
    );

    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "frontmatter",
      target: "tags",
      operation: "append",
      content: JSON.stringify(["new"]),
      contentType: "application/json",
      createTargetIfMissing: true,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const value = await vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "tags" });
    assert.deepEqual(value, ["new"]);
  });
});

test("vaultPatch frontmatter append onto an existing array adds to it", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntags: [a]\n---\nBody");
    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "frontmatter",
      target: "tags",
      operation: "append",
      content: JSON.stringify(["b"]),
      contentType: "application/json",
      createTargetIfMissing: false,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const value = await vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "tags" });
    assert.deepEqual(value, ["a", "b"]);
  });
});

// --- vault_patch: heading ---

test("vaultPatch heading append adds content after the existing section body", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "# Top\n\n## Section\nExisting\n");
    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "heading",
      target: "Section",
      operation: "append",
      content: "Appended",
      contentType: "text/markdown",
      createTargetIfMissing: false,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const section = await vaultRead(vaultRoot, { path: "note.md", targetType: "heading", target: "Section" });
    assert.match(section as string, /Existing/);
    assert.match(section as string, /Appended/);
  });
});

test("vaultPatch heading creates a new section when missing and createTargetIfMissing is set", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "# Top\nBody");
    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "heading",
      target: "New Section",
      operation: "append",
      content: "New content",
      contentType: "text/markdown",
      createTargetIfMissing: true,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const section = await vaultRead(vaultRoot, { path: "note.md", targetType: "heading", target: "New Section" });
    assert.match(section as string, /New content/);
  });
});

test("vaultPatch heading rejectIfContentPreexists throws when the content is already there", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "# Top\n\n## Section\nAlready here\n");
    await assert.rejects(() =>
      vaultPatch(vaultRoot, {
        path: "note.md",
        targetType: "heading",
        target: "Section",
        operation: "append",
        content: "Already here",
        contentType: "text/markdown",
        createTargetIfMissing: false,
        trimTargetWhitespace: false,
        rejectIfContentPreexists: true,
        targetScope: "content",
        targetDelimiter: "::",
      }),
    );
  });
});

test("vaultPatch preserves frontmatter untouched when patching a heading", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "---\ntitle: Keep Me\n---\n# Top\n\n## Section\nExisting\n");
    await vaultPatch(vaultRoot, {
      path: "note.md",
      targetType: "heading",
      target: "Section",
      operation: "replace",
      content: "Replaced",
      contentType: "text/markdown",
      createTargetIfMissing: false,
      trimTargetWhitespace: false,
      rejectIfContentPreexists: false,
      targetScope: "content",
      targetDelimiter: "::",
    });
    const frontmatter = await vaultRead(vaultRoot, { path: "note.md", targetType: "frontmatter", target: "title" });
    assert.equal(frontmatter, "Keep Me");
  });
});

test("vaultPatch with targetType block is explicitly rejected", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "note.md", "Body ^block-id");
    await assert.rejects(
      () =>
        vaultPatch(vaultRoot, {
          path: "note.md",
          targetType: "block",
          target: "block-id",
          operation: "replace",
          content: "x",
          contentType: "text/markdown",
          createTargetIfMissing: false,
          trimTargetWhitespace: false,
          rejectIfContentPreexists: false,
          targetScope: "content",
          targetDelimiter: "::",
        }),
      /not supported/,
    );
  });
});

// --- search_query ---

test("searchQuery finds notes matching a frontmatter equality check", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "---\nstatus: done\n---\nA");
    await writeNote(vaultRoot, "b.md", "---\nstatus: draft\n---\nB");
    const results = await searchQuery(vaultRoot, { query: { "==": [{ var: "frontmatter.status" }, "done"] } });
    assert.equal(results.length, 1);
    assert.equal(results[0].filename, "a.md");
  });
});

test("searchQuery resolves wikilinks into backlinks on the target note", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "Links to [[b]]");
    await writeNote(vaultRoot, "b.md", "No outgoing links");
    const results = await searchQuery(vaultRoot, { query: { in: ["a.md", { var: "backlinks" }] } });
    assert.equal(results.length, 1);
    assert.equal(results[0].filename, "b.md");
  });
});

test("searchQuery supports the custom glob operator against a note's path", async () => {
  await withTempVault(async (vaultRoot) => {
    await mkdir(path.join(vaultRoot, "01-projects"));
    await writeNote(vaultRoot, "01-projects/foo.md", "Body");
    await writeNote(vaultRoot, "elsewhere.md", "Body");
    const results = await searchQuery(vaultRoot, { query: { glob: ["01-projects/**", { var: "path" }] } });
    assert.equal(results.length, 1);
    assert.equal(results[0].filename, "01-projects/foo.md");
  });
});

test("searchQuery's glob operator refuses a pattern that is not text, also after the same text was used", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "Body");
    const notText = { glob: [["*.md"], { var: "path" }] };
    await assert.rejects(() => searchQuery(vaultRoot, { query: notText }), /invalid pattern/);
    assert.equal((await searchQuery(vaultRoot, { query: { glob: ["*.md", { var: "path" }] } })).length, 1);
    await assert.rejects(() => searchQuery(vaultRoot, { query: notText }), /invalid pattern/);
  });
});

test("searchQuery supports the custom regexp operator for a legitimate pattern", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "TODO: finish this");
    await writeNote(vaultRoot, "b.md", "nothing pending here");
    const results = await searchQuery(vaultRoot, { query: { regexp: ["^TODO", { var: "content" }] } });
    assert.equal(results.length, 1);
    assert.equal(results[0].filename, "a.md");
  });
});

test("searchQuery's regexp operator rejects a catastrophic-backtracking pattern instead of hanging", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "a".repeat(40) + "!");
    const start = Date.now();
    const results = await searchQuery(vaultRoot, { query: { regexp: ["(a+)+$", { var: "content" }] } });
    // The whole point of the fix: this must return near-instantly (rejected, not evaluated)
    // rather than actually running the regex against the crafted input.
    assert.ok(Date.now() - start < 1000);
    assert.equal(results.length, 0);
  });
});

// --- search limits (used for scoped tokens; the main listener runs without them) ---

const limits = (overrides: Partial<SearchLimits> = {}): SearchLimits => ({ ...SCOPED_SEARCH_LIMITS, ...overrides });

test("search limits: more matches than allowed is an error, not a silently cut list", async () => {
  await withTempVault(async (vaultRoot) => {
    for (const name of ["a", "b", "c"]) await writeNote(vaultRoot, `${name}.md`, name);
    await assert.rejects(() => runJsonLogicQuery(vaultRoot, { "==": [1, 1] }, undefined, limits({ maxResults: 2 })), SearchLimitError);
    assert.equal((await runJsonLogicQuery(vaultRoot, { "==": [1, 1] }, undefined, limits({ maxResults: 3 }))).length, 3);
  });
});

test("search limits: a result larger than the byte budget is an error", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "big.md", "x".repeat(500));
    await assert.rejects(
      () => runJsonLogicQuery(vaultRoot, { var: "content" }, undefined, limits({ maxResultBytes: 100 })),
      SearchLimitError,
    );
  });
});

test("search limits: glob braces stay literal and long glob patterns are refused, also when computed", async () => {
  await withTempVault(async (vaultRoot) => {
    await mkdir(path.join(vaultRoot, "projects"));
    await writeNote(vaultRoot, "projects/a.md", "---\npattern: 'projects/{a,b}.md'\n---\nA");
    const braces = { glob: ["projects/{a,b}.md", { var: "path" }] };
    assert.deepEqual((await runJsonLogicQuery(vaultRoot, braces)).map((r) => r.filename), ["projects/a.md"]);
    assert.deepEqual(await runJsonLogicQuery(vaultRoot, braces, undefined, limits()), []);
    const fromNote = { glob: [{ var: "frontmatter.pattern" }, { var: "path" }] };
    assert.deepEqual(await runJsonLogicQuery(vaultRoot, fromNote, undefined, limits()), []);
    const long = { glob: [`${"*".repeat(201)}`, { var: "path" }] };
    await assert.rejects(() => runJsonLogicQuery(vaultRoot, long, undefined, limits()), SearchLimitError);
  });
});

test("search limits: query size, depth and node count are capped", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "a");
    let deep: object = { var: "path" };
    for (let i = 0; i < 25; i++) deep = { "!": [deep] };
    const wide = { or: Array.from({ length: 600 }, () => false) };
    const big = { "==": [{ var: "content" }, "y".repeat(9000)] };
    for (const query of [deep, wide, big]) {
      await assert.rejects(() => runJsonLogicQuery(vaultRoot, query, undefined, limits()), SearchLimitError);
      await assert.doesNotReject(() => runJsonLogicQuery(vaultRoot, query));
    }
  });
});

test("search limits: a search that runs past its time budget is stopped with an error", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "a");
    await assert.rejects(
      () => runJsonLogicQuery(vaultRoot, { "==": [1, 1] }, undefined, limits({ timeBudgetMs: -1 })),
      SearchLimitError,
    );
  });
});

test("search limits: the time budget also covers reading the notes", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "a");
    const slowFilter = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    };
    await assert.rejects(
      () => runJsonLogicQuery(vaultRoot, { "==": [1, 1] }, slowFilter, limits({ timeBudgetMs: 50 })),
      SearchLimitError,
    );
    // Without limits (the main listener) the same slow filter is fine.
    assert.equal((await runJsonLogicQuery(vaultRoot, { "==": [1, 1] }, slowFilter)).length, 1);
  });
});

test("searchQuery's regexp operator rejects an overly long pattern", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "a.md", "x".repeat(300));
    const results = await searchQuery(vaultRoot, { query: { regexp: ["x".repeat(250), { var: "content" }] } });
    assert.equal(results.length, 0);
  });
});
