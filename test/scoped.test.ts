import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { base64url, gitIn, withGitFixture, withTestServer } from "./helpers.js";
import { throttlePull } from "../src/scoped/pull.js";
import {
  OTHER_SCOPED_SECRET,
  SCOPED_SECRET,
  WRITE_DIR,
  callTool,
  makeScopedToken,
  mcpRequest,
  withScopedServer,
} from "./scoped-helpers.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Directory symlink; a junction on Windows, which needs no extra rights there. */
async function linkDir(target: string, linkPath: string) {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

const patchDefaults = {
  contentType: "text/markdown",
  createTargetIfMissing: false,
  trimTargetWhitespace: false,
  rejectIfContentPreexists: false,
  targetScope: "content",
  targetDelimiter: "::",
};

// --- listener and authentication ---

test("scoped listener: GET /health answers without a token", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("scoped listener: a valid token from an allowed address can use the MCP tools", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const res = await mcpRequest(baseUrl, SCOPED_SECRET, "tools/list");
    assert.equal(res.status, 200);
    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["search_query", "vault_list", "vault_patch", "vault_read", "vault_write"]);
  });
});

test("scoped listener: wrong token, wrong address and expired token all get the same 401; only the log says why", async () => {
  const tokens = [
    makeScopedToken(),
    makeScopedToken({ name: "remote-only", secret: OTHER_SCOPED_SECRET, allowFrom: ["192.0.2.10"] }),
    makeScopedToken({
      name: "expired",
      secret: "scoped-test-secret-not-real-0000000003",
      expiresAt: new Date(Date.now() - 1000),
    }),
  ];
  await withScopedServer(tokens, async ({ baseUrl, logs }) => {
    const wrongToken = await mcpRequest(baseUrl, "scoped-test-secret-not-real-9999999999", "tools/list");
    const wrongAddress = await mcpRequest(baseUrl, OTHER_SCOPED_SECRET, "tools/list");
    const expired = await mcpRequest(baseUrl, "scoped-test-secret-not-real-0000000003", "tools/list");
    const noToken = await mcpRequest(baseUrl, undefined, "tools/list");

    for (const res of [wrongToken, wrongAddress, expired, noToken]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "Unauthorized" });
    }
    assert.ok(logs.some((l) => l.includes("reason=unknown-token")));
    assert.ok(logs.some((l) => l.includes("reason=address-not-allowed") && l.includes("token=remote-only")));
    assert.ok(logs.some((l) => l.includes("reason=expired") && l.includes("token=expired")));
    assert.ok(logs.some((l) => l.includes("reason=missing-token")));
    assert.ok(logs.every((l) => !l.includes(SCOPED_SECRET) && !l.includes(OTHER_SCOPED_SECRET)));
  });
});

test("scoped listener: a spoofed X-Forwarded-For does not make a request come from an allowed address", async () => {
  const token = makeScopedToken({ allowFrom: ["192.0.2.10"] });
  await withScopedServer([token], async ({ baseUrl, logs }) => {
    const res = await mcpRequest(baseUrl, SCOPED_SECRET, "tools/list", {}, {
      "X-Forwarded-For": "192.0.2.10",
      "X-Real-IP": "192.0.2.10",
      Forwarded: "for=192.0.2.10",
    });
    assert.equal(res.status, 401);
    assert.ok(logs.some((l) => l.includes("reason=address-not-allowed") && l.includes("from=127.0.0.1")));
  });
});

test("scoped listener: TOKEN_INTERNAL is not accepted there, not even with a tailnet X-Forwarded-For", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, config }) => {
    const res = await mcpRequest(baseUrl, config.TOKEN_INTERNAL, "tools/list", {}, { "X-Forwarded-For": "100.64.0.10" });
    assert.equal(res.status, 401);
  });
});

