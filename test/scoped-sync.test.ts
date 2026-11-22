// How a scoped write reaches the remote, with real Git: a bare remote, the server's clone behind
// the scoped listener (and the main listener where a test needs it), and a second clone as another
// device. A scoped write commits only its own note, never deletes what another writer left
// behind, and never leaves a commit behind that has not been checked against the state it goes
// out with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { gitIn, makeTestConfig, withGitFixture } from "./helpers.js";
import { createApp } from "../src/app.js";
import { enforceFrontmatter } from "../src/scoped/enforce.js";
import type { ScopedToken } from "../src/scoped/config.js";
import { callTool, makeScopedToken, mcpRequest, withScopedServer } from "./scoped-helpers.js";

const patchDefaults = {
  contentType: "text/markdown",
  createTargetIfMissing: false,
  trimTargetWhitespace: false,
  rejectIfContentPreexists: false,
  targetScope: "content",
  targetDelimiter: "::",
};

const IDEA = "# Idea\n\nfirst thoughts\n\nmore thoughts\n\n## Log\n- one\n- two\n- three\n\n## End\nlast line\n";
const APPEND = { ...patchDefaults, targetType: "heading", target: "Idea::Log", operation: "append", content: "- TOKEN-WAS-HERE" };

/** The whole vault, "own", with a writeDeny folder the other device may move a note into. */
const wholeVault = (overrides: Partial<ScopedToken> = {}): ScopedToken =>
  makeScopedToken({ writeDir: "", writeDeny: ["rules"], readDeny: [], ...overrides });

const exists = (target: string) => access(target).then(() => true, () => false);

/** Commits on the server that the remote does not have, newest first. */
async function unpushed(repo: string): Promise<string> {
  return (await gitIn(repo, ["log", "--format=%s", "origin/main..HEAD"])).stdout.trim();
}

/** Tracked and untracked changes in the server's checkout. */
async function status(repo: string): Promise<string> {
  return (await gitIn(repo, ["status", "--porcelain"])).stdout;
}

/** Makes the remote unreachable; the returned function brings it back. */
async function remoteAway(repo: string): Promise<() => Promise<void>> {
  const origin = path.join(path.dirname(repo), "origin.git");
  await rename(origin, `${origin}.away`);
  return () => rename(`${origin}.away`, origin);
}

/** A Git hook that fails; the returned function removes it. */
async function failingHook(gitDir: string, name: string): Promise<() => Promise<void>> {
  const hook = path.join(gitDir, "hooks", name);
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  return () => rm(hook, { force: true });
}

/** The other device pulls, changes `notePath` (takes it over and/or moves it) and pushes. */
async function otherDevice(
  otherClone: string,
  notePath: string,
  change: { removeFields: boolean; moveTo?: string },
): Promise<{ finalPath: string; text: string }> {
  await gitIn(otherClone, ["pull", "--no-rebase"]);
  const finalPath = change.moveTo ?? notePath;
  let text = await readFile(path.join(otherClone, notePath), "utf-8");
  if (change.removeFields) text = text.replace("source: test-agent\n", "owner: person\n");
  if (change.moveTo) {
    await mkdir(path.dirname(path.join(otherClone, change.moveTo)), { recursive: true });
    await gitIn(otherClone, ["mv", notePath, change.moveTo]);
  }
  await writeFile(path.join(otherClone, finalPath), text);
  await gitIn(otherClone, ["add", "-A"]);
  await gitIn(otherClone, ["commit", "-m", "other device changes the note"]);
  await gitIn(otherClone, ["push", "origin", "main"]);
  return { finalPath, text };
}

async function pullOther(otherClone: string): Promise<void> {
  await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
}

