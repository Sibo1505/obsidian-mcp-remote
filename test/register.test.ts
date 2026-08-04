import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

async function withTestServer(fn: (baseUrl: string) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "register-vault-"));
  const config: Config = {
    VAULT_PATH: vaultRoot,
    TOKEN_INTERNAL: "a".repeat(32),
    DOMAIN: "test.local",
    PORT: 0,
    OAUTH_PASSWORD: "correct-horse-battery-staple",
    OAUTH_CLIENT_ID: "preregistered-client",
    OAUTH_CLIENT_SECRET: "b".repeat(32),
    OAUTH_CLIENT_REDIRECT_URI: "https://claude.ai/CHANGEME",
    OAUTH_STORE_PATH: path.join(vaultRoot, "oauth-store.json"),
    WEBAUTHN_STORE_PATH: path.join(vaultRoot, "webauthn-credential.json"),
  };

  const app = createApp(config);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

async function register(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("register accepts a loopback 127.0.0.1 redirect_uri", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["http://127.0.0.1:51234/cb"] });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
    assert.ok(body.client_id);
    assert.equal(body.token_endpoint_auth_method, "none");
  });
});

test("register accepts a loopback localhost redirect_uri", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["http://localhost:51234/cb"] });
    assert.equal(res.status, 201);
  });
});

// SEC-001 fix: DCR previously accepted any https:// redirect_uri, letting anyone self-register a
// client whose authorization code (and therefore full vault read/write access) gets delivered to a
// server they control, via nothing but a link + Sebastian's own password/passkey on the consent
// screen. DCR only exists to serve the loopback-based Desktop/CLI flow — a real https:// target has
// no legitimate DCR use case here (the claude.ai Custom Connector uses the preregistered client).
test("register rejects a public https:// redirect_uri (SEC-001 regression test)", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["https://attacker.example/callback"] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });
});

test("register rejects a non-loopback http:// redirect_uri", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["http://evil.example/cb"] });
    assert.equal(res.status, 400);
  });
});

test("register rejects a redirect_uri using an unrelated scheme", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["javascript:alert(1)"] });
    assert.equal(res.status, 400);
  });
});

test("register rejects an unparseable redirect_uri", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: ["not-a-url"] });
    assert.equal(res.status, 400);
  });
});

test("register rejects the whole request if any one of several redirect_uris is disallowed", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, {
      redirect_uris: ["http://127.0.0.1:51234/cb", "https://attacker.example/callback"],
    });
    assert.equal(res.status, 400);
  });
});

test("register rejects a request with no redirect_uris at all", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await register(baseUrl, { redirect_uris: [] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_client_metadata");
  });
});

test("register echoes back client_name and issues distinct client_ids across calls", async () => {
  await withTestServer(async (baseUrl) => {
    const first = await register(baseUrl, { redirect_uris: ["http://127.0.0.1:1/cb"], client_name: "My Client" });
    const second = await register(baseUrl, { redirect_uris: ["http://127.0.0.1:2/cb"], client_name: "My Client" });
    const firstBody = (await first.json()) as { client_id: string; client_name: string };
    const secondBody = (await second.json()) as { client_id: string; client_name: string };
    assert.equal(firstBody.client_name, "My Client");
    assert.notEqual(firstBody.client_id, secondBody.client_id);
  });
});
