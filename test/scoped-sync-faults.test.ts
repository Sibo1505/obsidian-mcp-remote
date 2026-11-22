// Scoped writes when a Git step fails on the server itself, by fault injection: chosen git calls
// fail (once, or until switched off). The rest is real Git as in scoped-sync.test.ts. The
// injection is in place before the server's modules load, so it reaches every git call they make.
import assert from "node:assert/strict";
import { test } from "node:test";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

type Rule = { match: (args: string[]) => boolean; times: number; silent?: boolean };
let rules: Rule[] = [];
/** Makes the next `times` git calls matching `match` fail (Infinity: until clearFaults). */
const failGit = (match: (args: string[]) => boolean, times = 1) => rules.push({ match, times });
/** Makes matching git calls report success without doing anything (a silent failure). */
const ignoreGit = (match: (args: string[]) => boolean, times = 1) => rules.push({ match, times, silent: true });
const clearFaults = () => {
  rules = [];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const realExecFile: Any = cp.execFile;
const realCustom = realExecFile[promisify.custom];
const patched: Any = function (this: unknown, ...rest: unknown[]) {
  return realExecFile.apply(this, rest);
};
patched[promisify.custom] = (file: string, args: string[], opts: unknown) => {
  const rule = file === "git" ? rules.find((r) => r.times > 0 && r.match(args)) : undefined;
  if (rule) {
    rule.times -= 1;
    if (rule.silent) return Promise.resolve({ stdout: "", stderr: "" });
    return Promise.reject(Object.assign(new Error(`injected failure: git ${args.join(" ")}`), { code: 1 }));
  }
  return realCustom(file, args, opts);
};
(cp as Any).execFile = patched;
syncBuiltinESMExports();

const { gitIn, makeTestConfig, withGitFixture } = await import("./helpers.js");
const { createApp } = await import("../src/app.js");
const { callTool, makeScopedToken, mcpRequest, withScopedServer } = await import("./scoped-helpers.js");

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
const wholeVault = () => makeScopedToken({ writeDir: "", writeDeny: ["rules"], readDeny: [] });
const json = (text: string) => JSON.parse(text) as Record<string, unknown>;
const exists = (target: string) => access(target).then(() => true, () => false);
const unpushed = async (repo: string) => (await gitIn(repo, ["log", "--format=%s", "origin/main..HEAD"])).stdout.trim();
const status = async (repo: string) => (await gitIn(repo, ["status", "--porcelain"])).stdout;
const is = (...words: string[]) => (args: string[]) => words.every((word, i) => args[i] === word);

async function moveOnOtherDevice(otherClone: string, from: string, to: string): Promise<string> {
  await gitIn(otherClone, ["pull", "--no-rebase"]);
  await mkdir(path.dirname(path.join(otherClone, to)), { recursive: true });
  await gitIn(otherClone, ["mv", from, to]);
  await gitIn(otherClone, ["commit", "-m", "other device moves the note"]);
  await gitIn(otherClone, ["push", "origin", "main"]);
  return readFile(path.join(otherClone, to), "utf-8");
}

async function withMainServer(vaultRoot: string, fn: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<void>) {
  const stores = await mkdtemp(path.join(tmpdir(), "main-stores-"));
  const config = makeTestConfig(vaultRoot, {
    OAUTH_STORE_PATH: path.join(stores, "oauth-store.json"),
    WEBAUTHN_STORE_PATH: path.join(stores, "webauthn-credential.json"),
  });
  const server = createApp(config).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(async (name, args) => {
      const res = await mcpRequest(url, config.TOKEN_INTERNAL, "tools/call", { name, arguments: args }, { "X-Forwarded-For": "100.64.0.10" });
      return (res.body as { result: { content: { text: string }[] } }).result.content[0].text;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stores, { recursive: true, force: true });
  }
}

test("S6: undoing the rejected commit fails once: the retry drops it, then the copy goes out alone", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await moveOnOtherDevice(otherClone, "inbox/idea.md", "rules/idea.md");
        failGit(is("reset", "--soft"));
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        clearFaults();
        assert.equal(result.conflict, true, JSON.stringify(result));
        assert.match(String(result.conflictPath), /^inbox\/idea-conflict-\d{14}\.md$/);
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved);
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("S6, always: undoing never works: no copy, nothing pushed, held back until undoing works again", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl, logs }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await moveOnOtherDevice(otherClone, "inbox/idea.md", "rules/idea.md");
        failGit(is("reset", "--soft"), Infinity);
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        assert.deepEqual({ heldBack: result.heldBack, saved: result.saved, conflictPath: result.conflictPath }, { heldBack: true, saved: false, conflictPath: undefined });
        // Still failing: a further scoped write is refused, nothing goes out.
        const next = await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" });
        assert.equal(next.isError, true, next.text);
        assert.match(next.text, /holds back an earlier change/);
        assert.ok(logs.some((l) => l.endsWith("result=denied:held-back")));
        clearFaults();

        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved);
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("S7: the commit fails and unstaging fails too: the change stays held back in the index and the main port does not commit it", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        const hook = path.join(vaultRoot, ".git", "hooks", "pre-commit");
        await writeFile(hook, "#!/bin/sh\nexit 1\n");
        await chmod(hook, 0o755);
        failGit(is("rm", "--cached"), Infinity);
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/s7.md", content: "# S7-TOKEN\n" })).text);
        assert.deepEqual({ written: result.written, heldBack: result.heldBack }, { written: false, heldBack: true });
        assert.match(await status(vaultRoot), /^A {2}inbox\/s7\.md$/m);
        await rm(hook, { force: true });

        await withMainServer(vaultRoot, async (call) => {
          // Held back: the main port's commit would take the whole index, so it does not commit.
          assert.deepEqual(json(await call("vault_write", { path: "main.md", content: "# main\n" })), { path: "main.md", written: true, synced: false });
          clearFaults();
          assert.equal(json(await call("vault_write", { path: "main.md", content: "# main\n" })).synced, true);
        });
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await exists(path.join(otherClone, "inbox", "s7.md")), false);
        assert.equal(await readFile(path.join(otherClone, "main.md"), "utf-8"), "# main\n");
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("rev-parse fails right after the commit: the commit is still recognized and dropped", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        const away = path.join(path.dirname(vaultRoot), "origin.git");
        // The pull fails (remote away), so the commit must be undone; the rev-parse after it failed.
        await import("node:fs/promises").then((fs) => fs.rename(away, `${away}.away`));
        failGit(is("rev-parse", "HEAD"), 1);
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/n.md", content: "x\n" })).text);
        clearFaults();
        await import("node:fs/promises").then((fs) => fs.rename(`${away}.away`, away));
        assert.deepEqual({ saved: result.saved, heldBack: result.heldBack }, { saved: false, heldBack: undefined });
        assert.equal(await unpushed(vaultRoot), "");
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("rebase --abort fails after a real conflict: held back, and the next write aborts the rebase and drops it", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        await gitIn(otherClone, ["pull", "--no-rebase"]);
        await writeFile(path.join(otherClone, "inbox", "idea.md"), "---\nsource: test-agent\n---\nedited on another device\n");
        await gitIn(otherClone, ["commit", "-am", "other device edits"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        failGit(is("rebase", "--abort"), Infinity); // every try fails; a single failure is retried (N2, once)
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: "# mine\n" })).text);
        assert.equal(result.heldBack, true, JSON.stringify(result));
        clearFaults();

        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/other.md", content: "x\n" })).text).synced, true);
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "inbox", "idea.md"), "utf-8"), "---\nsource: test-agent\n---\nedited on another device\n");
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("I-19: when git status fails, the client gets a fixed text and the log gets Git's message", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl, logs }) => {
        failGit(is("status", "--porcelain"), 1);
        const result = await callTool(baseUrl, "vault_write", { path: "inbox/n.md", content: "x\n" });
        clearFaults();
        assert.equal(result.isError, true);
        assert.equal(result.text, "Not written: the server could not check its Git state; try again later");
        assert.ok(logs.some((l) => l.includes("git status failed") && l.includes("injected failure")), JSON.stringify(logs));
        assert.equal(await exists(path.join(vaultRoot, "inbox", "n.md")), false);
      },
      { vaultRoot },
    );
  });
});