test("scoped listener: OAuth, passkey and discovery routes do not exist there", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const routes: [string, string][] = [
      ["GET", "/oauth/authorize"],
      ["POST", "/oauth/authorize"],
      ["POST", "/oauth/token"],
      ["GET", "/authorize"],
      ["POST", "/token"],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/webauthn/setup"],
      ["GET", "/theme.css"],
    ];
    for (const [method, route] of routes) {
      const res = await fetch(`${baseUrl}${route}`, { method, redirect: "manual" });
      assert.equal(res.status, 404, `${method} ${route}`);
    }
  });
});

test("scoped listener: more than 60 requests a minute from one address get 429", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await mcpRequest(baseUrl, SCOPED_SECRET, "tools/list")).status);
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(200));
    assert.equal(statuses[60], 429);
  });
});

test("scoped listener: a JSON-RPC batch is refused with 400 and runs none of its calls", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "vault_write", arguments: { path: `${WRITE_DIR}/batch-${id}.md`, content: "x" } },
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${SCOPED_SECRET}`,
      },
      body: JSON.stringify([call(1), call(2)]),
    });
    assert.equal(res.status, 400);
    assert.equal(await exists(path.join(vaultRoot, WRITE_DIR)), false);
    assert.ok(logs.some((l) => l.includes("token=test-agent") && l.includes("result=denied:batch")));
  });
});

test("scoped listener: every authenticated request without a tool call writes one line with its method", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, logs }) => {
    await mcpRequest(baseUrl, SCOPED_SECRET, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await mcpRequest(baseUrl, SCOPED_SECRET, "tools/list");
    await mcpRequest(baseUrl, SCOPED_SECRET, "tools/call", { name: "no_such_tool", arguments: {} });
    await callTool(baseUrl, "vault_list", { path: "" });
    assert.deepEqual(
      logs.filter((l) => l.startsWith("scoped token=")),
      [
        "scoped token=test-agent method=initialize",
        "scoped token=test-agent method=tools/list",
        "scoped token=test-agent method=tools/call",
        'scoped token=test-agent tool=vault_list path="" result=ok',
      ],
    );
  });
});

test("scoped errors never show server paths to the client; only the error code goes to the log", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    const result = await callTool(baseUrl, "vault_read", { path: "missing.md" });
    assert.equal(result.isError, true);
    assert.equal(result.text, "Not found: missing.md");
    assert.ok(!result.text.includes(vaultRoot));
    assert.ok(logs.includes('scoped token=test-agent tool=vault_read path="missing.md" result=error:ENOENT'));
    // Ordinary tool errors (no system error code) still explain themselves.
    await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/note.md`, content: "# Note\n" });
    const patch = await callTool(baseUrl, "vault_patch", {
      ...patchDefaults,
      path: `${WRITE_DIR}/note.md`,
      targetType: "heading",
      target: "Missing",
      operation: "append",
      content: "x",
    });
    assert.equal(patch.isError, true);
    assert.match(patch.text, /Heading not found: Missing/);
  });
});

test("scoped reads share pulls: concurrent readers wait for one pull, then there is none for 10 seconds", async () => {
  let pulls = 0;
  let release = () => {};
  let now = 0;
  const throttled = throttlePull(
    () => {
      pulls++;
      return new Promise<void>((resolve) => (release = resolve));
    },
    10_000,
    () => now,
  );
  const first = throttled();
  const second = throttled();
  assert.equal(pulls, 1);
  assert.equal(first, second);
  release();
  await first;
  now = 9_999;
  await throttled();
  assert.equal(pulls, 1);
  now = 10_000;
  const third = throttled();
  assert.equal(pulls, 2);
  release();
  await third;
});

test("main listener: a scoped token is rejected there, even from a tailnet address", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await mcpRequest(baseUrl, SCOPED_SECRET, "tools/list", {}, { "X-Forwarded-For": "100.64.0.10" });
    assert.equal(res.status, 401);
  });
});

