import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WRITE_DIR, callTool, makeScopedToken, withScopedServer } from "./scoped-helpers.js";

// Resource limits of the scoped listener. A scoped client must not be able to stall the server
// process (and with it the main listener) with one expensive request. Each test measures how long
// the event loop of this process was blocked while the request ran.

/** Runs `fn` and reports the longest event-loop block in the meantime, in milliseconds. */
async function measureBlock<T>(fn: () => Promise<T>): Promise<{ value: T; maxBlockMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  try {
    const value = await fn();
    return { value, maxBlockMs: histogram.max / 1e6 };
  } finally {
    histogram.disable();
  }
}

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
    assert.match(big.text, /too large/);
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
