import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { base64url, withTestServer } from "./helpers.js";
import { registerClient } from "../src/oauth/model.js";

function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

test("full OAuth flow: authorize -> token -> authenticated /mcp call (preregistered client)", async () => {
  await withTestServer(async (baseUrl, config) => {
    const { verifier, challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
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
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
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
  await withTestServer(async (baseUrl, config) => {
    const { challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
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
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
        code_verifier: "this-is-not-the-right-verifier",
      }),
    });
    assert.equal(tokenRes.status, 400);
  });
});

test("wrong password at /oauth/authorize is rejected", async () => {
  await withTestServer(async (baseUrl, config) => {
    const { challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "totally-wrong-password",
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    assert.equal(authorizeRes.status, 403);
  });
});

// trust proxy is set to 1 hop, so the test's direct (loopback) connection is trusted as that one
// hop and an X-Forwarded-For header is honored - this simulates what a genuine Tailscale-origin
// request looks like (a real Tailscale peer IP, as NPM/the direct Tailscale-bound port would
// actually report it), without needing a real Tailscale network in the test.
test("/mcp accepts the static TOKEN_INTERNAL bearer from a Tailscale-range address", async () => {
  await withTestServer(async (baseUrl, config) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.TOKEN_INTERNAL}`,
        "X-Forwarded-For": "100.95.229.27",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 200);
  });
});

// The two-zone model is worthless if TOKEN_INTERNAL works from anywhere the moment it leaks - this
// is the regression test for that fix. No X-Forwarded-For here falls back to the raw (non-Tailscale)
// loopback test-connection address, standing in for a real public-internet request.
test("/mcp rejects the correct TOKEN_INTERNAL bearer from a non-Tailscale address", async () => {
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
    assert.equal(res.status, 401);
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

test("consent screen shows the registered client_name instead of the raw client_id", async () => {
  await withTestServer(async (baseUrl) => {
    const clientId = "named-test-client";
    registerClient({
      id: clientId,
      redirectUris: ["http://127.0.0.1:9999/callback"],
      grants: ["authorization_code"],
      clientName: "My Test MCP Client",
    });

    const formRes = await fetch(`${baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=http://127.0.0.1:9999/callback&response_type=code`);
    const html = await formRes.text();
    assert.match(html, /My Test MCP Client/);
  });
});

test("refresh grant rotates the refresh token: old one stops working, new one differs", async () => {
  await withTestServer(async (baseUrl, config) => {
    const { verifier, challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code");

    const firstTokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
        code_verifier: verifier,
      }),
    });
    const firstTokens = (await firstTokenRes.json()) as { refresh_token: string };

    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: firstTokens.refresh_token,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
      }),
    });
    assert.equal(refreshRes.status, 200);
    const secondTokens = (await refreshRes.json()) as { refresh_token: string };
    assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);

    const reuseRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: firstTokens.refresh_token,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
      }),
    });
    assert.equal(reuseRes.status, 400);
  });
});

test("consent screen falls back to the raw client_id when no client_name was registered", async () => {
  await withTestServer(async (baseUrl) => {
    const clientId = "unnamed-test-client";
    registerClient({
      id: clientId,
      redirectUris: ["http://127.0.0.1:9999/callback"],
      grants: ["authorization_code"],
    });

    const formRes = await fetch(`${baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=http://127.0.0.1:9999/callback&response_type=code`);
    const html = await formRes.text();
    assert.match(html, new RegExp(clientId));
  });
});

// claude.ai's Custom Connector flow was observed hitting /authorize and /token directly (no
// /oauth prefix), ignoring the discovery metadata that correctly advertises /oauth/authorize and
// /oauth/token. These aliases exist specifically for that client.
test("full OAuth flow works via the root-level /authorize and /token aliases (preregistered client, no DCR)", async () => {
  await withTestServer(async (baseUrl, config) => {
    const { verifier, challenge } = makePkcePair();

    const authorizeRes = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: config.OAUTH_CLIENT_ID,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        response_type: "code",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    assert.equal(authorizeRes.status, 302);
    const code = new URL(authorizeRes.headers.get("location")!).searchParams.get("code");
    assert.ok(code);

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: config.OAUTH_CLIENT_REDIRECT_URI,
        client_id: config.OAUTH_CLIENT_ID,
        client_secret: config.OAUTH_CLIENT_SECRET,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    assert.ok(tokenBody.access_token);
  });
});