test("scoped listener: an OAuth access token from the main listener is not accepted there", async () => {
  await withTestServer(async (mainUrl, config) => {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const authorizeRes = await fetch(`${mainUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: config.OAUTH_PASSWORD,
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        response_type: "code",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await fetch(`${mainUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
        code_verifier: verifier,
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    assert.equal((await mcpRequest(mainUrl, access_token, "tools/list")).status, 200);

    await withScopedServer([makeScopedToken()], async ({ baseUrl }) => {
      assert.equal((await mcpRequest(baseUrl, access_token, "tools/list")).status, 401);
    });
  });
});

// --- writes: rejected paths ---

const rejectedWritePaths = [
  "x/../03-resources/x.md",
  `${WRITE_DIR}/../03-resources/x.md`,
  "03-resources/x.md",
  `./${WRITE_DIR}/x.md`,
  `${WRITE_DIR}//x.md`,
  `${WRITE_DIR}\\x.md`,
  `/${WRITE_DIR}/x.md`,
  `${WRITE_DIR}/CLAUDE.md`,
  `${WRITE_DIR}/Claude.md`,
  `${WRITE_DIR}/claude.md`,
  `${WRITE_DIR}/claude-notes.md`,
  `${WRITE_DIR}/agents.md`,
  `${WRITE_DIR}/AGENTS.md`,
  `${WRITE_DIR}/claude/x.md`,
  `${WRITE_DIR.toUpperCase()}/x.md`,
  `${WRITE_DIR}/.claude/settings.json`,
  `${WRITE_DIR}/.claude/x.md`,
  `${WRITE_DIR}/.hidden.md`,
  `${WRITE_DIR}/x.js`,
  `${WRITE_DIR}/x.md.js`,
  `${WRITE_DIR}/x`,
  `${WRITE_DIR}/Note.md`,
  `${WRITE_DIR}/my note.md`,
  `${WRITE_DIR}/agent.md`,
  `${WRITE_DIR}/agent-notes.md`,
  `${WRITE_DIR}/gemini.md`,
  `${WRITE_DIR}/qwen.md`,
  `${WRITE_DIR}/crush.md`,
  `${WRITE_DIR}/warp.md`,
  `${WRITE_DIR}/copilot-instructions.md`,
  `${WRITE_DIR}/cursor-rules.md`,
  `${WRITE_DIR}/windsurf.md`,
  `${WRITE_DIR}/cline.md`,
  `${WRITE_DIR}/conventions.md`,
  `${WRITE_DIR}/readme.md`,
  `${WRITE_DIR}/gemini/x.md`,
  `${WRITE_DIR}/con.md`,
  `${WRITE_DIR}/com0.md`,
  `${WRITE_DIR}/lpt0.md`,
  `${WRITE_DIR}/lpt9.md`,
  `${WRITE_DIR}/aux/x.md`,
  `${WRITE_DIR}/${"a".repeat(98)}.md`,
  `${WRITE_DIR}/a/b/c/d/x.md`,
  WRITE_DIR,
  `${WRITE_DIR}/`,
];

for (const rejectedPath of rejectedWritePaths) {
  test(`scoped vault_write is rejected: ${JSON.stringify(rejectedPath)}`, async () => {
    await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
      const result = await callTool(baseUrl, "vault_write", { path: rejectedPath, content: "x" });
      assert.equal(result.isError, true, result.text);
      assert.ok(logs.some((l) => l.includes("tool=vault_write") && l.includes("result=denied:")));
      // Nothing was created anywhere: the vault directory is still empty.
      const files = await import("node:fs/promises").then((fs) => fs.readdir(vaultRoot, { recursive: true }));
      assert.deepEqual(files, []);
    });
  });
}

