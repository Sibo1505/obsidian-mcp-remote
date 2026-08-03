import type { Request, Response, NextFunction } from "express";
import type ExpressOAuthServer from "@node-oauth/express-oauth-server";
import { checkOAuthPassword } from "./model.js";
import { renderAuthorizeForm } from "./authorize-view.js";

const RESOURCE_OWNER = { id: "sebastian" };

export function authorizeGet(req: Request, res: Response) {
  res.set("Content-Type", "text/html").send(renderAuthorizeForm(req.query as Record<string, string>));
}

export function authorizePost(oauthServer: ExpressOAuthServer, oauthPassword: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Record<string, string>;

    if (!checkOAuthPassword(body.password ?? "", oauthPassword)) {
      res.status(403).set("Content-Type", "text/html").send(renderAuthorizeForm(body, "Falsches Passwort"));
      return;
    }

    if (!body.code_challenge || body.code_challenge_method !== "S256") {
      res.status(400).json({
        error: "invalid_request",
        error_description: "PKCE with S256 (code_challenge/code_challenge_method) is required",
      });
      return;
    }

    const authorize = oauthServer.authorize({
      authenticateHandler: { handle: () => RESOURCE_OWNER },
    });
    await authorize(req, res, next);
  };
}
