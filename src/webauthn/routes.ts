import type { Request, Response } from "express";
import { checkOAuthPassword } from "../oauth/model.js";
import { createRegistrationOptions, verifyRegistration, hasPasskey, createAuthenticationOptions } from "./service.js";
import { renderSetupPage } from "./setup-view.js";

// The page itself carries no secrets — worst case an attacker learns this server has a setup
// page, same as GET /oauth/authorize being unauthenticated. The actual gate is the /options POST.
export function webauthnSetupGet(_req: Request, res: Response) {
  res.set("Content-Type", "text/html").send(renderSetupPage(hasPasskey()));
}

export function webauthnSetupOptions(oauthPassword: string, domain: string) {
  return async (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!checkOAuthPassword(password ?? "", oauthPassword)) {
      res.status(403).json({ error: "Wrong password" });
      return;
    }
    res.json(await createRegistrationOptions(domain));
  };
}

// Doesn't re-check the password: possession of a signed response to the challenge issued above
// (which did require the password) is itself the proof — same pattern as PKCE code_verifier
// redemption not re-checking anything from the earlier /authorize step.
export function webauthnSetupVerify(domain: string) {
  return async (req: Request, res: Response) => {
    const verified = await verifyRegistration(domain, req.body);
    res.status(verified ? 200 : 400).json({ verified });
  };
}

// Deliberately unauthenticated — this replaces the password, not something gated behind it.
// The response only carries a challenge and a (non-secret) credential ID.
export function webauthnAuthenticateOptions(domain: string) {
  return async (_req: Request, res: Response) => {
    const options = await createAuthenticationOptions(domain);
    if (!options) {
      res.status(404).json({ error: "No passkey registered" });
      return;
    }
    res.json(options);
  };
}
