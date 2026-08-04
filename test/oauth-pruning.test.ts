import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStore, findClient } from "../src/oauth/model.js";
import { saveState, type PersistedState } from "../src/oauth/persistence.js";

// SEC-004: /register is unauthenticated, so the store must not grow forever. initStore() prunes on
// load — these tests exercise that directly against a hand-built store file rather than going
// through a full register->authorize->token cycle for every case.

const DAY_MS = 24 * 60 * 60 * 1000;

async function withStoreFile(state: PersistedState, fn: (storePath: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "oauth-pruning-"));
  const storePath = path.join(dir, "oauth-store.json");
  saveState(storePath, state);
  try {
    await fn(storePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("initStore drops an expired access token instead of loading it", async () => {
  const expiredIso = new Date(Date.now() - 60_000).toISOString();
  await withStoreFile(
    {
      clients: [{ id: "client-expired-at", redirectUris: ["http://127.0.0.1:1/cb"], grants: ["authorization_code"] }],
      accessTokens: [{ token: "expired-access", clientId: "client-expired-at", userId: "owner", expiresAt: expiredIso }],
      refreshTokens: [],
    },
    async (storePath) => {
      initStore(storePath);
      const onDisk = JSON.parse(await readFile(storePath, "utf-8")) as PersistedState;
      assert.ok(!onDisk.accessTokens.some((t) => t.token === "expired-access"));
    },
  );
});

test("initStore drops an expired refresh token instead of loading it", async () => {
  const expiredIso = new Date(Date.now() - 60_000).toISOString();
  await withStoreFile(
    {
      clients: [{ id: "client-expired-rt", redirectUris: ["http://127.0.0.1:1/cb"], grants: ["refresh_token"] }],
      accessTokens: [],
      refreshTokens: [{ token: "expired-refresh", clientId: "client-expired-rt", userId: "owner", expiresAt: expiredIso }],
    },
    async (storePath) => {
      initStore(storePath);
      const onDisk = JSON.parse(await readFile(storePath, "utf-8")) as PersistedState;
      assert.ok(!onDisk.refreshTokens.some((t) => t.token === "expired-refresh"));
    },
  );
});

test("initStore prunes a DCR client past the retention window with no surviving token", async () => {
  const oldRegisteredAt = new Date(Date.now() - 31 * DAY_MS).toISOString();
  await withStoreFile(
    {
      clients: [
        { id: "abandoned-client", redirectUris: ["http://127.0.0.1:1/cb"], grants: ["authorization_code"], registeredAt: oldRegisteredAt },
      ],
      accessTokens: [],
      refreshTokens: [],
    },
    async (storePath) => {
      initStore(storePath);
      assert.equal(findClient("abandoned-client"), undefined);
      const onDisk = JSON.parse(await readFile(storePath, "utf-8")) as PersistedState;
      assert.ok(!onDisk.clients.some((c) => c.id === "abandoned-client"));
    },
  );
});

test("initStore keeps a DCR client that is still inside the retention window, even without a token", async () => {
  const recentRegisteredAt = new Date(Date.now() - 1 * DAY_MS).toISOString();
  await withStoreFile(
    {
      clients: [
        { id: "fresh-client", redirectUris: ["http://127.0.0.1:1/cb"], grants: ["authorization_code"], registeredAt: recentRegisteredAt },
      ],
      accessTokens: [],
      refreshTokens: [],
    },
    async (storePath) => {
      initStore(storePath);
      assert.ok(findClient("fresh-client"));
    },
  );
});

test("initStore keeps a DCR client past retention if it still has a live token", async () => {
  const oldRegisteredAt = new Date(Date.now() - 31 * DAY_MS).toISOString();
  const futureExpiry = new Date(Date.now() + DAY_MS).toISOString();
  await withStoreFile(
    {
      clients: [
        { id: "still-active-client", redirectUris: ["http://127.0.0.1:1/cb"], grants: ["authorization_code"], registeredAt: oldRegisteredAt },
      ],
      accessTokens: [{ token: "live-access", clientId: "still-active-client", userId: "owner", expiresAt: futureExpiry }],
      refreshTokens: [],
    },
    async (storePath) => {
      initStore(storePath);
      assert.ok(findClient("still-active-client"));
    },
  );
});

test("initStore never prunes a client with no registeredAt (the preregistered client), regardless of age or token state", async () => {
  await withStoreFile(
    {
      clients: [{ id: "preregistered-client", redirectUris: ["https://claude.ai/CHANGEME"], grants: ["authorization_code"] }],
      accessTokens: [],
      refreshTokens: [],
    },
    async (storePath) => {
      initStore(storePath);
      assert.ok(findClient("preregistered-client"));
    },
  );
});
