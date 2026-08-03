import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against itself to keep timing independent of the caller-supplied length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function bearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!token || !timingSafeTokenEqual(token, expectedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