type MainCall = (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;

/** The main listener (TOKEN_INTERNAL) on the same checkout. */
async function withMainServer(vaultRoot: string, fn: (call: MainCall) => Promise<void>): Promise<void> {
  const stores = await mkdtemp(path.join(tmpdir(), "main-stores-"));
  const config = makeTestConfig(vaultRoot, {
    OAUTH_STORE_PATH: path.join(stores, "oauth-store.json"),
    WEBAUTHN_STORE_PATH: path.join(stores, "webauthn-credential.json"),
  });
  const server = createApp(config).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: MainCall = async (name, args) => {
    const res = await mcpRequest(url, config.TOKEN_INTERNAL, "tools/call", { name, arguments: args }, {
      "X-Forwarded-For": "100.64.0.10",
    });
    const result = (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
    return { isError: result.isError, text: result.content[0].text };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stores, { recursive: true, force: true });
  }
}

const json = (text: string) => JSON.parse(text) as Record<string, unknown>;

// --- what a scoped commit may contain (F-3) ---

test("R1: a change another writer left in the index is never swept into the token's commit or deleted", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl, logs }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        await writeFile(path.join(vaultRoot, "staged.md"), "# staged by another writer\n");
        await gitIn(vaultRoot, ["add", "staged.md"]);

        const result = await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" });
        assert.equal(result.isError, true, result.text);
        assert.match(result.text, /not committed yet; try again/);
        assert.ok(logs.some((l) => l.endsWith("result=denied:vault-busy")), JSON.stringify(logs));
        // Everything as the other writer left it, and nothing of the token's.
        assert.equal(await readFile(path.join(vaultRoot, "staged.md"), "utf-8"), "# staged by another writer\n");
        assert.equal((await gitIn(vaultRoot, ["diff", "--cached", "--name-only"])).stdout.trim(), "staged.md");
        assert.doesNotMatch(await readFile(path.join(vaultRoot, "inbox", "idea.md"), "utf-8"), /TOKEN-WAS-HERE/);
        assert.equal(await unpushed(vaultRoot), "");

        // A file Git does not track at the very path: the token does not take it over either.
        await writeFile(path.join(vaultRoot, "inbox", "loose.md"), "# not tracked\n");
        await gitIn(vaultRoot, ["commit", "-m", "the other writer commits", "--", "staged.md"]);
        const loose = await callTool(baseUrl, "vault_write", { path: "inbox/loose.md", content: "x\n" });
        assert.equal(loose.isError, true, loose.text);
        assert.match(loose.text, /a file that Git does not track/);
        assert.equal(await readFile(path.join(vaultRoot, "inbox", "loose.md"), "utf-8"), "# not tracked\n");
      },
      { vaultRoot },
    );
  });
});

test("R4: a write whose commit fails is undone and reported as not saved; the next write is a normal one", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        const restore = await failingHook(path.join(vaultRoot, ".git"), "pre-commit");
        const first = json((await callTool(baseUrl, "vault_write", { path: "inbox/first.md", content: "# first\n" })).text);
        assert.deepEqual(
          { written: first.written, synced: first.synced, saved: first.saved, conflict: first.conflict },
          { written: false, synced: false, saved: false, conflict: undefined },
        );
        assert.match(String(first.note), /was not saved: the server could not commit it/);
        assert.equal(await exists(path.join(vaultRoot, "inbox", "first.md")), false);
        assert.equal(await status(vaultRoot), "");
        await restore();

        const second = await callTool(baseUrl, "vault_write", { path: "inbox/second.md", content: "# second\n" });
        assert.deepEqual(json(second.text), { path: "inbox/second.md", written: true, synced: true });
        await pullOther(otherClone);
        assert.equal(await exists(path.join(otherClone, "inbox", "second.md")), true);
        assert.equal(await exists(path.join(otherClone, "inbox", "first.md")), false);
      },
      { vaultRoot },
    );
  });
});

// --- a commit that cannot go out right away is dropped (SEC-024, F-4) ---

