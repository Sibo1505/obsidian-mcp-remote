import type { Request, Response, NextFunction } from "express";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";

export function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

// Tailscale's CGNAT range - the same 100.64.0.0/10 already used for the NPM Access Lists that
// keep every other internal service Tailscale-only, so this mirrors an already-trusted boundary
// rather than inventing a new one.
const TAILSCALE_CIDR_BASE = ipv4ToInt("100.64.0.0")!;
const TAILSCALE_CIDR_MASK = (0xffffffff << (32 - 10)) >>> 0;

/**
 * TOKEN_INTERNAL is meant for the Tailscale zone only, but a bearer token is just a string - it
 * authenticates equally well from the public internet if it ever leaks. This checks the actual
 * request origin so a leaked TOKEN_INTERNAL can't be used to bypass OAuth/PKCE/passkey on the
 * public zone.
 */
export function isTailscaleAddress(ip: string): boolean {
  const normalized = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  const ipInt = ipv4ToInt(normalized);
  if (ipInt === undefined) return false;
  return (ipInt & TAILSCALE_CIDR_MASK) === (TAILSCALE_CIDR_BASE & TAILSCALE_CIDR_MASK);
}

export function bearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);

    if (!token || !timingSafeEqualStrings(token, expectedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
