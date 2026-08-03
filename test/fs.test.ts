import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInVault, readNote, writeNote, listDir, VaultPathError } from "../src/vault/fs.js";

async function withTempVault(fn: (vaultRoot: string) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  try {
    await fn(vaultRoot);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

test("resolveInVault accepts paths inside the vault", async () => {
  await withTempVault(async (vaultRoot) => {
    const resolved = resolveInVault(vaultRoot, "notes/foo.md");
    assert.equal(resolved, path.join(vaultRoot, "notes", "foo.md"));
  });
});

test("resolveInVault rejects ../ traversal", async () => {
  await withTempVault(async (vaultRoot) => {
    assert.throws(() => resolveInVault(vaultRoot, "../outside.md"), VaultPathError);
    assert.throws(() => resolveInVault(vaultRoot, "notes/../../outside.md"), VaultPathError);
  });
});

test("resolveInVault rejects absolute paths outside the vault", async () => {
  await withTempVault(async (vaultRoot) => {
    const outsideAbsolute = path.join(tmpdir(), "definitely-outside.md");
    assert.throws(() => resolveInVault(vaultRoot, outsideAbsolute), VaultPathError);
  });
});

test("resolveInVault rejects a sibling directory that shares a name prefix", async () => {
  await withTempVault(async (vaultRoot) => {
    const sibling = `${vaultRoot}-evil`;
    assert.throws(() => resolveInVault(vaultRoot, path.join("..", path.basename(sibling), "x.md")), VaultPathError);
  });
});

test("readNote/writeNote round-trip and refuse traversal", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeNote(vaultRoot, "sub/note.md", "hello");
    const content = await readNote(vaultRoot, "sub/note.md");
    assert.equal(content, "hello");

    await assert.rejects(() => writeNote(vaultRoot, "../escape.md", "pwned"), VaultPathError);
    await assert.rejects(() => readNote(vaultRoot, "../../../../etc/passwd"), VaultPathError);
  });
});

test("listDir rejects traversal and lists directories with a trailing slash marker", async () => {
  await withTempVault(async (vaultRoot) => {
    await mkdir(path.join(vaultRoot, "dir"), { recursive: true });
    await writeFile(path.join(vaultRoot, "file.md"), "x");

    const entries = await listDir(vaultRoot, "");
    assert.deepEqual(
      entries.map((e) => e.name).sort(),
      ["dir", "file.md"],
    );
    assert.ok(entries.find((e) => e.name === "dir")?.isDirectory);

    await assert.rejects(() => listDir(vaultRoot, "../"), VaultPathError);
  });
});
