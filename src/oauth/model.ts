import type OAuth2Server from "@node-oauth/oauth2-server";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";
import { loadState, saveState, type PersistedToken } from "./persistence.js";

export interface StoredClient extends OAuth2Server.Client {
  id: string;
  redirectUris: string[];
  grants: string[];
  clientSecret?: string;
  clientName?: string;
  registeredAt?: string;
}

// SEC-004: originally guarded against DCR (/register) spam; that endpoint has since been removed
// entirely, but this pruning stays as general hygiene against expired tokens and any abandoned
// client record with a registeredAt timestamp piling up unbounded.
const CLIENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const clients = new Map<string, StoredClient>();
const authorizationCodes = new Map<string, OAuth2Server.AuthorizationCode>();
const accessTokens = new Map<string, OAuth2Server.Token>();
const refreshTokens = new Map<string, OAuth2Server.RefreshToken>();

let storePath: string | undefined;

function userId(user: OAuth2Server.User | undefined): string {
  return (user as { id?: string } | undefined)?.id ?? "owner";
}

function persist(): void {
  if (!storePath) return;
  const toPersistedToken = (accessOrRefreshToken: string, expiresAt: Date | undefined, scope: OAuth2Server.Token["scope"], client: OAuth2Server.Client, user: OAuth2Server.User): PersistedToken => ({
    token: accessOrRefreshToken,
    expiresAt: expiresAt?.toISOString(),
    scope: Array.isArray(scope) ? scope : undefined,
    clientId: (client as StoredClient).id,
    userId: userId(user),
  });

  saveState(storePath, {
    clients: [...clients.values()].map((c) => ({
      id: c.id,
      redirectUris: c.redirectUris,
      grants: c.grants,
      clientSecret: c.clientSecret,
      clientName: c.clientName,
      registeredAt: c.registeredAt,
    })),
    accessTokens: [...accessTokens.values()].map((t) =>
      toPersistedToken(t.accessToken, t.accessTokenExpiresAt, t.scope, t.client, t.user),
    ),
    refreshTokens: [...refreshTokens.values()]
      .filter((t): t is OAuth2Server.RefreshToken & { refreshToken: string } => !!t.refreshToken)
      .map((t) => toPersistedToken(t.refreshToken, t.refreshTokenExpiresAt, t.scope, t.client, t.user)),
  });
}

/**
 * Loads previously persisted clients/tokens back into memory and switches persist() on for
 * subsequent writes. Call once at startup, before any requests are served — without this the
 * store behaves exactly as before (in-memory only), which is what tests rely on.
 *
 * Also prunes on the way in (SEC-004): expired tokens are dropped rather than reloaded, and DCR
 * clients older than CLIENT_RETENTION_MS with no surviving token are removed. The preregistered
 * client (no registeredAt) is never touched by this.
 */
export function initStore(filePath: string): void {
  const state = loadState(filePath);
  const user = { id: "owner" };
  const now = Date.now();
  let changed = false;

  for (const c of state.clients) {
    clients.set(c.id, { ...c });
  }

  const referencedClientIds = new Set<string>();

  for (const t of state.accessTokens) {
    if (t.expiresAt && new Date(t.expiresAt).getTime() < now) {
      changed = true;
      continue;
    }
    const client = clients.get(t.clientId);
    if (!client) continue;
    referencedClientIds.add(t.clientId);
    accessTokens.set(t.token, {
      accessToken: t.token,
      accessTokenExpiresAt: t.expiresAt ? new Date(t.expiresAt) : undefined,
      scope: t.scope,
      client,
      user,
    });
  }
  for (const t of state.refreshTokens) {
    if (t.expiresAt && new Date(t.expiresAt).getTime() < now) {
      changed = true;
      continue;
    }
    const client = clients.get(t.clientId);
    if (!client) continue;
    referencedClientIds.add(t.clientId);
    refreshTokens.set(t.token, {
      refreshToken: t.token,
      refreshTokenExpiresAt: t.expiresAt ? new Date(t.expiresAt) : undefined,
      scope: t.scope,
      client,
      user,
    });
  }

  for (const c of state.clients) {
    if (!c.registeredAt) continue; // preregistered client — permanent
    if (referencedClientIds.has(c.id)) continue; // has a live token
    if (now - new Date(c.registeredAt).getTime() < CLIENT_RETENTION_MS) continue; // still fresh
    clients.delete(c.id);
    changed = true;
  }

  storePath = filePath;
  if (changed) persist();
}

export function registerClient(client: StoredClient): void {
  clients.set(client.id, client);
  persist();
}

export function findClient(clientId: string): StoredClient | undefined {
  return clients.get(clientId);
}

export function checkOAuthPassword(candidate: string, expected: string): boolean {
  return timingSafeEqualStrings(candidate, expected);
}

type Model = OAuth2Server.AuthorizationCodeModel &
  Pick<OAuth2Server.RefreshTokenModel, "getRefreshToken" | "revokeToken">;

export function createModel(): Model {
  return {
    async getClient(clientId, clientSecret) {
      const client = clients.get(clientId);
      if (!client) return false;
      // The library's AuthorizeHandler always calls this with clientSecret === null by design
      // (RFC 6749: the /authorize step never authenticates the client, only /token does) — only
      // the token endpoint ever passes a real value (or omits the argument entirely for public
      // clients). Skip the check for that specific null sentinel, or every confidential client
      // (e.g. the preregistered claude.ai client) would get rejected before reaching /authorize.
      if (client.clientSecret && clientSecret !== null) {
        if (!clientSecret || !timingSafeEqualStrings(clientSecret, client.clientSecret)) return false;
      }
      return client;
    },

    async validateRedirectUri(redirectUri, client) {
      const stored = client as StoredClient;
      return stored.redirectUris.includes(redirectUri);
    },

    async saveAuthorizationCode(code, client, user) {
      const record: OAuth2Server.AuthorizationCode = {
        authorizationCode: code.authorizationCode,
        expiresAt: code.expiresAt,
        redirectUri: code.redirectUri,
        scope: code.scope,
        client,
        user,
        codeChallenge: code.codeChallenge,
        codeChallengeMethod: code.codeChallengeMethod,
      };
      authorizationCodes.set(record.authorizationCode, record);
      return record;
    },

    async getAuthorizationCode(authorizationCode) {
      return authorizationCodes.get(authorizationCode) ?? false;
    },

    async revokeAuthorizationCode(code) {
      return authorizationCodes.delete(code.authorizationCode);
    },

    async saveToken(token, client, user) {
      const record: OAuth2Server.Token = {
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
        refreshTokenExpiresAt: token.refreshTokenExpiresAt,
        scope: token.scope,
        client,
        user,
      };
      accessTokens.set(record.accessToken, record);
      if (record.refreshToken) {
        refreshTokens.set(record.refreshToken, {
          refreshToken: record.refreshToken,
          refreshTokenExpiresAt: record.refreshTokenExpiresAt,
          scope: record.scope,
          client,
          user,
        });
      }
      persist();
      return record;
    },

    async getAccessToken(accessToken) {
      return accessTokens.get(accessToken) ?? false;
    },

    async getRefreshToken(refreshToken) {
      return refreshTokens.get(refreshToken) ?? false;
    },

    async revokeToken(token) {
      const deleted = refreshTokens.delete(token.refreshToken);
      persist();
      return deleted;
    },
  };
}
