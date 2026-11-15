import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadScopedConfig } from "../src/scoped/config.js";
import { startServers } from "../src/start.js";
import { makeTestConfig } from "./helpers.js";
import { SCOPED_SECRET, OTHER_SCOPED_SECRET } from "./scoped-helpers.js";

const mainConfig = makeTestConfig("/vault", { PORT: 3000 });

function tokenEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    tokenEnv: "TOKEN_TEST_AGENT",
    allowFrom: ["100.64.0.10"],
    writeDir: "notes-inbox",
    expiresAt: "2099-01-01",
    ...overrides,
  };
}

function envWith(entries: unknown[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SCOPED_PORT: "3001",
    SCOPED_TOKENS_JSON: JSON.stringify(entries),
    TOKEN_TEST_AGENT: SCOPED_SECRET,
    ...extra,
  };
}

test("the scoped listener is disabled when SCOPED_PORT is unset or empty", () => {
  assert.deepEqual(loadScopedConfig({}, mainConfig), { status: "disabled" });
  assert.deepEqual(loadScopedConfig({ SCOPED_PORT: "" }, mainConfig), { status: "disabled" });
  // Tokens without a port: still nothing happens.
  assert.equal(loadScopedConfig({ ...envWith([tokenEntry()]), SCOPED_PORT: undefined }, mainConfig).status, "disabled");
});

test("a valid scoped token config is parsed, with defaults for the optional fields", () => {
  const setup = loadScopedConfig(envWith([tokenEntry()]), mainConfig);
  assert.equal(setup.status, "enabled");
  if (setup.status !== "enabled") return;
  assert.equal(setup.port, 3001);
  assert.equal(setup.tokens.length, 1);
  const [token] = setup.tokens;
  assert.equal(token.name, "test-agent");
  assert.equal(token.secret, SCOPED_SECRET);
  assert.deepEqual(token.allowFrom, ["100.64.0.10"]);
  assert.equal(token.writeDir, "notes-inbox");
  assert.deepEqual(token.readDeny, []);
  assert.equal(token.expiresAt.toISOString(), "2099-01-01T00:00:00.000Z");
  assert.equal(token.writesPerHour, 60);
  assert.deepEqual(token.frontmatter, {});
  assert.deepEqual(token.tags, []);
});

test("all optional fields are taken over when given", () => {
  const setup = loadScopedConfig(
    envWith([
      tokenEntry({
        allowFrom: ["::ffff:192.0.2.10", "100.64.0.10"],
        writeDir: "notes-inbox/assistant/",
        readDeny: ["private/", "./projects/secret-plan.md"],
        expiresAt: "2099-01-01T12:00:00Z",
        writesPerHour: 5,
        frontmatter: { source: "test-agent", reviewed: false },
        tags: ["agent", "inbox/new"],
      }),
    ]),
    mainConfig,
  );
  assert.equal(setup.status, "enabled");
  if (setup.status !== "enabled") return;
  const [token] = setup.tokens;
  assert.deepEqual(token.allowFrom, ["192.0.2.10", "100.64.0.10"]);
  assert.equal(token.writeDir, "notes-inbox/assistant");
  assert.deepEqual(token.readDeny, ["private", "projects/secret-plan.md"]);
  assert.equal(token.expiresAt.toISOString(), "2099-01-01T12:00:00.000Z");
  assert.equal(token.writesPerHour, 5);
  assert.deepEqual(token.frontmatter, { source: "test-agent", reviewed: false });
  assert.deepEqual(token.tags, ["agent", "inbox/new"]);
});

