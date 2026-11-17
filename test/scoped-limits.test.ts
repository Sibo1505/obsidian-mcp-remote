import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { gitIn, withGitFixture } from "./helpers.js";
import { WRITE_DIR, callTool, makeScopedToken, withScopedServer } from "./scoped-helpers.js";

// Resource limits of the scoped listener. A scoped client must not be able to stall the server
// process (and with it the main listener) with one expensive request. Each test measures how long
// the event loop of this process was blocked while the request ran.

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` and reports the longest event-loop block in the meantime, in milliseconds. Two
 * measurements, the larger one counts: the delay histogram (which only records from its first
 * sample on, so it can miss a block that starts right after enable()) and the longest gap between
 * the ticks of a 10 ms timer.
 */
async function measureBlock<T>(fn: () => Promise<T>): Promise<{ value: T; maxBlockMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lastTick = performance.now();
  let longestGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - lastTick);
    lastTick = now;
  }, 10);
  try {
    await pause(30);
    const value = await fn();
    // Let a block at the very end show up as a gap.
    await pause(30);
    return { value, maxBlockMs: Math.max(histogram.max / 1e6, longestGap - 10) };
  } finally {
    clearInterval(ticker);
    histogram.disable();
  }
}

test("measureBlock sees a block that starts right after it begins measuring", async () => {
  const { maxBlockMs } = await measureBlock(async () => {
    const until = Date.now() + 300;
    while (Date.now() < until) {
      // busy: the event loop is blocked for 300 ms
    }
  });
  assert.ok(maxBlockMs >= 250, `measured ${maxBlockMs} ms`);
});

const MAX_BLOCK_MS = 1000;

/** Front matter whose YAML aliases expand to 9^levels values (a "billion laughs" bomb), ~450 bytes. */
function aliasBomb(levels: number, key: string): string {
  let yaml = `l0: &l0 [${Array(9).fill('"aaaaaaaa"').join(",")}]\n`;
  for (let i = 1; i < levels; i++) yaml += `l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(",")}]\n`;
  yaml += `${key}: [*l${levels - 1}]\n`;
  return `---\n${yaml}---\nhello\n`;
}

async function plant(vaultRoot: string, relativePath: string, content: string) {
  await mkdir(path.dirname(path.join(vaultRoot, relativePath)), { recursive: true });
  await writeFile(path.join(vaultRoot, relativePath), content);
}

// --- search runs in a worker with a hard timeout ---

test("scoped search_query: a backtracking regexp is stopped by the hard timeout without blocking the server", async () => {
  await withScopedServer(
    [makeScopedToken()],
    async ({ baseUrl, vaultRoot, logs }) => {
      // ^(a|a)*$ passes safe-regex, but needs exponential time against "aaa…a!".
      await plant(vaultRoot, `${WRITE_DIR}/a-1.md`, "a".repeat(27) + "!");
      const { value: result, maxBlockMs } = await measureBlock(() =>
        callTool(baseUrl, "search_query", { query: { regexp: ["^(a|a)*$", { var: "content" }] } }),
      );
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /stopped/);
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
      assert.ok(logs.includes('scoped token=test-agent tool=search_query path="-" result=denied:search-limit'));
    },
    { app: { searchTimeoutMs: 3000 } },
  );
});

test("scoped search_query: only one search runs at a time; a second one is refused while the first runs", async () => {
  await withScopedServer(
    [makeScopedToken()],
    async ({ baseUrl, vaultRoot }) => {
      await plant(vaultRoot, `${WRITE_DIR}/a-1.md`, "a".repeat(27) + "!");
      const slow = callTool(baseUrl, "search_query", { query: { regexp: ["^(a|a)*$", { var: "content" }] } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await callTool(baseUrl, "search_query", { query: { "==": [1, 1] } });
      assert.equal(second.isError, true, second.text);
      assert.match(second.text, /Another search/);
      assert.equal((await slow).isError, true);
      // Once the first one is done, searching works again.
      const after = await callTool(baseUrl, "search_query", { query: { "==": [{ var: "path" }, `${WRITE_DIR}/a-1.md`] } });
      assert.equal(after.isError, false, after.text);
      assert.deepEqual(JSON.parse(after.text), [{ filename: `${WRITE_DIR}/a-1.md`, result: true }]);
    },
    { app: { searchTimeoutMs: 3000 } },
  );
});

test("scoped search_query: an alias bomb in tags ends in an error without blocking the server", async () => {
  await withScopedServer(
    [makeScopedToken()],
    async ({ baseUrl, vaultRoot }) => {
      await plant(vaultRoot, "elsewhere/bomb.md", aliasBomb(8, "tags"));
      const { value: result, maxBlockMs } = await measureBlock(() =>
        callTool(baseUrl, "search_query", { query: { "==": [1, 1] } }),
      );
      assert.equal(result.isError, true, result.text.slice(0, 200));
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
    },
    { app: { searchTimeoutMs: 3000 } },
  );
});

test("scoped search_query: ordinary searches still work through the worker", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    await plant(vaultRoot, "projects/a.md", "---\nstatus: done\n---\nA");
    await plant(vaultRoot, "projects/b.md", "---\nstatus: draft\n---\nB");
    const result = await callTool(baseUrl, "search_query", { query: { "==": [{ var: "frontmatter.status" }, "done"] } });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(JSON.parse(result.text), [{ filename: "projects/a.md", result: true }]);
    const unknown = await callTool(baseUrl, "search_query", { query: { no_such_operation: [1] } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unrecognized operation no_such_operation/);
  });
});

// --- heading lines (read and patch run in the main thread) ---

test("scoped vault_read and vault_patch of a heading in a note with 200 000 spaces do not block the server", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const note = `# ${" ".repeat(200_000)}a\rb\n`;
    assert.equal((await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/spaces.md`, content: note })).isError, false);
    const read = await measureBlock(() =>
      callTool(baseUrl, "vault_read", { path: `${WRITE_DIR}/spaces.md`, targetType: "heading", target: "x" }),
    );
    assert.match(read.value.text, /Heading not found/);
    assert.ok(read.maxBlockMs < MAX_BLOCK_MS, `read blocked ${read.maxBlockMs} ms`);
    const patch = await measureBlock(() =>
      callTool(baseUrl, "vault_patch", {
        path: `${WRITE_DIR}/spaces.md`,
        targetType: "heading",
        target: "x",
        operation: "append",
        content: "more",
        contentType: "text/markdown",
        createTargetIfMissing: false,
        trimTargetWhitespace: false,
        rejectIfContentPreexists: false,
        targetScope: "content",
        targetDelimiter: "::",
      }),
    );
    assert.match(patch.value.text, /Heading not found/);
    assert.ok(patch.maxBlockMs < MAX_BLOCK_MS, `patch blocked ${patch.maxBlockMs} ms`);
  });
});

// --- output limit for every scoped result ---

test("scoped vault_read: an alias bomb in front matter is refused as too large without blocking the server", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    await plant(vaultRoot, "elsewhere/bomb.md", aliasBomb(8, "x"));
    for (const args of [{ path: "elsewhere/bomb.md" }, { path: "elsewhere/bomb.md", targetType: "frontmatter", target: "x" }]) {
      const { value: result, maxBlockMs } = await measureBlock(() => callTool(baseUrl, "vault_read", args));
      assert.equal(result.isError, true, result.text.slice(0, 200));
      assert.match(result.text, /too large/);
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
    }
  });
});

test("scoped vault_read: a file over the output limit is refused before it is read", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await plant(vaultRoot, "attachments/big.pdf", "x".repeat(2 * 1024 * 1024 + 1));
    await plant(vaultRoot, "attachments/fits.md", "x".repeat(1024 * 1024));
    const big = await callTool(baseUrl, "vault_read", { path: "attachments/big.pdf" });
    assert.equal(big.isError, true);
    // Refused by its size on disk, not after reading it (that would say "Result too large").
    assert.match(big.text, /^File too large/);
    assert.ok(logs.includes('scoped token=test-agent tool=vault_read path="attachments/big.pdf" result=denied:too-large'));
    const fits = await callTool(baseUrl, "vault_read", { path: "attachments/fits.md" });
    assert.equal(fits.isError, false);
  });
});

// --- scoped writes refuse YAML aliases ---

test("scoped vault_write refuses front matter that reuses a list or mapping through a YAML alias", async () => {
  for (const token of [makeScopedToken(), makeScopedToken({ frontmatter: {}, tags: [] })]) {
    await withScopedServer([token], async ({ baseUrl }) => {
      const { value: bomb, maxBlockMs } = await measureBlock(() =>
        callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/bomb.md`, content: aliasBomb(8, "tags") }),
      );
      assert.equal(bomb.isError, true, bomb.text);
      assert.match(bomb.text, /alias/);
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);

      const small = "---\nbase: &base {a: 1}\nother: *base\n---\nBody\n";
      const smallResult = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/small.md`, content: small });
      assert.equal(smallResult.isError, true, smallResult.text);
      assert.match(smallResult.text, /alias/);
    });
  }
});

// One text anchor, used 20 000 times: 180 KB of YAML that passes the list/mapping alias check, but
// written out (or printed as JSON) it is 2 GB of text.
const TEXT_ALIAS_NOTE = `---\na: &x "${"A".repeat(100_000)}"\nb: [${Array(20_000).fill("*x").join(", ")}]\n---\nbody\n`;

test("scoped vault_write refuses front matter that repeats one text through an alias, without blocking the server", async () => {
  for (const token of [makeScopedToken(), makeScopedToken({ frontmatter: {}, tags: [] })]) {
    await withScopedServer([token], async ({ baseUrl, vaultRoot, logs }) => {
      const { value: result, maxBlockMs } = await measureBlock(() =>
        callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/alias.md`, content: TEXT_ALIAS_NOTE }),
      );
      assert.equal(result.isError, true, result.text.slice(0, 200));
      assert.match(result.text, /^Front matter too large/);
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
      assert.ok(logs.includes(`scoped token=test-agent tool=vault_write path="${WRITE_DIR}/alias.md" result=denied:yaml-too-large`));
      await assert.rejects(() => stat(path.join(vaultRoot, WRITE_DIR, "alias.md")));
    });
  }
});

