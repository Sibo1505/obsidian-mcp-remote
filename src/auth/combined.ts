import type { Request, Response, NextFunction } from "express";
import type ExpressOAuthServer from "@node-oauth/express-oauth-server";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";

/**
 * Accepts either the static TOKEN_INTERNAL bearer (Tailscale zone, e.g. direct curl/Claude Code)
 * or a valid OAuth access token (Desktop-via-mcp-remote / future Mobile-Web zone).
 */
export function combinedAuth(tokenInternal: string, oauthServer: ExpressOAuthServer) {
  const oauthAuthenticate = oauthServer.authenticate();

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (token && timingSafeEqualStrings(token, tokenInternal)) {
      next();
      return;
    }

    oauthAuthenticate(req, res, next);
  };
}
