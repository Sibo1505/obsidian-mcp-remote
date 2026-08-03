import type OAuth2Server from "@node-oauth/oauth2-server";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";

export interface StoredClient extends OAuth2Server.Client {
  id: string;
  redirectUris: string[];
  grants: string[];
  clientSecret?: string;
}

const clients = new Map<string, StoredClient>();
const authorizationCodes = new Map<string, OAuth2Server.AuthorizationCode>();
const accessTokens = new Map<string, OAuth2Server.Token>();
const refreshTokens = new Map<string, OAuth2Server.RefreshToken>();

export function registerClient(client: StoredClient): void {
  clients.set(client.id, client);
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
      // Public clients (dynamically registered via DCR) have no secret — PKCE is their security boundary.
      if (client.clientSecret) {
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
      return record;
    },

    async getAccessToken(accessToken) {
      return accessTokens.get(accessToken) ?? false;
    },

    async getRefreshToken(refreshToken) {
      return refreshTokens.get(refreshToken) ?? false;
    },

    async revokeToken(token) {
      return refreshTokens.delete(token.refreshToken);
    },
  };
}