test("scoped vault_patch refuses a note whose existing front matter is too large, without blocking the server", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    // Written by someone else (another device, the main port); the scoped token only patches it.
    await plant(vaultRoot, `${WRITE_DIR}/alias.md`, `${TEXT_ALIAS_NOTE}# Section\ntext\n`);
    const { value: result, maxBlockMs } = await measureBlock(() =>
      callTool(baseUrl, "vault_patch", {
        path: `${WRITE_DIR}/alias.md`,
        targetType: "heading",
        target: "Section",
        operation: "append",
        content: "more",
        contentType: "text/markdown",
        createTargetIfMissing: false,
        trimTargetWhitespace: false,
        rejectIfContentPreexists: false,
        targetScope: "content",
        targetDelimiter: "::",
      }),
    );
    assert.equal(result.isError, true, result.text.slice(0, 200));
    assert.match(result.text, /^Front matter too large/);
    assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
  });
});

test("a scoped write attempt counts against writesPerHour once its path and size pass, even when its front matter is refused", async () => {
  await withScopedServer([makeScopedToken({ writesPerHour: 1 })], async ({ baseUrl, logs }) => {
    // A path the token may never write is refused before anything is counted ...
    assert.equal((await callTool(baseUrl, "vault_write", { path: "elsewhere.md", content: "x" })).isError, true);
    // ... so this attempt still gets to its front matter check, and uses up the hour.
    const refused = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/alias.md`, content: TEXT_ALIAS_NOTE });
    assert.match(refused.text, /^Front matter too large/);
    const next = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/plain.md`, content: "plain" });
    assert.equal(next.isError, true, next.text);
    assert.match(next.text, /1 per hour/);
    assert.ok(logs.includes(`scoped token=test-agent tool=vault_write path="${WRITE_DIR}/plain.md" result=denied:write-limit`));
  });
});

