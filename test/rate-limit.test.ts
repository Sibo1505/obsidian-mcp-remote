import assert from "node:assert/strict";
import { test } from "node:test";
import { withTestServer } from "./helpers.js";

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

test("/oauth/token is rate-limited after repeated requests", async () => {
  await withTestServer(async (baseUrl) => {
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: `bogus-${i}`,
          redirect_uri: "https://claude.ai/CHANGEME",
          client_id: "preregistered-client",
        }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});

// Intercepts only calls to ntfy.sh, passing everything else (the test's own requests to the local
// server) through to the real fetch — stubbing globalThis.fetch wholesale would break those too.
function interceptNtfyCalls(): { calls: { url: string; body: unknown }[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("https://ntfy.sh/")) {
      calls.push({ url, body: init?.body });
      return Promise.resolve(new Response());
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

test("a tripped rate limit sends an ntfy notification when NTFY_TOPIC is set", async () => {
  const { calls, restore } = interceptNtfyCalls();
  try {
    await withTestServer(async (baseUrl) => {
      for (let i = 0; i < 31; i++) {
        await fetch(`${baseUrl}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: `bogus-${i}`,
            redirect_uri: "https://claude.ai/CHANGEME",
            client_id: "preregistered-client",
          }),
        });
      }
      assert.ok(calls.some((c) => c.url === "https://ntfy.sh/test-topic"));
    }, { NTFY_TOPIC: "test-topic" });
  } finally {
    restore();
  }
});

test("a wrong OAuth password sends an ntfy notification when NTFY_TOPIC is set", async () => {
  const { calls, restore } = interceptNtfyCalls();
  try {
    await withTestServer(async (baseUrl) => {
      await fetch(`${baseUrl}/oauth/authorize`, {
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
      assert.equal(calls.length, 1);
      assert.match(String(calls[0].body), /Wrong OAuth password attempt/);
    }, { NTFY_TOPIC: "test-topic" });
  } finally {
    restore();
  }
});