test("B2+/R2b: a patch while the remote is away is not kept; a later write cannot carry it into a moved note", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const back = await remoteAway(vaultRoot);
        const patched = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual({ patched: patched.patched, synced: patched.synced, saved: patched.saved }, { patched: false, synced: false, saved: false });
        assert.match(String(patched.note), /was not saved/);
        assert.equal(await unpushed(vaultRoot), "");
        assert.equal(await status(vaultRoot), "");
        assert.doesNotMatch(await readFile(path.join(vaultRoot, "inbox", "idea.md"), "utf-8"), /TOKEN-WAS-HERE/);
        await back();

        const moved = await otherDevice(otherClone, "inbox/idea.md", { removeFields: false, moveTo: "rules/idea.md" });
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await withMainServer(vaultRoot, async (call) => {
          const main = await call("vault_write", { path: "main.md", content: "# main\n" });
          assert.equal(main.isError, undefined, main.text);
        });
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved.text);
        const log = (await gitIn(otherClone, ["log", "--format=%s"])).stdout;
        assert.doesNotMatch(log, /vault_patch inbox\/idea\.md/);
      },
      { vaultRoot },
    );
  });
});

test("B3+: a patch whose push is refused after the check is not kept either", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const allow = await failingHook(path.join(path.dirname(vaultRoot), "origin.git"), "pre-receive");
        const patched = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual({ synced: patched.synced, saved: patched.saved }, { synced: false, saved: false });
        assert.equal(await unpushed(vaultRoot), "");
        assert.equal(await status(vaultRoot), "");
        await allow();

        const moved = await otherDevice(otherClone, "inbox/idea.md", { removeFields: false, moveTo: "rules/idea.md" });
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved.text);
      },
      { vaultRoot },
    );
  });
});

test("B6/R5: with the vault in a subfolder of the repository, a rejected change becomes a copy and never stays on HEAD", async () => {
  await withGitFixture(async (repo, otherClone) => {
    const vaultRoot = path.join(repo, "vault");
    await mkdir(vaultRoot, { recursive: true });
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/keep.md", content: IDEA })).text).synced, true);
        const adopted = await otherDevice(otherClone, "vault/inbox/idea.md", { removeFields: true });

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.equal(result.conflict, true, JSON.stringify(result));
        assert.match(String(result.conflictPath), /^inbox\/idea-conflict-\d{14}\.md$/);
        assert.equal(await unpushed(repo), "");

        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, adopted.finalPath), "utf-8"), adopted.text);
        assert.match(await readFile(path.join(otherClone, "vault", String(result.conflictPath)), "utf-8"), /TOKEN-WAS-HERE/);
      },
      { vaultRoot },
    );
  });
});

// --- what the drop keeps (F-6) and what the main port does (as before) ---

test("R3: an older unpushed commit of the main port survives a rejected scoped change and reaches the remote", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/keep.md", content: IDEA })).text).synced, true);
        await withMainServer(vaultRoot, async (call) => {
          const back = await remoteAway(vaultRoot);
          assert.equal(json((await call("vault_write", { path: "older.md", content: "# older\n" })).text).synced, false);
          await back();
        });
        assert.equal(await unpushed(vaultRoot), "vault_write: older.md");
        const adopted = await otherDevice(otherClone, "inbox/idea.md", { removeFields: true });

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.equal(result.conflict, true, JSON.stringify(result));
        assert.match(String(result.conflictPath), /^inbox\/idea-conflict-\d{14}\.md$/);
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "older.md"), "utf-8"), "# older\n");
        assert.equal(await readFile(path.join(otherClone, "inbox", "idea.md"), "utf-8"), adopted.text);
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("the rebase dropped the token's commit (the remote already had that change): nothing to check, synced as before", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        // The other device writes exactly what the token's next write produces, and pushes first.
        const next = "# Idea\n\nrewritten\n";
        await gitIn(otherClone, ["pull", "--no-rebase"]);
        await writeFile(
          path.join(otherClone, "inbox", "idea.md"),
          enforceFrontmatter(next, { source: "test-agent" }, ["scoped"], "inbox/idea.md"),
        );
        await gitIn(otherClone, ["commit", "-am", "other device writes the same text"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        const result = await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: next });
        assert.deepEqual(json(result.text), { path: "inbox/idea.md", written: true, synced: true });
        assert.equal(await unpushed(vaultRoot), "");
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("main listener: a write while the remote is away stays committed and goes out with the next sync, as before", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withMainServer(vaultRoot, async (call) => {
      assert.equal(json((await call("vault_write", { path: "a.md", content: "# a\n" })).text).synced, true);
      const back = await remoteAway(vaultRoot);
      assert.deepEqual(json((await call("vault_write", { path: "older.md", content: "# older\n" })).text), {
        path: "older.md",
        written: true,
        synced: false,
      });
      assert.equal(await unpushed(vaultRoot), "vault_write: older.md");
      assert.equal(await readFile(path.join(vaultRoot, "older.md"), "utf-8"), "# older\n");

      // A scoped write during the outage drops only itself.
      await withScopedServer(
        [wholeVault()],
        async ({ baseUrl }) => {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/n.md", content: "x\n" })).text).saved, false);
          assert.equal(await unpushed(vaultRoot), "vault_write: older.md");
          assert.equal(await readFile(path.join(vaultRoot, "older.md"), "utf-8"), "# older\n");
          await back();
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/n.md", content: "x\n" })).text).synced, true);
        },
        { vaultRoot },
      );
      assert.equal(json((await call("vault_write", { path: "b.md", content: "# b\n" })).text).synced, true);
    });
    await pullOther(otherClone);
    for (const note of ["a.md", "older.md", "b.md", "inbox/n.md"]) {
      assert.equal(await exists(path.join(otherClone, note)), true, note);
    }
    const log = (await gitIn(otherClone, ["log", "--format=%s"])).stdout.trim().split("\n");
    assert.deepEqual(log.slice(0, 4), ["vault_write: b.md", "test-agent: vault_write inbox/n.md", "vault_write: older.md", "vault_write: a.md"]);
  });
});