test("scoped vault_write accepts the deepest allowed path (4 levels below the write folder)", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    const result = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/a/b/c/x.md`, content: "x" });
    assert.equal(result.isError, false, result.text);
    assert.ok(await exists(path.join(vaultRoot, WRITE_DIR, "a", "b", "c", "x.md")));
  });
});

test("scoped vault_write rejects a note over 200 KB", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    const result = await callTool(baseUrl, "vault_write", {
      path: `${WRITE_DIR}/big.md`,
      content: "x".repeat(200 * 1024 + 1),
    });
    assert.equal(result.isError, true);
    assert.ok(logs.some((l) => l.includes("result=denied:too-large")));
    assert.equal(await exists(path.join(vaultRoot, WRITE_DIR, "big.md")), false);
  });
});

test("scoped vault_write counts the 200 KB in UTF-8 bytes, not characters", async () => {
  await withScopedServer([makeScopedToken({ frontmatter: {}, tags: [] })], async ({ baseUrl }) => {
    // 70,000 characters, but 3 bytes each: 210,000 bytes.
    const result = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/wide.md`, content: "€".repeat(70_000) });
    assert.equal(result.isError, true);
  });
});

// --- writes: symlinks ---

test("scoped vault_write refuses a folder symlink in the write folder that points outside it", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await mkdir(path.join(vaultRoot, WRITE_DIR), { recursive: true });
    await mkdir(path.join(vaultRoot, "03-resources"), { recursive: true });
    await linkDir(path.join(vaultRoot, "03-resources"), path.join(vaultRoot, WRITE_DIR, "link"));

    const result = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/link/x.md`, content: "x" });
    assert.equal(result.isError, true, result.text);
    assert.ok(logs.some((l) => l.includes("result=denied:symlink")));
    assert.equal(await exists(path.join(vaultRoot, "03-resources", "x.md")), false);
  });
});

test("scoped vault_write refuses when the write folder itself is a symlink", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    await mkdir(path.join(vaultRoot, "03-resources"), { recursive: true });
    await linkDir(path.join(vaultRoot, "03-resources"), path.join(vaultRoot, WRITE_DIR));

    const result = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/x.md`, content: "x" });
    assert.equal(result.isError, true, result.text);
    assert.equal(await exists(path.join(vaultRoot, "03-resources", "x.md")), false);
  });
});