test("S7, silent: unstaging reports success but does nothing: the check afterwards notices, and the change is held back", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        const hook = path.join(vaultRoot, ".git", "hooks", "pre-commit");
        await writeFile(hook, "#!/bin/sh\nexit 1\n");
        await chmod(hook, 0o755);
        ignoreGit(is("rm", "--cached"), Infinity);
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/s7.md", content: "# S7-TOKEN\n" })).text);
        assert.equal(result.heldBack, true, JSON.stringify(result));
        // The file is back to before; the index still holds the token's version (the silent step).
        assert.match(await status(vaultRoot), /^AD inbox\/s7\.md$/m);
        await rm(hook, { force: true });
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "main.md", content: "# main\n" })).synced, false);
          clearFaults();
          assert.equal(json(await call("vault_write", { path: "main.md", content: "# main\n" })).synced, true);
        });
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await exists(path.join(otherClone, "inbox", "s7.md")), false);
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

// --- round 9 (F-13, F-14, F-15) ---

test("N1i: putting back fails once after the rebase moved the change: the retry puts back the moved path too", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await moveOnOtherDevice(otherClone, "inbox/idea.md", "rules/idea.md");
        failGit(is("restore"), 1);
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        clearFaults();
        assert.equal(result.conflict, true, JSON.stringify(result));
        assert.match(String(result.conflictPath), /^inbox\/idea-conflict-\d{14}\.md$/);
        assert.equal(await status(vaultRoot), "");
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "main.md", content: "# main\n" })).synced, true);
        });
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved);
      },
      { vaultRoot },
    );
  });
});

