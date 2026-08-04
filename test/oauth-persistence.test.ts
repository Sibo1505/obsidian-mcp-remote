import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadState, saveState, type PersistedState } from "../src/oauth/persistence.js";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

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
      accessTokens: [{ token: "at-1", clientId: "client-1", userId: "sebastian", expiresAt: new Date().toISOString() }],
      refreshTokens: [{ token: "rt-1", clientId: "client-1", userId: "sebastian" }],
    };

    saveState(filePath, state);
    const loaded = loadState(filePath);
    assert.deepEqual(loaded, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("a completed OAuth flow writes the client and refresh token to the store file on disk", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "oauth-persist-vault-"));
  const storePath = path.join(vaultRoot, "oauth-store.json");
  const config: Config = {
    VAULT_PATH: vaultRoot,
    TOKEN_INTERNAL: "a".repeat(32),
    DOMAIN: "test.local",
    PORT: 0,
    OAUTH_PASSWORD: "correct-horse-battery-staple",
    OAUTH_CLIENT_ID: "preregistered-client-persist",
    OAUTH_CLIENT_SECRET: "b".repeat(32),
    OAUTH_CLIENT_REDIRECT_URI: "https://claude.ai/CHANGEME",
    OAUTH_STORE_PATH: storePath,
  };

  const app = createApp(config);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/persist-callback"] }),
    });
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

    const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        password: "correct-horse-battery-staple",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:9999/persist-callback",
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
        redirect_uri: "http://127.0.0.1:9999/persist-callback",
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const tokenBody = (await tokenRes.json()) as { refresh_token: string };
    assert.ok(tokenBody.refresh_token);

    const onDisk = JSON.parse(await readFile(storePath, "utf-8")) as PersistedState;
    assert.ok(onDisk.clients.some((c) => c.id === clientId));
    assert.ok(onDisk.refreshTokens.some((t) => t.token === tokenBody.refresh_token && t.clientId === clientId));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