test("scoped vault_write refuses a note that is a file symlink pointing outside the write folder", async (t) => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await mkdir(path.join(vaultRoot, WRITE_DIR), { recursive: true });
    await mkdir(path.join(vaultRoot, "03-resources"), { recursive: true });
    const outside = path.join(vaultRoot, "03-resources", "target.md");
    await writeFile(outside, "original");
    try {
      await symlink(outside, path.join(vaultRoot, WRITE_DIR, "note.md"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("file symlinks need Developer Mode or admin rights on Windows");
        return;
      }
      throw error;
    }

    const write = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/note.md`, content: "overwritten" });
    assert.equal(write.isError, true, write.text);
    const patch = await callTool(baseUrl, "vault_patch", {
      ...patchDefaults,
      path: `${WRITE_DIR}/note.md`,
      targetType: "heading",
      target: "New",
      operation: "append",
      content: "overwritten",
      createTargetIfMissing: true,
    });
    assert.equal(patch.isError, true, patch.text);
    assert.ok(logs.filter((l) => l.includes("result=denied:symlink")).length === 2);
    assert.equal(await readFile(outside, "utf-8"), "original");
  });
});

// --- writes: allowed ---

test("scoped vault_write: a valid note is written with the server's front matter and tags, and committed under the token's name", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [makeScopedToken()],
      async ({ baseUrl }) => {
        const notePath = `${WRITE_DIR}/test-note.md`;
        const result = await callTool(baseUrl, "vault_write", {
          path: notePath,
          content: "---\nsource: someone-else\ntags: [mine]\n---\n# Hello\n",
        });
        assert.equal(result.isError, false, result.text);
        assert.equal(JSON.parse(result.text).synced, true);

        const read = await callTool(baseUrl, "vault_read", { path: notePath });
        const note = JSON.parse(read.text) as { content: string; frontmatter: Record<string, unknown> };
        assert.equal(note.frontmatter.source, "test-agent");
        assert.deepEqual(note.frontmatter.tags, ["mine", "scoped"]);
        assert.match(note.content, /# Hello/);

        const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "-1", "--format=%s"]);
        assert.equal(stdout.trim(), `test-agent: vault_write ${notePath}`);
      },
      { vaultRoot },
    );
  });
});

test("scoped vault_write refuses a note with JavaScript front matter instead of dropping the block", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    for (const opener of ["---js", "---javascript", "--- JS"]) {
      const result = await callTool(baseUrl, "vault_write", {
        path: `${WRITE_DIR}/js.md`,
        content: `${opener}\n{ title: 'x' }\n---\nBody\n`,
      });
      assert.equal(result.isError, true, opener);
      assert.match(result.text, /JavaScript front matter/);
    }
    assert.equal(await exists(path.join(vaultRoot, WRITE_DIR, "js.md")), false);
  });
});

test("main listener vault_patch refuses a note with JavaScript front matter and leaves it unchanged", async () => {
  await withTestServer(async (baseUrl, config) => {
    const original = "---js\n{ title: 'x' }\n---\n# Section\ntext\n";
    await writeFile(path.join(config.VAULT_PATH, "js.md"), original);
    for (const targetType of ["heading", "frontmatter"]) {
      const res = await mcpRequest(
        baseUrl,
        config.TOKEN_INTERNAL,
        "tools/call",
        {
          name: "vault_patch",
          arguments: {
            ...patchDefaults,
            path: "js.md",
            targetType,
            target: targetType === "heading" ? "Section" : "title",
            operation: "replace",
            content: "new",
            createTargetIfMissing: true,
          },
        },
        { "X-Forwarded-For": "100.64.0.10" },
      );
      const result = (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
      assert.equal(result.isError, true, targetType);
      assert.match(result.content[0].text, /JavaScript front matter/);
    }
    assert.equal(await readFile(path.join(config.VAULT_PATH, "js.md"), "utf-8"), original);
  });
});

test("scoped vault_patch keeps the server's front matter and tags even when the patch removes them", async () => {
  await withGitFixture(async (vaultRoot) => {
    await withScopedServer(
      [makeScopedToken()],
      async ({ baseUrl }) => {
        const notePath = `${WRITE_DIR}/patched.md`;
        await callTool(baseUrl, "vault_write", { path: notePath, content: "# Note\n" });

        const replaceSource = await callTool(baseUrl, "vault_patch", {
          ...patchDefaults,
          path: notePath,
          targetType: "frontmatter",
          target: "source",
          operation: "replace",
          content: "forged",
        });
        assert.equal(replaceSource.isError, false, replaceSource.text);
        const dropTags = await callTool(baseUrl, "vault_patch", {
          ...patchDefaults,
          path: notePath,
          targetType: "frontmatter",
          target: "tags",
          operation: "replace",
          content: "[]",
          contentType: "application/json",
        });
        assert.equal(dropTags.isError, false, dropTags.text);

        const note = JSON.parse((await callTool(baseUrl, "vault_read", { path: notePath })).text) as {
          frontmatter: Record<string, unknown>;
        };
        assert.equal(note.frontmatter.source, "test-agent");
        assert.deepEqual(note.frontmatter.tags, ["scoped"]);

        // Both patches above ended up as no-ops, so they made no commit. A real change does.
        const append = await callTool(baseUrl, "vault_patch", {
          ...patchDefaults,
          path: notePath,
          targetType: "heading",
          target: "Note",
          operation: "append",
          content: "More text",
        });
        assert.equal(append.isError, false, append.text);
        const { stdout } = await gitIn(vaultRoot, ["log", "origin/main", "-1", "--format=%s"]);
        assert.equal(stdout.trim(), `test-agent: vault_patch ${notePath}`);
      },
      { vaultRoot },
    );
  });
});

test("scoped vault_patch outside the write folder is rejected and leaves the note untouched", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await mkdir(path.join(vaultRoot, "03-resources"), { recursive: true });
    const outside = path.join(vaultRoot, "03-resources", "x.md");
    await writeFile(outside, "# Note\n");
    for (const target of ["03-resources/x.md", `${WRITE_DIR}/../03-resources/x.md`]) {
      const result = await callTool(baseUrl, "vault_patch", {
        ...patchDefaults,
        path: target,
        targetType: "heading",
        target: "Note",
        operation: "append",
        content: "injected",
      });
      assert.equal(result.isError, true, result.text);
    }
    assert.equal(await readFile(outside, "utf-8"), "# Note\n");
    assert.equal(logs.filter((l) => l.includes("tool=vault_patch") && l.includes("result=denied:")).length, 2);
  });
});

test("scoped vault_patch rejects a result over 200 KB", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    const notePath = `${WRITE_DIR}/grow.md`;
    await callTool(baseUrl, "vault_write", { path: notePath, content: `# Note\n${"x".repeat(150 * 1024)}\n` });
    const before = await readFile(path.join(vaultRoot, WRITE_DIR, "grow.md"), "utf-8");
    const result = await callTool(baseUrl, "vault_patch", {
      ...patchDefaults,
      path: notePath,
      targetType: "heading",
      target: "Note",
      operation: "append",
      content: "y".repeat(60 * 1024),
    });
    assert.equal(result.isError, true, result.text);
    assert.equal(await readFile(path.join(vaultRoot, WRITE_DIR, "grow.md"), "utf-8"), before);
  });
});

