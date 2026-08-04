import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withTestServer } from "./helpers.js";
import {
  initWebAuthnStore,
  getCredential,
  setCredential,
  updateCredentialCounter,
  type StoredCredential,
} from "../src/webauthn/store.js";
import {
  setPendingRegistrationChallenge,
  consumePendingRegistrationChallenge,
  setPendingAuthenticationChallenge,
  consumePendingAuthenticationChallenge,
} from "../src/webauthn/challenge.js";
import { createRegistrationOptions, createAuthenticationOptions, hasPasskey } from "../src/webauthn/service.js";

const SAMPLE_CREDENTIAL: StoredCredential = {
  id: "sample-credential-id",
  publicKey: Buffer.from("not-a-real-key").toString("base64url"),
  counter: 0,
  transports: ["internal"],
};

test("webauthn store: setCredential/getCredential round-trip and persist to disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webauthn-store-"));
  const filePath = path.join(dir, "webauthn-credential.json");
  try {
    initWebAuthnStore(filePath);
    assert.equal(getCredential(), undefined);

    setCredential(SAMPLE_CREDENTIAL);
    assert.deepEqual(getCredential(), SAMPLE_CREDENTIAL);

    // Simulate a restart: a fresh call to initWebAuthnStore must reload what was persisted.
    initWebAuthnStore(filePath);
    assert.deepEqual(getCredential(), SAMPLE_CREDENTIAL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("webauthn store: updateCredentialCounter persists the new counter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webauthn-store-"));
  const filePath = path.join(dir, "webauthn-credential.json");
  try {
    initWebAuthnStore(filePath);
    setCredential(SAMPLE_CREDENTIAL);
    updateCredentialCounter(42);
    assert.equal(getCredential()?.counter, 42);

    initWebAuthnStore(filePath);
    assert.equal(getCredential()?.counter, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending challenge: is single-use, a second consume returns undefined", () => {
  setPendingRegistrationChallenge("challenge-1");
  assert.equal(consumePendingRegistrationChallenge(), "challenge-1");
  assert.equal(consumePendingRegistrationChallenge(), undefined);
});

test("pending challenge: registration and authentication slots don't clobber each other", () => {
  setPendingRegistrationChallenge("reg-challenge");
  setPendingAuthenticationChallenge("auth-challenge");
  assert.equal(consumePendingAuthenticationChallenge(), "auth-challenge");
  assert.equal(consumePendingRegistrationChallenge(), "reg-challenge");
});

test("service: createRegistrationOptions targets the configured rpID and sets a pending challenge", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webauthn-service-"));
  try {
    initWebAuthnStore(path.join(dir, "webauthn-credential.json"));
    const options = await createRegistrationOptions("example.com");
    assert.equal(options.rp.id, "example.com");
    assert.equal(options.user.name, "owner");
    assert.equal(consumePendingRegistrationChallenge(), options.challenge);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service: createAuthenticationOptions returns undefined when no credential is registered", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webauthn-service-"));
  try {
    initWebAuthnStore(path.join(dir, "webauthn-credential.json"));
    assert.equal(hasPasskey(), false);
    assert.equal(await createAuthenticationOptions("example.com"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service: createAuthenticationOptions targets the registered credential once one exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webauthn-service-"));
  try {
    initWebAuthnStore(path.join(dir, "webauthn-credential.json"));
    setCredential(SAMPLE_CREDENTIAL);
    assert.equal(hasPasskey(), true);

    const options = await createAuthenticationOptions("example.com");
    assert.ok(options);
    assert.equal(options?.rpId, "example.com");
    assert.equal(options?.allowCredentials?.[0]?.id, SAMPLE_CREDENTIAL.id);
    assert.equal(consumePendingAuthenticationChallenge(), options?.challenge);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /webauthn/setup serves the registration page", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/webauthn/setup`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Passkey registrieren/);
  });
});

test("POST /webauthn/setup/options rejects a wrong password", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/webauthn/setup/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(res.status, 403);
  });
});

test("POST /webauthn/setup/options returns registration options for the correct password", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/webauthn/setup/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery-staple" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rp: { id: string }; challenge: string };
    assert.equal(body.rp.id, "test.local");
    assert.ok(body.challenge);
  });
});

test("POST /webauthn/authenticate/options returns 404 when no passkey is registered", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/webauthn/authenticate/options`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});

test("GET /oauth/authorize only advertises the passkey option once one is registered", async () => {
  await withTestServer(async (baseUrl, config) => {
    const before = await fetch(`${baseUrl}/oauth/authorize?client_id=x&redirect_uri=https://claude.ai/CHANGEME&response_type=code`);
    assert.doesNotMatch(await before.text(), /passkey-btn/);

    initWebAuthnStore(config.WEBAUTHN_STORE_PATH);
    setCredential(SAMPLE_CREDENTIAL);

    const after = await fetch(`${baseUrl}/oauth/authorize?client_id=x&redirect_uri=https://claude.ai/CHANGEME&response_type=code`);
    const html = await after.text();
    assert.match(html, /passkey-btn/);
    assert.match(html, /webauthn-browser\.js/);
  });
});
