import type { Request, Response, NextFunction } from "express";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";
import { extractBearerToken } from "../auth/middleware.js";
import { normalizeAddress, type ScopedToken } from "./config.js";

/** The token a request authenticated with, set by scopedAuth. */
export function scopedTokenOf(res: Response): ScopedToken {
  return res.locals.scopedToken as ScopedToken;
}

/**
 * Authenticates the scoped listener. A request passes only with a configured scoped secret, from
 * one of that token's exact addresses, before its expiry. The address is the TCP peer
 * (req.socket.remoteAddress): this listener trusts no proxy, so X-Forwarded-For and friends are
 * never read. Every failure gets the same 401 body; only the log line says why.
 */
export function scopedAuth(tokens: ScopedToken[], log: (line: string) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    const from = normalizeAddress(req.socket.remoteAddress ?? "");
    const reject = (reason: string, token?: ScopedToken) => {
      log(`scoped auth rejected reason=${reason} token=${token?.name ?? "-"} from=${from}`);
      res.status(401).json({ error: "Unauthorized" });
    };

    const presented = extractBearerToken(req);
    if (!presented) return reject("missing-token");

    // Compare against every token (no early exit), so timing does not tell which one matched.
    let match: ScopedToken | undefined;
    for (const token of tokens) {
      if (timingSafeEqualStrings(presented, token.secret) && !match) match = token;
    }
    if (!match) return reject("unknown-token");
    if (!match.allowFrom.includes(from)) return reject("address-not-allowed", match);
    if (Date.now() >= match.expiresAt.getTime()) return reject("expired", match);

    res.locals.scopedToken = match;
    next();
  };
}