test("I-18: when the push fails and HEAD is not the token's commit, nothing is dropped (an older main-port commit stays)", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        await withMainServer(vaultRoot, async (call) => {
          const back = await remoteAway(vaultRoot);
          assert.equal(json((await call("vault_write", { path: "older.md", content: "# older\n" })).text).synced, false);
          await back();
        });
        // The remote already gets exactly the token's next version, so the rebase drops the token's
        // commit; the main port's older commit then sits on top and the push is refused.
        const next = "# Idea\n\nrewritten\n";
        await gitIn(otherClone, ["pull", "--no-rebase"]);
        await writeFile(
          path.join(otherClone, "inbox", "idea.md"),
          enforceFrontmatter(next, { source: "test-agent" }, ["scoped"], "inbox/idea.md"),
        );
        await gitIn(otherClone, ["commit", "-am", "other device writes the same text"]);
        await gitIn(otherClone, ["push", "origin", "main"]);
        const allow = await failingHook(path.join(path.dirname(vaultRoot), "origin.git"), "pre-receive");

        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: next })).text);
        assert.deepEqual({ synced: result.synced, saved: result.saved }, { synced: false, saved: false });
        assert.equal(await unpushed(vaultRoot), "vault_write: older.md");
        assert.equal(await readFile(path.join(vaultRoot, "older.md"), "utf-8"), "# older\n");
        await allow();
      },
      { vaultRoot },
    );
  });
});

test("dropping touches only the token's note: a file another writer changes while the write runs stays changed", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "other.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        // Stands in for the main port, which writes outside the git lock: while the token's push
        // runs, another writer changes a tracked file, then the push is refused.
        const other = path.join(vaultRoot, "other.md").split(path.sep).join("/");
        const hook = path.join(path.dirname(vaultRoot), "origin.git", "hooks", "pre-receive");
        await writeFile(hook, `#!/bin/sh\nprintf 'changed meanwhile\n' > '${other}'\nexit 1\n`);
        await chmod(hook, 0o755);

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual({ synced: result.synced, saved: result.saved }, { synced: false, saved: false });
        assert.equal(await readFile(path.join(vaultRoot, "other.md"), "utf-8"), "changed meanwhile\n");
        assert.doesNotMatch(await readFile(path.join(vaultRoot, "inbox", "idea.md"), "utf-8"), /TOKEN-WAS-HERE/);
        assert.equal(await status(vaultRoot), " M other.md\n");
        assert.equal(await unpushed(vaultRoot), "");
        await rm(hook, { force: true });
      },
      { vaultRoot },
    );
  });
});

