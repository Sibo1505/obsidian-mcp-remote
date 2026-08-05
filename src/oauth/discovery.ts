import type { Request, Response } from "express";

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * RFC 8414 — advertises the authorization/token endpoints and PKCE requirement.
 * No registration_endpoint: DCR was removed (dead code path — the only real client uses
 * preregistration — that stayed live as public attack surface for no benefit).
 */
export function authorizationServerMetadata(req: Request, res: Response) {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

/** RFC 9728 — advertises this server's own resource identity and its authorization server. */
export function protectedResourceMetadata(req: Request, res: Response) {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
}
