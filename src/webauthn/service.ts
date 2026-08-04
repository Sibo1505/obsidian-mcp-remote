import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { getCredential, setCredential, updateCredentialCounter } from "./store.js";
import {
  setPendingRegistrationChallenge,
  consumePendingRegistrationChallenge,
  setPendingAuthenticationChallenge,
  consumePendingAuthenticationChallenge,
} from "./challenge.js";

const RP_NAME = "obsidian-mcp-remote";
// Fixed handle for the single user this tool ever serves — WebAuthn user IDs aren't secret, just
// an opaque per-account identifier, so a stable constant is fine (no multi-user story here).
const USER_ID = new TextEncoder().encode("sebastian");

function originFor(domain: string): string {
  return `https://${domain}`;
}

export function hasPasskey(): boolean {
  return !!getCredential();
}

export async function createRegistrationOptions(domain: string) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: domain,
    userName: "sebastian",
    // Shown to the user by their OS/password manager as the account label — kept generic since
    // this codebase is meant for anyone to self-host, not just the original author.
    userDisplayName: "Vault Owner",
    userID: USER_ID,
    attestationType: "none",
    // No authenticatorAttachment restriction: leaving it open is what makes Windows show its full
    // picker (Windows Hello, USB security key, "use a phone or tablet" via QR/hybrid transport)
    // instead of forcing one specific method.
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  setPendingRegistrationChallenge(options.challenge);
  return options;
}

export async function verifyRegistration(domain: string, response: RegistrationResponseJSON): Promise<boolean> {
  const expectedChallenge = consumePendingRegistrationChallenge();
  if (!expectedChallenge) return false;

  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: originFor(domain),
      expectedRPID: domain,
    });
    if (!result.verified || !result.registrationInfo) return false;

    const { credential } = result.registrationInfo;
    setCredential({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports,
    });
    return true;
  } catch (error) {
    console.error("WebAuthn registration verification failed:", error);
    return false;
  }
}

export async function createAuthenticationOptions(domain: string) {
  const credential = getCredential();
  if (!credential) return undefined;

  const options = await generateAuthenticationOptions({
    rpID: domain,
    allowCredentials: [{ id: credential.id, transports: credential.transports }],
    userVerification: "preferred",
  });
  setPendingAuthenticationChallenge(options.challenge);
  return options;
}

export async function verifyAuthentication(domain: string, response: AuthenticationResponseJSON): Promise<boolean> {
  const stored = getCredential();
  const expectedChallenge = consumePendingAuthenticationChallenge();
  if (!stored || !expectedChallenge) return false;

  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: originFor(domain),
      expectedRPID: domain,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
    if (result.verified) {
      updateCredentialCounter(result.authenticationInfo.newCounter);
    }
    return result.verified;
  } catch (error) {
    console.error("WebAuthn authentication verification failed:", error);
    return false;
  }
}
