import type { Request, Response, NextFunction } from "express";
import type ExpressOAuthServer from "@node-oauth/express-oauth-server";
import { timingSafeEqualStrings } from "../util/timing-safe-equal.js";
import { extractBearerToken, isTailscaleAddress } from "./middleware.js";

/**
 * Accepts either the static TOKEN_INTERNAL bearer (Tailscale zone, e.g. direct curl/Claude Code)
 * or a valid OAuth access token (Desktop-via-mcp-remote / future Mobile-Web zone).
 *
 * TOKEN_INTERNAL is only honored when the request actually originates from Tailscale - the token
 * is just a string, so without this check it would authenticate equally well from the public
 * internet if it ever leaked, silently collapsing the two-zone model into one.
 */
export function combinedAuth(tokenInternal: string, oauthServer: ExpressOAuthServer) {
  const oauthAuthenticate = oauthServer.authenticate();

  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);

    if (token && timingSafeEqualStrings(token, tokenInternal) && isTailscaleAddress(req.ip ?? "")) {
      next();
      return;
    }

    oauthAuthenticate(req, res, next);
  };
}