test("scoped writes stop at writesPerHour", async () => {
  await withScopedServer([makeScopedToken({ writesPerHour: 2 })], async ({ baseUrl, vaultRoot, logs }) => {
    for (const name of ["one", "two"]) {
      const ok = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/${name}.md`, content: name });
      assert.equal(ok.isError, false, ok.text);
    }
    const third = await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/three.md`, content: "three" });
    assert.equal(third.isError, true);
    assert.match(third.text, /2 per hour/);
    assert.ok(logs.some((l) => l.includes("result=denied:write-limit")));
    assert.equal(await exists(path.join(vaultRoot, WRITE_DIR, "three.md")), false);
  });
});

// --- front matter is never executed, also not when it is written back ---

// A note whose body (after a normal YAML block) starts with a JavaScript front matter block.
// Writing front matter back must keep that block as plain text and never evaluate it.
const JS_IN_BODY = "---js\n{ x: (globalThis.__frontmatterEvaluated = true, 1) }\n---\n";
const evaluatedFlag = globalThis as { __frontmatterEvaluated?: boolean };

test("scoped vault_write never evaluates a JavaScript front matter block in the body", async () => {
  delete evaluatedFlag.__frontmatterEvaluated;
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    const result = await callTool(baseUrl, "vault_write", {
      path: `${WRITE_DIR}/js-body.md`,
      content: `---\ntitle: t\n---\n${JS_IN_BODY}# Section\ntext\n`,
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(evaluatedFlag.__frontmatterEvaluated, undefined);
    const raw = await readFile(path.join(vaultRoot, WRITE_DIR, "js-body.md"), "utf-8");
    assert.ok(raw.includes(JS_IN_BODY), raw);
    assert.match(raw, /^---\ntitle: t\nsource: test-agent\n/);
  });
});

