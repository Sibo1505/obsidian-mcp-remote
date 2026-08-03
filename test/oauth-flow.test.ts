import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function withTestServer(fn: (baseUrl: string, config: Config) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "oauth-flow-vault-"));
  const config: Config = {
    VAULT_PATH: vaultRoot,
    TOKEN_INTERNAL: "a".repeat(32),
    DOMAIN: "test.local",
    PORT: 0,
    OAUTH_PASSWORD: "correct-horse-battery-staple",
    OAUTH_CLIENT_ID: "preregistered-client",
    OAUTH_CLIENT_SECRET: "b".repeat(32),
    OAUTH_CLIENT_REDIRECT_URI: "https://claude.ai/CHANGEME",
  };

  const app = createApp(config);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl, config);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

test("full OAuth flow: register -> authorize -> token -> authenticated /mcp call", async () => {
  await withTestServer(async (baseUrl) => {
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
    });
    assert.equal(registerRes.status, 201);
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };
    assert.ok(clientId);

    const { verifier, challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    assert.equal(authorizeRes.status, 302);
    const location = new URL(authorizeRes.headers.get("location")!);
    const code = location.searchParams.get("code");
    assert.ok(code);
    assert.equal(location.searchParams.get("state"), "xyz");

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1:9999/callback",
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    assert.ok(tokenBody.access_token);

    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(mcpRes.status, 200);
    const mcpText = await mcpRes.text();
    assert.match(mcpText, /vault_read/);
    assert.match(mcpText, /search_query/);
  });
});

test("wrong PKCE code_verifier is rejected at the token endpoint", async () => {
  await withTestServer(async (baseUrl) => {
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
    });
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };
    const { challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code");

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1:9999/callback",
        client_id: clientId,
        code_verifier: "this-is-not-the-right-verifier",
      }),
    });
    assert.equal(tokenRes.status, 400);
  });
});

test("wrong password at /oauth/authorize is rejected", async () => {
  await withTestServer(async (baseUrl) => {
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
    });
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };
    const { challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "totally-wrong-password",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/callback",
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    assert.equal(authorizeRes.status, 403);
  });
});

test("/mcp still accepts the static TOKEN_INTERNAL bearer alongside OAuth", async () => {
  await withTestServer(async (baseUrl, config) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.TOKEN_INTERNAL}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 200);
  });
});

test("/mcp rejects requests with no valid credential at all", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 401);
  });
});