// --- when undoing fails too (F-8, SEC-025): the change is held back, nothing takes it out ---

/** Locks the server's branch ref, as another (or a crashed) Git process would: undoing then fails. */
const lockRef = (repo: string) => path.join(repo, ".git", "refs", "heads", "main.lock");
const sh = (file: string) => file.split(path.sep).join("/");

/** A hook that runs `body` (shell). The returned function removes it. */
async function hookWith(gitDir: string, name: string, body: string): Promise<() => Promise<void>> {
  const hook = path.join(gitDir, "hooks", name);
  await writeFile(hook, `#!/bin/sh\n${body}\n`);
  await chmod(hook, 0o755);
  return () => rm(hook, { force: true });
}

test("S8r: the push is refused and the ref is locked: the patch is held back, and no later push takes it out", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        const unhook = await hookWith(path.join(path.dirname(vaultRoot), "origin.git"), "pre-receive", `: > '${sh(lockRef(vaultRoot))}'\nexit 1`);

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual(
          { patched: result.patched, synced: result.synced, saved: result.saved, heldBack: result.heldBack },
          { patched: false, synced: false, saved: false, heldBack: true },
        );
        assert.match(String(result.note), /could not undo it either.*holds this change back/);
        await unhook();

        await withMainServer(vaultRoot, async (call) => {
          // While the lock is there, the main port neither commits nor pushes.
          assert.deepEqual(json((await call("vault_write", { path: "main.md", content: "# main\n" })).text), {
            path: "main.md",
            written: true,
            synced: false,
          });
          await pullOther(otherClone);
          assert.equal(await exists(path.join(otherClone, "main.md")), false);
          // The lock goes away: the next write clears the held-back change first, then syncs as before.
          await rm(lockRef(vaultRoot), { force: true });
          assert.equal(json((await call("vault_write", { path: "main.md", content: "# main\n" })).text).synced, true);
        });
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "main.md"), "utf-8"), "# main\n");
        assert.doesNotMatch(await readFile(path.join(otherClone, "inbox", "idea.md"), "utf-8"), /TOKEN-WAS-HERE/);
        assert.equal(await unpushed(vaultRoot), "");
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("S6r / C6 V1: a rejected change whose undo fails is held back, not copied; it never reaches the denied folder", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await otherDevice(otherClone, "inbox/idea.md", { removeFields: false, moveTo: "rules/idea.md" });
        // Right after the rebase the ref is locked, so dropping the rejected commit fails.
        const unhook = await hookWith(path.join(vaultRoot, ".git"), "post-rewrite", `: > '${sh(lockRef(vaultRoot))}'`);

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.equal(result.heldBack, true, JSON.stringify(result));
        assert.equal(result.conflictPath, undefined);
        assert.equal(await unpushed(vaultRoot), "test-agent: vault_patch inbox/idea.md");
        await unhook();
        await rm(lockRef(vaultRoot), { force: true });

        // The next scoped write and a main-port write: the held-back commit is dropped first.
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json((await call("vault_write", { path: "main.md", content: "# main\n" })).text).synced, true);
        });
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved.text);
        assert.doesNotMatch((await gitIn(otherClone, ["log", "--format=%s"])).stdout, /vault_patch inbox\/idea\.md/);
      },
      { vaultRoot },
    );
  });
});