test("N1u: putting back fails once without a move: the retry finishes it, a plain not-saved and nothing held back", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        const hook = path.join(path.dirname(vaultRoot), "origin.git", "hooks", "pre-receive");
        await writeFile(hook, "#!/bin/sh\nexit 1\n");
        await chmod(hook, 0o755);
        failGit(is("restore"), 1);
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        clearFaults();
        await rm(hook, { force: true });
        assert.deepEqual({ saved: result.saved, heldBack: result.heldBack }, { saved: false, heldBack: undefined });
        assert.equal(await status(vaultRoot), "");
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

/** A real conflict: the other device edits the note the token is about to change. */
async function conflictOnOtherDevice(otherClone: string): Promise<string> {
  await gitIn(otherClone, ["pull", "--no-rebase"]);
  const text = "---\nsource: test-agent\n---\nedited on another device\n";
  await writeFile(path.join(otherClone, "inbox", "idea.md"), text);
  await gitIn(otherClone, ["commit", "-am", "other device edits"]);
  await gitIn(otherClone, ["push", "origin", "main"]);
  return text;
}

test("N2, once: rebase --abort fails once after a real conflict: the retry works and the copy goes out as usual", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        await conflictOnOtherDevice(otherClone);
        failGit(is("rebase", "--abort"), 1);
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: "# mine\n" })).text);
        clearFaults();
        assert.equal(result.conflict, true, JSON.stringify(result));
        assert.match(String(result.conflictPath), /^inbox\/idea-conflict-\d{14}\.md$/);
        assert.equal(await unpushed(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("N2: the rebase stays after a real conflict; the main port's new note survives the cleanup and reaches the remote", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: IDEA })).text).synced, true);
        const theirs = await conflictOnOtherDevice(otherClone);
        failGit(is("rebase", "--abort"), Infinity);
        const result = json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: "# mine\n" })).text);
        clearFaults();
        assert.equal(result.heldBack, true, JSON.stringify(result));

        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "main-n2.md", content: "# main N2\n" })).synced, true);
        });
        assert.equal(await readFile(path.join(vaultRoot, "main-n2.md"), "utf-8"), "# main N2\n");
        assert.equal(await status(vaultRoot), "");
        assert.equal(await unpushed(vaultRoot), "");
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "main-n2.md"), "utf-8"), "# main N2\n");
        assert.equal(await readFile(path.join(otherClone, "inbox", "idea.md"), "utf-8"), theirs);
      },
      { vaultRoot },
    );
  });
});