const invalidCases: { name: string; env: NodeJS.ProcessEnv }[] = [
  { name: "SCOPED_TOKENS_JSON missing", env: { SCOPED_PORT: "3001", TOKEN_TEST_AGENT: SCOPED_SECRET } },
  { name: "SCOPED_TOKENS_JSON is not JSON", env: { ...envWith([]), SCOPED_TOKENS_JSON: "[{name:" } },
  { name: "empty token list", env: envWith([]) },
  { name: "SCOPED_PORT is not a port", env: { ...envWith([tokenEntry()]), SCOPED_PORT: "abc" } },
  { name: "SCOPED_PORT equals PORT", env: { ...envWith([tokenEntry()]), SCOPED_PORT: "3000" } },
  { name: "name with uppercase letters", env: envWith([tokenEntry({ name: "Test-Agent" })]) },
  { name: "unknown field (typo)", env: envWith([tokenEntry({ writedir: "x" })]) },
  { name: "secret env var not set", env: envWith([tokenEntry({ tokenEnv: "TOKEN_NOT_SET" })]) },
  { name: "secret shorter than 32 characters", env: envWith([tokenEntry()], { TOKEN_TEST_AGENT: "too-short" }) },
  {
    name: "secret equal to TOKEN_INTERNAL",
    env: envWith([tokenEntry()], { TOKEN_TEST_AGENT: mainConfig.TOKEN_INTERNAL }),
  },
  {
    name: "two tokens share a secret",
    env: envWith([tokenEntry(), tokenEntry({ name: "second", tokenEnv: "TOKEN_SECOND" })], {
      TOKEN_SECOND: SCOPED_SECRET,
    }),
  },
  {
    name: "duplicate token names",
    env: envWith([tokenEntry(), tokenEntry({ tokenEnv: "TOKEN_SECOND" })], { TOKEN_SECOND: OTHER_SCOPED_SECRET }),
  },
  { name: "allowFrom empty", env: envWith([tokenEntry({ allowFrom: [] })]) },
  { name: "allowFrom with a CIDR range", env: envWith([tokenEntry({ allowFrom: ["100.64.0.0/10"] })]) },
  { name: "allowFrom with a host name", env: envWith([tokenEntry({ allowFrom: ["agent-host"] })]) },
  { name: "writeDir is the vault root", env: envWith([tokenEntry({ writeDir: "" })]) },
  { name: "writeDir escapes with ..", env: envWith([tokenEntry({ writeDir: "notes-inbox/../projects" })]) },
  { name: "writeDir is absolute", env: envWith([tokenEntry({ writeDir: "/notes-inbox" })]) },
  { name: "writeDir with uppercase letters", env: envWith([tokenEntry({ writeDir: "Notes-Inbox" })]) },
  { name: "writeDir is a dot folder", env: envWith([tokenEntry({ writeDir: ".claude" })]) },
  { name: "readDeny entry escapes with ..", env: envWith([tokenEntry({ readDeny: ["../outside"] })]) },
  { name: "readDeny entry is the vault root", env: envWith([tokenEntry({ readDeny: ["."] })]) },
  { name: "expiresAt missing", env: envWith([tokenEntry({ expiresAt: undefined })]) },
  { name: "expiresAt is not a date", env: envWith([tokenEntry({ expiresAt: "in 90 days" })]) },
  { name: "writesPerHour is zero", env: envWith([tokenEntry({ writesPerHour: 0 })]) },
  { name: "frontmatter sets tags (use the tags field)", env: envWith([tokenEntry({ frontmatter: { tags: "x" } })]) },
  { name: "frontmatter value is an object", env: envWith([tokenEntry({ frontmatter: { source: { a: 1 } } })]) },
  { name: "tag with a space", env: envWith([tokenEntry({ tags: ["two words"] })]) },
];

for (const { name, env } of invalidCases) {
  test(`an invalid scoped config is rejected as a whole: ${name}`, () => {
    const setup = loadScopedConfig(env, mainConfig);
    assert.equal(setup.status, "invalid");
    if (setup.status !== "invalid") return;
    assert.ok(setup.errors.length > 0);
    // Error output ends up in logs: it must never echo a secret value.
    for (const error of setup.errors) {
      assert.ok(!error.includes(SCOPED_SECRET));
      assert.ok(!error.includes(mainConfig.TOKEN_INTERNAL));
    }
  });
}

test("an invalid scoped config keeps the main listener running and does not start the scoped one", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "start-vault-"));
  const lines: string[] = [];
  const log = { info: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const servers = await startServers(
    makeTestConfig(vaultRoot),
    envWith([tokenEntry({ writeDir: "../outside" })], { SCOPED_PORT: "0" }),
    log,
  );
  try {
    assert.equal(servers.scoped, undefined);
    const port = (servers.main.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.ok(lines.some((line) => /scoped listener not started/i.test(line) && /writeDir/.test(line)));
  } finally {
    await new Promise((resolve) => servers.main.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("a valid scoped config starts a second listener next to the main one", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "start-vault-"));
  const lines: string[] = [];
  const log = { info: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const servers = await startServers(makeTestConfig(vaultRoot), envWith([tokenEntry()], { SCOPED_PORT: "0" }), log);
  try {
    assert.ok(servers.scoped);
    const mainPort = (servers.main.address() as AddressInfo).port;
    const scopedPort = (servers.scoped.address() as AddressInfo).port;
    assert.notEqual(mainPort, scopedPort);
    assert.equal((await fetch(`http://127.0.0.1:${scopedPort}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${mainPort}/health`)).status, 200);
    assert.ok(lines.some((line) => /scoped listener on port/i.test(line) && line.includes("test-agent")));
  } finally {
    await new Promise((resolve) => servers.main.close(resolve));
    await new Promise((resolve) => servers.scoped!.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
