import crypto from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { registerClient } from "./model.js";

// DCR only serves native/CLI clients (mcp-remote for Desktop/Code) — the claude.ai Custom
// Connector flow uses the preregistered client instead and never calls /register. Restricting to
// loopback closes an open-redirect-style consent-phishing hole: /register is unauthenticated by
// design (RFC 7591), so allowing arbitrary https:// redirect_uris let anyone mint a client whose
// authorization code gets delivered to a server they control, using nothing but a link Sebastian
// clicks and his own password/passkey (which he legitimately enters for real new-client setups too).
function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    // Loopback redirects are standard practice for native/CLI OAuth clients (RFC 8252).
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

const registerRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** RFC 7591 Dynamic Client Registration — issues public clients only (PKCE is the security boundary). */
export function registerHandler(req: Request, res: Response) {
  const parsed = registerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: parsed.error.message });
    return;
  }

  const { redirect_uris } = parsed.data;
  if (!redirect_uris.every(isAllowedRedirectUri)) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uris must be a loopback http://localhost|127.0.0.1 URI",
    });
    return;
  }

  const clientId = crypto.randomUUID();
  registerClient({
    id: clientId,
    redirectUris: redirect_uris,
    grants: ["authorization_code", "refresh_token"],
    clientName: parsed.data.client_name,
    registeredAt: new Date().toISOString(),
  });

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    client_name: parsed.data.client_name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}
