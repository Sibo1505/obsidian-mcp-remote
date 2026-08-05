import assert from "node:assert/strict";
import { test } from "node:test";
import { withTestServer } from "./helpers.js";
import { registerClient } from "../src/oauth/model.js";

test("GET /health reports ok", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /.well-known/oauth-authorization-server advertises the oauth-prefixed endpoints and mandatory PKCE", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${baseUrl}/oauth/token`);
    // DCR was removed - no endpoint to advertise, and none should be implied.
    assert.equal(body.registration_endpoint, undefined);
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  });
});

test("GET /.well-known/oauth-protected-resource advertises this server as its own authorization server", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(body.resource, `${baseUrl}/mcp`);
    assert.deepEqual(body.authorization_servers, [baseUrl]);
  });
});

test("helmet security headers are present on a plain response", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.ok(res.headers.get("x-content-type-options"));
    assert.ok(res.headers.get("content-security-policy"));
  });
});

// A client_name is attacker-controlled input in general (DCR used to be the way an attacker could
// set one; DCR itself is gone now, but any client record with a name still gets rendered into the
// consent screen, so the escaping itself must keep holding regardless of how the client was
// registered). If it were interpolated unescaped, a client named e.g. `<script>...</script>` would
// run arbitrary JS in Sebastian's browser on the same page where he enters his OAuth password —
// turning consent phishing into outright credential theft. This is the end-to-end proof that
// authorize-view.ts's escapeHtml() holds up against the real request path, not just against a
// hand-built params object.
test("a malicious client_name is HTML-escaped end-to-end on the authorize consent screen", async () => {
  await withTestServer(async (baseUrl) => {
    const maliciousName = '<script>alert("stolen")</script>';
    const clientId = "malicious-name-test-client";
    registerClient({
      id: clientId,
      redirectUris: ["http://127.0.0.1:9999/cb"],
      grants: ["authorization_code"],
      clientName: maliciousName,
    });

    const authorizeRes = await fetch(
      `${baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=http://127.0.0.1:9999/cb&response_type=code`,
    );
    const html = await authorizeRes.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(&quot;stolen&quot;\)&lt;\/script&gt;/);
  });
});
