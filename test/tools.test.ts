import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