test("scoped vault_patch never evaluates a JavaScript front matter block in the body", async () => {
  delete evaluatedFlag.__frontmatterEvaluated;
  await withScopedServer([makeScopedToken({ frontmatter: {}, tags: [] })], async ({ baseUrl, vaultRoot }) => {
    await mkdir(path.join(vaultRoot, WRITE_DIR), { recursive: true });
    await writeFile(path.join(vaultRoot, WRITE_DIR, "js-body.md"), `---\ntitle: t\n---\n${JS_IN_BODY}# Section\ntext\n`);
    const result = await callTool(baseUrl, "vault_patch", {
      ...patchDefaults,
      path: `${WRITE_DIR}/js-body.md`,
      targetType: "heading",
      target: "Section",
      operation: "append",
      content: "more",
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(evaluatedFlag.__frontmatterEvaluated, undefined);
    const raw = await readFile(path.join(vaultRoot, WRITE_DIR, "js-body.md"), "utf-8");
    assert.ok(raw.includes(JS_IN_BODY), raw);
    assert.match(raw, /more/);
  });
});

test("main listener vault_patch never evaluates a JavaScript front matter block in the body", async () => {
  delete evaluatedFlag.__frontmatterEvaluated;
  await withTestServer(async (baseUrl, config) => {
    await writeFile(path.join(config.VAULT_PATH, "js-body.md"), `---\ntitle: t\n---\n${JS_IN_BODY}# Section\ntext\n`);
    const res = await mcpRequest(
      baseUrl,
      config.TOKEN_INTERNAL,
      "tools/call",
      {
        name: "vault_patch",
        arguments: { ...patchDefaults, path: "js-body.md", targetType: "heading", target: "Section", operation: "append", content: "more" },
      },
      { "X-Forwarded-For": "100.64.0.10" },
    );
    assert.equal(res.status, 200);
    assert.equal(evaluatedFlag.__frontmatterEvaluated, undefined);
    const raw = await readFile(path.join(config.VAULT_PATH, "js-body.md"), "utf-8");
    assert.ok(raw.includes(JS_IN_BODY), raw);
    assert.match(raw, /^---\ntitle: t\n---\n/);
  });
});

// --- reads ---

async function seedReadFixture(vaultRoot: string) {
  await mkdir(path.join(vaultRoot, "private"), { recursive: true });
  await mkdir(path.join(vaultRoot, "projects"), { recursive: true });
  await writeFile(path.join(vaultRoot, "private", "secret.md"), "---\nkind: secret\n---\nSee [[open]]");
  await writeFile(path.join(vaultRoot, "projects", "open.md"), "---\nkind: open\n---\nOpen note");
  await writeFile(path.join(vaultRoot, "projects", "plan.md"), "---\nkind: plan\n---\nPlan");
}

const readDenyToken = () => makeScopedToken({ readDeny: ["private", "projects/plan.md"] });

test("scoped vault_read: readDeny entries are rejected, everything else is readable", async () => {
  await withScopedServer([readDenyToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await seedReadFixture(vaultRoot);
    assert.equal((await callTool(baseUrl, "vault_read", { path: "projects/open.md" })).isError, false);
    for (const denied of ["private/secret.md", "Private/secret.md", "projects/plan.md", "projects/../private/secret.md"]) {
      const result = await callTool(baseUrl, "vault_read", { path: denied });
      assert.equal(result.isError, true, denied);
      assert.doesNotMatch(result.text, /kind: secret|See \[\[open/);
    }
    assert.ok(logs.some((l) => l.includes("tool=vault_read") && l.includes("result=denied:read-denied")));
  });
});

test("scoped vault_read: a symlink into a denied folder does not get around readDeny", async () => {
  await withScopedServer([readDenyToken()], async ({ baseUrl, vaultRoot }) => {
    await seedReadFixture(vaultRoot);
    await linkDir(path.join(vaultRoot, "private"), path.join(vaultRoot, "projects", "shortcut"));
    const result = await callTool(baseUrl, "vault_read", { path: "projects/shortcut/secret.md" });
    assert.equal(result.isError, true, result.text);
  });
});

test("scoped vault_list hides readDeny entries (and .git/.obsidian) and refuses to list a denied folder", async () => {
  await withScopedServer([readDenyToken()], async ({ baseUrl, vaultRoot }) => {
    await seedReadFixture(vaultRoot);
    await mkdir(path.join(vaultRoot, ".git"));
    await mkdir(path.join(vaultRoot, ".obsidian"));
    assert.deepEqual(JSON.parse((await callTool(baseUrl, "vault_list", { path: "" })).text), ["projects/"]);
    assert.deepEqual(JSON.parse((await callTool(baseUrl, "vault_list", { path: "projects" })).text), ["open.md"]);
    assert.equal((await callTool(baseUrl, "vault_list", { path: "private" })).isError, true);
  });
});

test("scoped search_query never matches readDeny notes, nor shows them as backlinks", async () => {
  await withScopedServer([readDenyToken()], async ({ baseUrl, vaultRoot }) => {
    await seedReadFixture(vaultRoot);
    await linkDir(path.join(vaultRoot, "private"), path.join(vaultRoot, "projects", "shortcut"));
    const all = JSON.parse((await callTool(baseUrl, "search_query", { query: { "==": [1, 1] } })).text) as {
      filename: string;
    }[];
    assert.deepEqual(all.map((r) => r.filename), ["projects/open.md"]);
    // private/secret.md links to [[open]], but must not show up as its backlink.
    const backlinks = JSON.parse((await callTool(baseUrl, "search_query", { query: { var: "backlinks" } })).text);
    assert.deepEqual(backlinks, [{ filename: "projects/open.md", result: [] }]);
  });
});

test("scoped search_query runs with the search budget: an oversized query is refused and logged", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot, logs }) => {
    await mkdir(path.join(vaultRoot, "projects"), { recursive: true });
    await writeFile(path.join(vaultRoot, "projects", "a.md"), "A");
    const wide = { or: Array.from({ length: 600 }, () => false) };
    const refused = await callTool(baseUrl, "search_query", { query: wide });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /query/i);
    assert.ok(logs.some((l) => l.includes("tool=search_query") && l.includes("result=denied:search-limit")));
    // Braces in glob patterns are literal for scoped tokens.
    const braces = await callTool(baseUrl, "search_query", { query: { glob: ["projects/{a,b}.md", { var: "path" }] } });
    assert.deepEqual(JSON.parse(braces.text), []);
  });
});

