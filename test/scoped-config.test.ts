import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadScopedConfig, normalizeAddress } from "../src/scoped/config.js";
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

test('writeDir "/" opens the whole vault; writeDeny is normalized and every readDeny entry is write-denied too', () => {
  const setup = loadScopedConfig(
    envWith([
      tokenEntry({
        writeDir: "/",
        writeDeny: ["03-resources/claude-config/", "./.claude", "private"],
        // With the whole vault writable, readDeny cannot overlap a write folder: no error.
        readDeny: ["private/", "projects/secret-plan.md"],
      }),
    ]),
    mainConfig,
  );
  assert.equal(setup.status, "enabled", JSON.stringify(setup));
  if (setup.status !== "enabled") return;
  const [token] = setup.tokens;
  assert.equal(token.writeDir, "");
  assert.deepEqual(token.readDeny, ["private", "projects/secret-plan.md"]);
  assert.deepEqual(token.writeDeny, ["03-resources/claude-config", ".claude", "private", "projects/secret-plan.md"]);
});

test("with one write folder, readDeny entries are write-denied as well and writeDeny defaults to empty", () => {
  const setup = loadScopedConfig(envWith([tokenEntry({ readDeny: ["private"] })]), mainConfig);
  assert.equal(setup.status, "enabled", JSON.stringify(setup));
  if (setup.status !== "enabled") return;
  assert.equal(setup.tokens[0].writeDir, "notes-inbox");
  assert.deepEqual(setup.tokens[0].writeDeny, ["private"]);
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

const T = "SCOPED_TOKENS_JSON[0]";

// field: the start of the error line that must name the problem, so a case cannot pass for a
// different reason.
const invalidCases: { name: string; env: NodeJS.ProcessEnv; field: string }[] = [
  {
    name: "SCOPED_TOKENS_JSON missing",
    env: { SCOPED_PORT: "3001", TOKEN_TEST_AGENT: SCOPED_SECRET },
    field: "SCOPED_TOKENS_JSON: not set",
  },
  {
    name: "SCOPED_TOKENS_JSON is not JSON",
    env: { ...envWith([]), SCOPED_TOKENS_JSON: "[{name:" },
    field: "SCOPED_TOKENS_JSON: not valid JSON",
  },
  { name: "empty token list", env: envWith([]), field: "SCOPED_TOKENS_JSON: configure at least one token" },
  { name: "SCOPED_PORT is not a port", env: { ...envWith([tokenEntry()]), SCOPED_PORT: "abc" }, field: "SCOPED_PORT:" },
  {
    name: "SCOPED_PORT equals PORT",
    env: { ...envWith([tokenEntry()]), SCOPED_PORT: "3000" },
    field: "SCOPED_PORT: must differ",
  },
  {
    name: "SCOPED_HOST is not an IP address",
    env: { ...envWith([tokenEntry()]), SCOPED_HOST: "agent-host" },
    field: "SCOPED_HOST:",
  },
  { name: "name with uppercase letters", env: envWith([tokenEntry({ name: "Test-Agent" })]), field: `${T}.name:` },
  {
    name: "unknown field (typo)",
    env: envWith([tokenEntry({ writedir: "x" })]),
    field: `${T}: Unrecognized key(s) in object: 'writedir'`,
  },
  {
    name: "secret env var not set",
    env: envWith([tokenEntry({ tokenEnv: "TOKEN_NOT_SET" })]),
    field: `${T}.tokenEnv: environment variable TOKEN_NOT_SET is not set`,
  },
  {
    name: "secret shorter than 32 characters",
    env: envWith([tokenEntry()], { TOKEN_TEST_AGENT: "too-short" }),
    field: `${T}.tokenEnv: the value of TOKEN_TEST_AGENT must be at least 32`,
  },
  {
    name: "secret equal to TOKEN_INTERNAL",
    env: envWith([tokenEntry()], { TOKEN_TEST_AGENT: mainConfig.TOKEN_INTERNAL }),
    field: `${T}.tokenEnv: the value of TOKEN_TEST_AGENT must differ`,
  },
  {
    name: "two tokens share a secret",
    env: envWith([tokenEntry(), tokenEntry({ name: "second", tokenEnv: "TOKEN_SECOND" })], {
      TOKEN_SECOND: SCOPED_SECRET,
    }),
    field: "SCOPED_TOKENS_JSON[1].tokenEnv: the value of TOKEN_SECOND is already used",
  },
  {
    name: "duplicate token names",
    env: envWith([tokenEntry(), tokenEntry({ tokenEnv: "TOKEN_SECOND" })], { TOKEN_SECOND: OTHER_SCOPED_SECRET }),
    field: 'SCOPED_TOKENS_JSON[1].name: "test-agent" is used twice',
  },
  { name: "allowFrom empty", env: envWith([tokenEntry({ allowFrom: [] })]), field: `${T}.allowFrom:` },
  {
    name: "allowFrom with a CIDR range",
    env: envWith([tokenEntry({ allowFrom: ["100.64.0.0/10"] })]),
    field: `${T}.allowFrom[0]:`,
  },
  {
    name: "allowFrom with a host name",
    env: envWith([tokenEntry({ allowFrom: ["agent-host"] })]),
    field: `${T}.allowFrom[0]:`,
  },
  { name: "writeDir is the vault root", env: envWith([tokenEntry({ writeDir: "" })]), field: `${T}.writeDir:` },
  {
    name: "writeDir escapes with ..",
    env: envWith([tokenEntry({ writeDir: "notes-inbox/../projects" })]),
    field: `${T}.writeDir:`,
  },
  { name: "writeDir is absolute", env: envWith([tokenEntry({ writeDir: "/notes-inbox" })]), field: `${T}.writeDir:` },
  {
    name: "writeDir with uppercase letters",
    env: envWith([tokenEntry({ writeDir: "Notes-Inbox" })]),
    field: `${T}.writeDir:`,
  },
  { name: "writeDir is a dot folder", env: envWith([tokenEntry({ writeDir: ".claude" })]), field: `${T}.writeDir:` },
  {
    name: "writeDir with a reserved name",
    env: envWith([tokenEntry({ writeDir: "agent-inbox" })]),
    field: `${T}.writeDir:`,
  },
  {
    name: "readDeny entry escapes with ..",
    env: envWith([tokenEntry({ readDeny: ["../outside"] })]),
    field: `${T}.readDeny[0]:`,
  },
  {
    name: "readDeny entry is the vault root",
    env: envWith([tokenEntry({ readDeny: ["."] })]),
    field: `${T}.readDeny[0]:`,
  },
  {
    name: "readDeny covers writeDir",
    env: envWith([tokenEntry({ readDeny: ["Notes-Inbox"] })]),
    field: `${T}.readDeny[0]: overlaps writeDir`,
  },
  {
    name: "readDeny names the namesake note of writeDir (x.md covers x/)",
    env: envWith([tokenEntry({ readDeny: ["notes-inbox.md"] })]),
    field: `${T}.readDeny[0]: overlaps writeDir`,
  },
  {
    name: "readDeny lies inside writeDir",
    env: envWith([tokenEntry({ readDeny: ["notes-inbox/private"] })]),
    field: `${T}.readDeny[0]: overlaps writeDir`,
  },
  {
    name: "readDeny is a parent of writeDir",
    env: envWith([tokenEntry({ writeDir: "inbox/notes", readDeny: ["inbox"] })]),
    field: `${T}.readDeny[0]: overlaps writeDir`,
  },
  // Only exactly "/" means the whole vault: anything that merely reduces to the root stays an error.
  { name: 'writeDir "//" (not the explicit "/")', env: envWith([tokenEntry({ writeDir: "//" })]), field: `${T}.writeDir:` },
  {
    name: "writeDeny escapes with ..",
    env: envWith([tokenEntry({ writeDir: "/", writeDeny: ["../outside"] })]),
    field: `${T}.writeDeny[0]:`,
  },
  {
    name: "writeDeny is the vault root",
    env: envWith([tokenEntry({ writeDir: "/", writeDeny: ["/"] })]),
    field: `${T}.writeDeny[0]:`,
  },
  {
    name: "writeDeny is not a list",
    env: envWith([tokenEntry({ writeDir: "/", writeDeny: "03-resources" })]),
    field: `${T}.writeDeny:`,
  },
  { name: "expiresAt missing", env: envWith([tokenEntry({ expiresAt: undefined })]), field: `${T}.expiresAt:` },
  {
    name: "expiresAt is not a date",
    env: envWith([tokenEntry({ expiresAt: "in 90 days" })]),
    field: `${T}.expiresAt:`,
  },
  { name: "writesPerHour is zero", env: envWith([tokenEntry({ writesPerHour: 0 })]), field: `${T}.writesPerHour:` },
  {
    name: "frontmatter sets tags (use the tags field)",
    env: envWith([tokenEntry({ frontmatter: { tags: "x" } })]),
    field: `${T}.frontmatter:`,
  },
  {
    name: "frontmatter value is an object",
    env: envWith([tokenEntry({ frontmatter: { source: { a: 1 } } })]),
    field: `${T}.frontmatter.source:`,
  },
  { name: "tag with a space", env: envWith([tokenEntry({ tags: ["two words"] })]), field: `${T}.tags[0]:` },
];

for (const { name, env, field } of invalidCases) {
  test(`an invalid scoped config is rejected as a whole: ${name}`, () => {
    const setup = loadScopedConfig(env, mainConfig);
    assert.equal(setup.status, "invalid");
    if (setup.status !== "invalid") return;
    assert.ok(
      setup.errors.some((error) => error.startsWith(field)),
      `expected an error starting with ${JSON.stringify(field)}, got ${JSON.stringify(setup.errors)}`,
    );
    // Error output ends up in logs: it must never echo a secret value.
    for (const error of setup.errors) {
      assert.ok(!error.includes(SCOPED_SECRET));
      assert.ok(!error.includes(mainConfig.TOKEN_INTERNAL));
    }
  });
}

test("allowFrom addresses are stored in canonical form, so they match the socket address", () => {
  const setup = loadScopedConfig(
    envWith([tokenEntry({ allowFrom: ["FD7A:115C:A1E0:0:0:0:0:1", "::ffff:192.0.2.10", "100.64.0.10"] })]),
    mainConfig,
  );
  assert.equal(setup.status, "enabled");
  if (setup.status !== "enabled") return;
  assert.deepEqual(setup.tokens[0].allowFrom, ["fd7a:115c:a1e0::1", "192.0.2.10", "100.64.0.10"]);
  assert.equal(normalizeAddress("::FFFF:100.64.0.10"), "100.64.0.10");
  assert.equal(normalizeAddress("fd7a:115c:a1e0:0000::0001"), "fd7a:115c:a1e0::1");
});

test("SCOPED_HOST is optional: unset means all interfaces, an IP address is taken over", () => {
  const all = loadScopedConfig(envWith([tokenEntry()]), mainConfig);
  assert.equal(all.status, "enabled");
  assert.equal(all.status === "enabled" ? all.host : "x", undefined);
  const one = loadScopedConfig({ ...envWith([tokenEntry()]), SCOPED_HOST: "100.64.0.1" }, mainConfig);
  assert.equal(one.status === "enabled" ? one.host : "x", "100.64.0.1");
});

test("startServers binds the scoped listener to SCOPED_HOST when it is set", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "start-vault-"));
  const log = { info: () => {}, error: () => {} };
  const servers = await startServers(
    makeTestConfig(vaultRoot),
    { ...envWith([tokenEntry()]), SCOPED_PORT: "0", SCOPED_HOST: "127.0.0.1" },
    log,
  );
  try {
    assert.equal((servers.scoped!.address() as AddressInfo).address, "127.0.0.1");
  } finally {
    await new Promise((resolve) => servers.main.close(resolve));
    await new Promise((resolve) => servers.scoped!.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

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
