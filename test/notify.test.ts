import assert from "node:assert/strict";
import { test } from "node:test";
import { notifySecurityEvent } from "../src/notify.js";

test("notifySecurityEvent does nothing when no topic is configured", () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (() => {
    called = true;
    return Promise.resolve(new Response());
  }) as typeof fetch;

  try {
    notifySecurityEvent(undefined, "should not be sent");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notifySecurityEvent POSTs the message to the configured ntfy topic", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  let resolveCall: () => void;
  const called = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });

  globalThis.fetch = ((url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    resolveCall();
    return Promise.resolve(new Response());
  }) as typeof fetch;

  try {
    notifySecurityEvent("my-secret-topic", "wrong password from 1.2.3.4");
    await called;
    assert.equal(capturedUrl, "https://ntfy.sh/my-secret-topic");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.body, "wrong password from 1.2.3.4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notifySecurityEvent URL-encodes the topic", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  let resolveCall: () => void;
  const called = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });

  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    resolveCall();
    return Promise.resolve(new Response());
  }) as typeof fetch;

  try {
    notifySecurityEvent("topic with spaces", "msg");
    await called;
    assert.equal(capturedUrl, "https://ntfy.sh/topic%20with%20spaces");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
