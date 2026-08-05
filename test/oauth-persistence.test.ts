import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadState, saveState, type PersistedState } from "../src/oauth/persistence.js";
import { base64url, withTestServer } from "./helpers.js";

test("loadState returns an empty store when the file doesn't exist yet", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oauth-persist-"));
  try {
    const state = loadState(path.join(dir, "does-not-exist.json"));
    assert.deepEqual(state, { clients: [], accessTokens: [], refreshTokens: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveState/loadState round-trips clients and tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oauth-persist-"));
  try {
    const filePath = path.join(dir, "nested", "oauth-store.json");
    const state: PersistedState = {
      clients: [{ id: "client-1", redirectUris: ["https://a.example/cb"], grants: ["authorization_code"] }],
      accessTokens: [{ token: "at-1", clientId: "client-1", userId: "owner", expiresAt: new Date().toISOString() }],
      refreshTokens: [{ token: "rt-1", clientId: "client-1", userId: "owner" }],
    };

    saveState(filePath, state);
    const loaded = loadState(filePath);
    assert.deepEqual(loaded, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a completed OAuth flow writes the client and refresh token to the store file on disk", async () => {
  await withTestServer(async (baseUrl, config) => {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

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
        code_verifier: verifier,
      }),
    });
    const tokenBody = (await tokenRes.json()) as { refresh_token: string };
    assert.ok(tokenBody.refresh_token);

    const onDisk = JSON.parse(await readFile(config.OAUTH_STORE_PATH, "utf-8")) as PersistedState;
    assert.ok(onDisk.clients.some((c) => c.id === config.OAUTH_CLIENT_ID));
    assert.ok(onDisk.refreshTokens.some((t) => t.token === tokenBody.refresh_token && t.clientId === config.OAUTH_CLIENT_ID));
  });
});