test("C6 V2: a ref lock that a later commit would clear still never lets the copy go out on top of the rejected commit", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await otherDevice(otherClone, "inbox/idea.md", { removeFields: false, moveTo: "rules/idea.md" });
        const gitDir = path.join(vaultRoot, ".git");
        const unlock = await hookWith(gitDir, "post-rewrite", `: > '${sh(lockRef(vaultRoot))}'`);
        const unclear = await hookWith(gitDir, "pre-commit", `rm -f '${sh(lockRef(vaultRoot))}'`);

        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.equal(result.heldBack, true, JSON.stringify(result));
        // No copy was committed on top of the rejected commit, and nothing went out.
        assert.equal((await gitIn(vaultRoot, ["log", "-1", "--format=%s"])).stdout.trim(), "test-agent: vault_patch inbox/idea.md");
        await pullOther(otherClone);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved.text);
        await unlock();
        await unclear();
        await rm(lockRef(vaultRoot), { force: true });
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("after a restart: a token's commit left on the server (marked by its trailer) never goes out with the main port", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    // As if the server had stopped right after a scoped commit: nothing in memory knows about it.
    await mkdir(path.join(vaultRoot, "inbox"), { recursive: true });
    await writeFile(path.join(vaultRoot, "inbox", "crash.md"), "# TOKEN-WAS-HERE\n");
    await gitIn(vaultRoot, ["add", "inbox/crash.md"]);
    await gitIn(vaultRoot, ["commit", "-m", "test-agent: vault_write inbox/crash.md\n\nScoped-Token: test-agent"]);
    await withMainServer(vaultRoot, async (call) => {
      assert.equal(json((await call("vault_write", { path: "main.md", content: "# main\n" })).text).synced, true);
    });
    await pullOther(otherClone);
    assert.equal(await exists(path.join(otherClone, "inbox", "crash.md")), false);
    assert.equal(await exists(path.join(otherClone, "main.md")), true);
    assert.equal(await exists(path.join(vaultRoot, "inbox", "crash.md")), false);
  });
});

// --- small things (F-9, F-10, F-11) ---

test("S3: an ignored file at the target path is refused before anything is written", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        await writeFile(path.join(vaultRoot, ".gitignore"), "ignored.md\nignored/\n");
        await writeFile(path.join(vaultRoot, "ignored.md"), "# ignored, not tracked\n");
        const result = await callTool(baseUrl, "vault_write", { path: "ignored.md", content: "x\n" });
        assert.equal(result.isError, true, result.text);
        assert.match(result.text, /holds a file that Git does not track/);
        assert.equal(await readFile(path.join(vaultRoot, "ignored.md"), "utf-8"), "# ignored, not tracked\n");

        // F-10: an ignored path without a file: refused as well, with its own reason.
        const folder = await callTool(baseUrl, "vault_write", { path: "ignored/new.md", content: "x\n" });
        assert.equal(folder.isError, true, folder.text);
        assert.match(folder.text, /is ignored by Git/);
        assert.equal(await exists(path.join(vaultRoot, "ignored", "new.md")), false);
      },
      { vaultRoot },
    );
  });
});

test("S4: another writer changes the same note while the write is undone: that change stays", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        const note = sh(path.join(vaultRoot, "inbox", "idea.md"));
        const unhook = await hookWith(path.join(path.dirname(vaultRoot), "origin.git"), "pre-receive", `printf 'other writer\\n' > '${note}'\nexit 1`);
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual({ saved: result.saved, heldBack: result.heldBack }, { saved: false, heldBack: undefined });
        assert.equal(await readFile(path.join(vaultRoot, "inbox", "idea.md"), "utf-8"), "other writer\n");
        assert.equal(await status(vaultRoot), " M inbox/idea.md\n");
        assert.equal(await unpushed(vaultRoot), "");
        await unhook();
      },
      { vaultRoot },
    );
  });
});

test("F-9: vault-busy names how many paths are open and the first one in the server log, never to the client", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl, logs }) => {
        await writeFile(path.join(vaultRoot, "staged.md"), "# staged\n");
        await gitIn(vaultRoot, ["add", "staged.md"]);
        const result = await callTool(baseUrl, "vault_write", { path: "inbox/n.md", content: "x\n" });
        assert.equal(result.isError, true);
        assert.doesNotMatch(result.text, /staged\.md/);
        assert.ok(logs.some((l) => l.includes("vault-busy") && l.includes('pending=1 first="staged.md"')), JSON.stringify(logs));
      },
      { vaultRoot },
    );
  });
});
