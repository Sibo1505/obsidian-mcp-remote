import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { commitAndPush, pullBestEffort } from "../src/vault/git.js";
import { withGitFixture, withTempVault, gitIn } from "./helpers.js";

test("commitAndPush commits and pushes a new file to origin", async () => {
  await withGitFixture(async (vaultRoot) => {
    await writeFile(path.join(vaultRoot, "note.md"), "hello");
    const result = await commitAndPush(vaultRoot, "note.md", "add note");
    assert.deepEqual(result, { synced: true });

    const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "--oneline"]);
    assert.match(stdout, /add note/);
  });
});

test("commitAndPush is a no-op when nothing actually changed", async () => {
  await withGitFixture(async (vaultRoot) => {
    await writeFile(path.join(vaultRoot, "note.md"), "hello");
    await commitAndPush(vaultRoot, "note.md", "add note");
    const before = await gitIn(vaultRoot, ["rev-parse", "HEAD"]);

    const result = await commitAndPush(vaultRoot, "note.md", "add note again");
    const after = await gitIn(vaultRoot, ["rev-parse", "HEAD"]);

    assert.deepEqual(result, { synced: true });
    assert.equal(before.stdout, after.stdout);
  });
});

test("commitAndPush pulls in a concurrent, non-conflicting change from another clone first", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await writeFile(path.join(otherClone, "other.md"), "from other device");
    await gitIn(otherClone, ["add", "."]);
    await gitIn(otherClone, ["commit", "-m", "other device commit"]);
    await gitIn(otherClone, ["push", "origin", "main"]);

    await writeFile(path.join(vaultRoot, "note.md"), "hello");
    const result = await commitAndPush(vaultRoot, "note.md", "add note");

    assert.deepEqual(result, { synced: true });
    const otherFileContent = await readFile(path.join(vaultRoot, "other.md"), "utf-8");
    assert.equal(otherFileContent, "from other device");
  });
});

test("commitAndPush quarantines the write and resets to origin on a same-file conflict", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await writeFile(path.join(vaultRoot, "note.md"), "original\n");
    await commitAndPush(vaultRoot, "note.md", "seed note");
    await gitIn(otherClone, ["pull"]);

    await writeFile(path.join(otherClone, "note.md"), "edited on other device\n");
    await gitIn(otherClone, ["add", "."]);
    await gitIn(otherClone, ["commit", "-m", "other device edits note"]);
    await gitIn(otherClone, ["push", "origin", "main"]);

    await writeFile(path.join(vaultRoot, "note.md"), "edited on this device\n");
    const result = await commitAndPush(vaultRoot, "note.md", "this device edits note");

    assert.equal(result.synced, false);
    assert.equal(result.conflict, true);
    assert.ok(result.conflictPath?.includes("note.claude-conflict."));

    const resolvedContent = await readFile(path.join(vaultRoot, "note.md"), "utf-8");
    assert.equal(resolvedContent, "edited on other device\n");

    const quarantined = await readFile(path.join(vaultRoot, result.conflictPath!), "utf-8");
    assert.equal(quarantined, "edited on this device\n");

    // the quarantine commit itself must have reached origin too, not just the local repo
    const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "--oneline"]);
    assert.match(stdout, /conflict: quarantined/);
  });
});

test("commitAndPush treats an unreachable remote as a plain sync failure, not a conflict", async () => {
  await withGitFixture(async (vaultRoot) => {
    await writeFile(path.join(vaultRoot, "note.md"), "hello");
    await commitAndPush(vaultRoot, "note.md", "seed note");

    // Breaks the fetch step of the later `pull --rebase` before any rebase can start - this must
    // not be treated the same as a real same-file conflict (no rebase-apply/rebase-merge marker
    // ever gets created, so there is nothing to `git rebase --abort`).
    await gitIn(vaultRoot, ["remote", "set-url", "origin", "https://example.invalid/nonexistent.git"]);

    await writeFile(path.join(vaultRoot, "note.md"), "changed while remote is unreachable");
    const result = await commitAndPush(vaultRoot, "note.md", "network failure test");

    assert.equal(result.synced, false);
    assert.equal(result.conflict, undefined);

    const log = await gitIn(vaultRoot, ["log", "--oneline", "-1"]);
    assert.match(log.stdout, /network failure test/);
  });
});

test("pullBestEffort never throws against a directory that isn't a git repo", async () => {
  await withTempVault(async (vaultRoot) => {
    await assert.doesNotReject(() => pullBestEffort(vaultRoot));
  });
});

test("commitAndPush never throws against a directory that isn't a git repo", async () => {
  await withTempVault(async (vaultRoot) => {
    await writeFile(path.join(vaultRoot, "note.md"), "hello");
    const result = await commitAndPush(vaultRoot, "note.md", "add note");
    assert.equal(result.synced, false);
  });
});
