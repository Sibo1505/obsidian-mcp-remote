import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

async function withTestServer(fn: (baseUrl: string) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "discovery-vault-"));
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

test("GET /health reports ok", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /.well-known/oauth-authorization-server advertises the oauth-prefixed endpoints and mandatory PKCE", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${baseUrl}/oauth/token`);
    assert.equal(body.registration_endpoint, `${baseUrl}/register`);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  });
});

test("GET /.well-known/oauth-protected-resource advertises this server as its own authorization server", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(body.resource, `${baseUrl}/mcp`);
    assert.deepEqual(body.authorization_servers, [baseUrl]);
  });
});

test("helmet security headers are present on a plain response", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.ok(res.headers.get("x-content-type-options"));
    assert.ok(res.headers.get("content-security-policy"));
  });
});

// A client_name is attacker-controlled input (set via the unauthenticated /register endpoint) that
// gets rendered into the HTML consent screen. If it were interpolated unescaped, a self-registered
// client named e.g. `<script>...</script>` would run arbitrary JS in Sebastian's browser on the
// same page where he enters his OAuth password — turning consent phishing (SEC-001) into outright
// credential theft. This is the end-to-end proof that authorize-view.ts's escapeHtml() holds up
// against the real request path, not just against a hand-built params object.
test("a malicious client_name is HTML-escaped end-to-end on the authorize consent screen", async () => {
  await withTestServer(async (baseUrl) => {
    const maliciousName = '<script>alert("stolen")</script>';
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/cb"], client_name: maliciousName }),
    });
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

    const authorizeRes = await fetch(
      `${baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=http://127.0.0.1:9999/cb&response_type=code`,
    );
    const html = await authorizeRes.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(&quot;stolen&quot;\)&lt;\/script&gt;/);
  });
});
