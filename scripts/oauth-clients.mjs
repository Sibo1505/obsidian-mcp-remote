#!/usr/bin/env node
// Lists and revokes registered OAuth clients directly against the persisted store file (SEC-002).
// This is the only way to see or undo a consent grant on a single-user tool with no admin UI —
// intentionally a local file-editing script rather than an HTTP endpoint, so it doesn't add another
// unauthenticated attack surface next to the already-open /register endpoint (SEC-001).
//
// Note: the running server only reads this file once at startup (see oauth/model.ts initStore).
// A revoke here has no effect on an already-issued access token until the container restarts.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

const storePath = process.env.OAUTH_STORE_PATH ?? path.join(process.cwd(), "data", "oauth-store.json");
const EMPTY_STATE = { clients: [], accessTokens: [], refreshTokens: [] };

function loadStore() {
  try {
    return JSON.parse(readFileSync(storePath, "utf-8"));
  } catch {
    return EMPTY_STATE;
  }
}

function saveStore(state) {
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, storePath);
}

function listClients() {
  const state = loadStore();
  if (state.clients.length === 0) {
    console.log("No registered clients.");
    return;
  }
  for (const client of state.clients) {
    const hasLiveToken =
      state.accessTokens.some((t) => t.clientId === client.id) || state.refreshTokens.some((t) => t.clientId === client.id);
    console.log(`- ${client.id}`);
    console.log(`    name:          ${client.clientName ?? "(none)"}`);
    console.log(`    redirect_uris: ${client.redirectUris.join(", ")}`);
    console.log(`    registered_at: ${client.registeredAt ?? "(preregistered — permanent, never auto-pruned)"}`);
    console.log(`    has_live_token: ${hasLiveToken}`);
  }
}

function revokeClient(clientId) {
  if (!clientId) {
    console.error("Usage: node scripts/oauth-clients.mjs revoke <client_id>");
    process.exit(1);
  }
  const state = loadStore();
  const before = state.clients.length;
  state.clients = state.clients.filter((c) => c.id !== clientId);
  if (state.clients.length === before) {
    console.error(`No client found with id ${clientId}`);
    process.exit(1);
  }
  state.accessTokens = state.accessTokens.filter((t) => t.clientId !== clientId);
  state.refreshTokens = state.refreshTokens.filter((t) => t.clientId !== clientId);
  saveStore(state);
  console.log(`Revoked client ${clientId} and its tokens.`);
  console.log("Restart the server (docker compose restart) for this to take effect.");
}

const [, , command, ...args] = process.argv;
switch (command) {
  case "list":
    listClients();
    break;
  case "revoke":
    revokeClient(args[0]);
    break;
  default:
    console.log("Usage:");
    console.log("  node scripts/oauth-clients.mjs list");
    console.log("  node scripts/oauth-clients.mjs revoke <client_id>");
    process.exit(command ? 1 : 0);
}
