/**
 * Single-slot pending-challenge storage per ceremony type. This is a single-user tool with no
 * sessions/cookies, so there's nothing to key a challenge by beyond "the most recent one issued" —
 * a new challenge request simply replaces whatever was pending. Consuming clears it immediately
 * (single-use, prevents replay) and a TTL catches challenges nobody ever redeemed.
 */
const TTL_MS = 2 * 60_000;

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
}

let pendingRegistration: PendingChallenge | undefined;
let pendingAuthentication: PendingChallenge | undefined;

function consume(get: () => PendingChallenge | undefined, clear: () => void): string | undefined {
  const entry = get();
  clear();
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.challenge;
}

export function setPendingRegistrationChallenge(challenge: string): void {
  pendingRegistration = { challenge, expiresAt: Date.now() + TTL_MS };
}

export function consumePendingRegistrationChallenge(): string | undefined {
  return consume(
    () => pendingRegistration,
    () => (pendingRegistration = undefined),
  );
}

export function setPendingAuthenticationChallenge(challenge: string): void {
  pendingAuthentication = { challenge, expiresAt: Date.now() + TTL_MS };
}

export function consumePendingAuthenticationChallenge(): string | undefined {
  return consume(
    () => pendingAuthentication,
    () => (pendingAuthentication = undefined),
  );
}
