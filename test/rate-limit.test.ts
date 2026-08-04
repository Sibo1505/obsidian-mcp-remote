import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

async function withTestServer(fn: (baseUrl: string) => Promise<void>) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "rate-limit-vault-"));
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

test("/oauth/authorize is rate-limited after repeated password guesses", async () => {
  await withTestServer(async (baseUrl) => {
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        body: new URLSearchParams({
          password: "wrong-guess",
          client_id: "preregistered-client",
          redirect_uri: "https://claude.ai/CHANGEME",
          response_type: "code",
          state: "xyz",
          code_challenge: "challenge",
          code_challenge_method: "S256",
        }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});

test("/register is rate-limited after repeated registrations", async () => {
  await withTestServer(async (baseUrl) => {
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:9999/callback-${i}`] }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});
