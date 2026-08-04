import assert from "node:assert/strict";
import { test } from "node:test";
import { createModel, registerClient } from "../src/oauth/model.js";

test("saveAuthorizationCode/getAuthorizationCode round-trips PKCE fields", async () => {
  const model = createModel();
  const client = { id: "client-1", redirectUris: ["http://localhost:9999/cb"], grants: ["authorization_code"] };
  registerClient(client);
  const user = { id: "owner" };

  const saved = await model.saveAuthorizationCode(
    {
      authorizationCode: "test-code-1",
      expiresAt: new Date(Date.now() + 60_000),
      redirectUri: "http://localhost:9999/cb",
      scope: [],
      codeChallenge: "abc123",
      codeChallengeMethod: "S256",
    },
    client,
    user,
  );
  assert.ok(saved);

  const loaded = await model.getAuthorizationCode("test-code-1");
  assert.ok(loaded);
  if (!loaded) return;
  assert.equal(loaded.codeChallenge, "abc123");
  assert.equal(loaded.codeChallengeMethod, "S256");
  assert.equal(loaded.redirectUri, "http://localhost:9999/cb");
});

test("getClient rejects a mismatched secret for a confidential client", async () => {
  const model = createModel();
  registerClient({
    id: "client-confidential",
    clientSecret: "correct-secret",
    redirectUris: ["https://example.com/cb"],
    grants: ["authorization_code"],
  });

  const wrong = await model.getClient("client-confidential", "wrong-secret");
  assert.equal(wrong, false);

  const right = await model.getClient("client-confidential", "correct-secret");
  assert.ok(right);
});

test("getClient accepts a confidential client when called with clientSecret=null, matching AuthorizeHandler's internal call", async () => {
  const model = createModel();
  registerClient({
    id: "client-confidential-2",
    clientSecret: "correct-secret",
    redirectUris: ["https://example.com/cb"],
    grants: ["authorization_code"],
  });

  const result = await model.getClient("client-confidential-2", null as unknown as string);
  assert.ok(result);
});

test("getClient accepts a public client without a secret", async () => {
  const model = createModel();
  registerClient({
    id: "client-public",
    redirectUris: ["http://localhost:1234/cb"],
    grants: ["authorization_code"],
  });

  const result = await model.getClient("client-public", undefined as unknown as string);
  assert.ok(result);
});

test("validateRedirectUri only accepts a registered redirect URI", async () => {
  const model = createModel();
  const client = { id: "client-2", redirectUris: ["https://a.example/cb"], grants: ["authorization_code"] };
  registerClient(client);

  assert.equal(await model.validateRedirectUri!("https://a.example/cb", client), true);
  assert.equal(await model.validateRedirectUri!("https://evil.example/cb", client), false);
});

test("refresh token round-trip via saveToken/getRefreshToken/revokeToken", async () => {
  const model = createModel();
  const client = { id: "client-3", redirectUris: ["https://a.example/cb"], grants: ["authorization_code", "refresh_token"] };
  registerClient(client);
  const user = { id: "owner" };

  await model.saveToken(
    {
      accessToken: "access-1",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshToken: "refresh-1",
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: [],
    },
    client,
    user,
  );

  const found = await model.getRefreshToken("refresh-1");
  assert.ok(found);
  if (!found) return;
  assert.equal(found.refreshToken, "refresh-1");

  const revoked = await model.revokeToken(found);
  assert.equal(revoked, true);
  assert.equal(await model.getRefreshToken("refresh-1"), false);
});