test("N3b: a staged new note held back, and the main port writes the same bytes there: its write is kept and pushed", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        const hook = path.join(vaultRoot, ".git", "hooks", "pre-commit");
        await writeFile(hook, "#!/bin/sh\nexit 1\n");
        await chmod(hook, 0o755);
        failGit(is("rm", "--cached"), Infinity);
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/s7.md", content: "# S7-TOKEN\n" })).text).heldBack, true);
        await rm(hook, { force: true });
        clearFaults();
        const onDisk = await readFile(path.join(vaultRoot, "inbox", "s7.md"), "utf-8");
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "inbox/s7.md", content: onDisk })).synced, true);
        });
        assert.equal(await readFile(path.join(vaultRoot, "inbox", "s7.md"), "utf-8"), onDisk);
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "inbox", "s7.md"), "utf-8"), onDisk);
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("owner marks end with the main port's commit: a later held-back change of the token on that path is still cleaned up", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [makeScopedToken({ writeDir: "", writeDeny: ["rules"], readDeny: [], modifyExisting: "any" })],
      async ({ baseUrl }) => {
        const hook = path.join(vaultRoot, ".git", "hooks", "pre-commit");
        const commitsFail = async (...undoStep: string[]) => {
          await writeFile(hook, "#!/bin/sh\nexit 1\n");
          await chmod(hook, 0o755);
          failGit(is(...undoStep), Infinity);
        };
        const commitsWork = async () => {
          await rm(hook, { force: true });
          clearFaults();
        };
        await commitsFail("rm", "--cached");
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/s7.md", content: "# S7\n" })).text).heldBack, true);
        await withMainServer(vaultRoot, async (call) => {
          // Held back: the owner's write of inbox/p.md is staged and marked as the owner's.
          assert.equal(json(await call("vault_write", { path: "inbox/p.md", content: "# owner\n" })).synced, false);
          await commitsWork();
          // A token write cleans up first (then it is refused: the owner's staged write is open),
          // so the main port's next write finds nothing left but its own mark.
          const busy = await callTool(baseUrl, "vault_write", { path: "inbox/x.md", content: "x\n" });
          assert.match(busy.text, /not committed yet/);
          assert.equal(json(await call("vault_write", { path: "inbox/q.md", content: "# q\n" })).synced, true);
        });
        // Later the token writes inbox/p.md and is held back again; the owner's mark must be gone.
        await commitsFail("restore"); // inbox/p.md is committed now: undoing puts it back with restore
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/p.md", content: "# TOKEN-WAS-HERE\n" })).text).heldBack, true);
        await commitsWork();
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "inbox/r.md", content: "# r\n" })).synced, true);
        });
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "inbox", "p.md"), "utf-8"), "# owner\n");
        assert.equal((await gitIn(otherClone, ["log", "-GTOKEN-WAS-HERE", "--format=%h"])).stdout.trim(), "");
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});

test("N2r: a read aborts the rebase left half-way and keeps a file another writer changed meanwhile", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        await conflictOnOtherDevice(otherClone);
        failGit(is("rebase", "--abort"), Infinity);
        assert.equal(json((await callTool(baseUrl, "vault_write", { path: "inbox/idea.md", content: "# mine\n" })).text).heldBack, true);
        clearFaults();
        // The main port writes outside the git lock (I-14): its change is on disk before it commits.
        await writeFile(path.join(vaultRoot, "inbox", "keep.md"), "# changed by the main port\n");
        await withMainServer(vaultRoot, async (call) => {
          await call("vault_read", { path: "inbox/keep.md" });
        });
        assert.equal(await readFile(path.join(vaultRoot, "inbox", "keep.md"), "utf-8"), "# changed by the main port\n");
        assert.equal(await import("node:fs/promises").then((fs) => fs.access(path.join(vaultRoot, ".git", "rebase-merge")).then(() => true, () => false)), false);
      },
      { vaultRoot },
    );
  });
});

test("N1s: putting back the moved path reports success but does nothing: the check of every path notices, held back", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [wholeVault()],
      async ({ baseUrl }) => {
        for (const note of ["inbox/idea.md", "inbox/keep.md"]) {
          assert.equal(json((await callTool(baseUrl, "vault_write", { path: note, content: IDEA })).text).synced, true);
        }
        const moved = await moveOnOtherDevice(otherClone, "inbox/idea.md", "rules/idea.md");
        ignoreGit(is("restore"), Infinity);
        const result = json((await callTool(baseUrl, "vault_patch", { ...APPEND, path: "inbox/idea.md" })).text);
        clearFaults();
        assert.equal(result.heldBack, true, JSON.stringify(result));
        await withMainServer(vaultRoot, async (call) => {
          assert.equal(json(await call("vault_write", { path: "main.md", content: "# main\n" })).synced, true);
        });
        await gitIn(otherClone, ["pull", "--no-rebase", "--no-edit"]);
        assert.equal(await readFile(path.join(otherClone, "rules", "idea.md"), "utf-8"), moved);
        assert.equal(await status(vaultRoot), "");
      },
      { vaultRoot },
    );
  });
});
