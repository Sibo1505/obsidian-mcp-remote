import type { Request, Response, NextFunction } from "express";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";

export function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
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
