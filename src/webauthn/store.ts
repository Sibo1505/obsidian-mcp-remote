import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { readJson, writeJsonAtomic } from "../oauth/persistence.js";

export interface StoredCredential {
  id: string;
  publicKey: string; // base64url-encoded
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

interface PersistedWebAuthnState {
  credential?: StoredCredential;
}

let credential: StoredCredential | undefined;
let storePath: string | undefined;

function persist(): void {
  if (!storePath) return;
  writeJsonAtomic<PersistedWebAuthnState>(storePath, { credential });
}

/** Call once at startup, before serving requests — mirrors oauth/model.ts's initStore(). */
export function initWebAuthnStore(filePath: string): void {
  credential = readJson<PersistedWebAuthnState>(filePath, {}).credential;
  storePath = filePath;
}

export function getCredential(): StoredCredential | undefined {
  return credential;
}

/** A single credential for the single user this tool serves — registering a new one replaces it. */
export function setCredential(next: StoredCredential): void {
  credential = next;
  persist();
}

export function updateCredentialCounter(newCounter: number): void {
  if (!credential) return;
  credential.counter = newCounter;
  persist();
}
