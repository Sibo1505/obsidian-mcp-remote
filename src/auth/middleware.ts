import type { Request, Response, NextFunction } from "express";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";

export function bearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!token || !timingSafeEqualStrings(token, expectedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