test("scoped reads do not follow a symlink that leads out of the vault", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, vaultRoot }) => {
    const outside = `${vaultRoot}-outside`;
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "leak.md"), "outside the vault");
    try {
      await linkDir(outside, path.join(vaultRoot, "escape"));
      assert.equal((await callTool(baseUrl, "vault_read", { path: "escape/leak.md" })).isError, true);
      const found = JSON.parse((await callTool(baseUrl, "search_query", { query: { "==": [1, 1] } })).text) as unknown[];
      assert.deepEqual(found, []);
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(outside, { recursive: true, force: true }));
    }
  });
});

// --- audit log ---

test("every scoped tool call writes one audit line with token, tool, path and result, never content or token", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, logs }) => {
    const marker = "content-marker-that-must-not-be-logged";
    await callTool(baseUrl, "vault_write", { path: `${WRITE_DIR}/logged.md`, content: marker });
    await callTool(baseUrl, "vault_write", { path: "elsewhere.md", content: marker });
    await callTool(baseUrl, "vault_read", { path: `${WRITE_DIR}/logged.md` });
    await callTool(baseUrl, "search_query", { query: { "==": [1, 1] } });

    const audit = logs.filter((l) => l.startsWith("scoped token="));
    assert.deepEqual(audit, [
      `scoped token=test-agent tool=vault_write path="${WRITE_DIR}/logged.md" result=ok`,
      `scoped token=test-agent tool=vault_write path="elsewhere.md" result=denied:outside-write-dir`,
      `scoped token=test-agent tool=vault_read path="${WRITE_DIR}/logged.md" result=ok`,
      `scoped token=test-agent tool=search_query path="-" result=ok`,
    ]);
    assert.ok(logs.every((l) => !l.includes(marker) && !l.includes(SCOPED_SECRET)));
  });
});

test("a malformed request body on the scoped listener is logged without its content", async () => {
  await withScopedServer([makeScopedToken()], async ({ baseUrl, logs }) => {
    const marker = "body-marker-that-must-not-be-logged";
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SCOPED_SECRET}` },
      body: `{"content": "${marker}"`,
    });
    assert.equal(res.status, 400);
    assert.ok(logs.some((l) => l.startsWith("scoped request failed status=400")));
    assert.ok(logs.every((l) => !l.includes(marker)));
  });
});