// --- many lists and mappings: js-yaml's dump is quadratic in their number ---

test("scoped vault_patch refuses a front matter value with too many values before writing it out", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await plant(vaultRoot, `${WRITE_DIR}/p.md`, "# p\n");
    // 340 000 empty lists: 996 KB of JSON, under the body limit.
    const value = `[${Array(340_000).fill("[]").join(",")}]`;
    const { value: result, maxBlockMs } = await measureBlock(() =>
      callTool(baseUrl, "vault_patch", {
        path: `${WRITE_DIR}/p.md`,
        targetType: "frontmatter",
        target: "x",
        operation: "replace",
        contentType: "application/json",
        content: value,
        createTargetIfMissing: true,
        trimTargetWhitespace: false,
        rejectIfContentPreexists: false,
        targetScope: "content",
        targetDelimiter: "::",
      }),
    );
    assert.equal(result.isError, true, result.text.slice(0, 200));
    assert.match(result.text, /^Front matter value too large/);
    assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
    assert.ok(logs.includes(`scoped token=test-agent tool=vault_patch path="${WRITE_DIR}/p.md" result=denied:value-too-large`));
  });
});

test("scoped vault_write refuses front matter with too many lists to write out, without blocking the server", async () => {
  // 66 000 empty lists: 193 KB, under the note size limit.
  const content = `---\nx: [${Array(66_000).fill("[]").join(",")}]\n---\nbody\n`;
  for (const token of [makeScopedToken(), makeScopedToken({ frontmatter: {}, tags: [] })]) {
    await withScopedServer([token], async ({ baseUrl, vaultRoot }) => {
      const { value: result, maxBlockMs } = await measureBlock(() =>
        callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/w.md`, content }),
      );
      assert.equal(result.isError, true, result.text.slice(0, 200));
      assert.match(result.text, /^Front matter too large/);
      assert.ok(maxBlockMs < MAX_BLOCK_MS, `event loop blocked ${maxBlockMs} ms`);
      await assert.rejects(() => stat(path.join(vaultRoot, WRITE_DIR, "w.md")));
    });
  }
});

test("scoped writes still accept ordinary front matter with a few thousand values", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const tags = Array.from({ length: 3000 }, (_, i) => `tag-${i}`);
    const result = await callTool(baseUrl, "vault_write", {
      path: `${WRITE_DIR}/many-tags.md`,
      content: `---\ntags: [${tags.join(", ")}]\nnested: {a: [1, 2, {b: 3}]}\n---\nbody\n`,
    });
    assert.equal(result.isError, false, result.text);
  });
});

// --- total path length (Windows stops a pull at paths over 260 characters, vault folder included) ---

test("scoped vault_write: a path of at most 170 characters is accepted, a longer one is refused", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    const folder = `${WRITE_DIR}/${"a".repeat(100)}`;
    const fits = `${folder}/${"b".repeat(170 - folder.length - 1 - ".md".length)}.md`;
    const tooLong = `${folder}/${"b".repeat(171 - folder.length - 1 - ".md".length)}.md`;
    assert.equal(fits.length, 170);
    assert.equal(tooLong.length, 171);
    const ok = await callTool(baseUrl, "vault_write", { path: fits, content: "x" });
    assert.equal(ok.isError, false, ok.text);
    const refused = await callTool(baseUrl, "vault_write", { path: tooLong, content: "x" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /at most 170 characters/);
    await assert.rejects(() => stat(path.join(vaultRoot, tooLong)));
  });
});

test("whole-vault token: the path length counts existing folders too", async () => {
  await withScopedServer([makeScopedToken({ writeDir: "", writeDeny: [] })], async ({ baseUrl, vaultRoot, logs }) => {
    const existing = `Projects/${"x".repeat(130)}`;
    await mkdir(path.join(vaultRoot, existing), { recursive: true });
    const candidates = [
      `${existing}/${"n".repeat(35)}.md`,
      `Projects/${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/n.md`,
    ];
    for (const candidate of candidates) {
      const result = await callTool(baseUrl, "vault_write", { path: candidate, content: "x" });
      assert.equal(result.isError, true, candidate.length.toString());
      assert.match(result.text, /at most 170 characters/);
    }
    assert.equal(logs.filter((l) => l.endsWith("result=denied:too-long")).length, 2);
  });
});

test("a conflict copy of a note with the longest allowed path stays within 200 characters", async () => {
  await withGitFixture(async (vaultRoot, otherClone) => {
    await withScopedServer(
      [makeScopedToken()],
      async ({ baseUrl }) => {
        const folder = `${WRITE_DIR}/${"a".repeat(100)}`;
        const notePath = `${folder}/${"b".repeat(170 - folder.length - 1 - ".md".length)}.md`;
        assert.equal((await callTool(baseUrl, "vault_write", { path: notePath, content: "first\n" })).isError, false);

        await gitIn(otherClone, ["pull"]);
        await writeFile(path.join(otherClone, notePath), "edited on another device\n");
        await gitIn(otherClone, ["add", "."]);
        await gitIn(otherClone, ["commit", "-m", "other device edits the note"]);
        await gitIn(otherClone, ["push", "origin", "main"]);

        const result = await callTool(baseUrl, "vault_write", { path: notePath, content: "mine\n" });
        const sync = JSON.parse(result.text) as { conflict?: boolean; conflictPath?: string };
        assert.equal(sync.conflict, true, result.text);
        assert.ok(sync.conflictPath!.length <= 200, `${sync.conflictPath!.length} characters`);
        assert.match(sync.conflictPath!, /-conflict-\d{14}\.md$/);
        assert.match(await readFile(path.join(vaultRoot, sync.conflictPath!), "utf-8"), /mine/);
      },
      { vaultRoot },
    );
  });
});

// --- audit line length ---

test("scoped audit lines cut a very long path, so one request cannot write a huge log line", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, logs }) => {
    const longPath = `${WRITE_DIR}/${"a".repeat(100_000)}.md`;
    await callTool(baseUrl, "vault_read", { path: longPath });
    await callTool(baseUrl, "vault_write", { path: longPath, content: "x" });
    const audit = logs.filter((l) => l.startsWith("scoped token="));
    assert.equal(audit.length, 2);
    for (const line of audit) {
      assert.ok(line.length < 1024, `log line has ${line.length} characters`);
      assert.match(line, /…\(\+\d+\)"/);
    }
  });
});
