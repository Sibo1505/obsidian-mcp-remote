import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { combinedAuth } from "./auth/combined.js";
import { vaultReadSchema, vaultRead } from "./tools/vault-read.js";
import { vaultWriteSchema, vaultWrite } from "./tools/vault-write.js";
import { vaultPatchSchema, vaultPatch } from "./tools/vault-patch.js";
import { vaultListSchema, vaultList } from "./tools/vault-list.js";
import { searchQuerySchema, searchQuery } from "./tools/search-query.js";
import { createOAuthServer } from "./oauth/server.js";
import { registerClient, initStore } from "./oauth/model.js";
import { registerHandler } from "./oauth/register.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./oauth/discovery.js";
import { authorizeGet, authorizePost } from "./oauth/authorize-route.js";
import { notifySecurityEvent } from "./notify.js";
import { initWebAuthnStore } from "./webauthn/store.js";
import { webauthnSetupGet, webauthnSetupOptions, webauthnSetupVerify, webauthnAuthenticateOptions } from "./webauthn/routes.js";

// Repo root both in dev (tsx running src/app.ts) and in the Docker image (dist/app.js, "public"
// copied alongside "dist" — see Dockerfile) — one level up from this file's own directory.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(repoRoot, "public");
// Vendored rather than pulled from a CDN: this JS runs on a login page that handles credentials —
// a compromised CDN would mean a credential-stealing script served on our own domain.
const webauthnBrowserBundle = path.join(repoRoot, "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");

async function toResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function registerTools(server: McpServer, config: Config) {
  server.registerTool(
    "vault_read",
    { description: "Read a vault file, optionally extracting a heading or frontmatter section.", inputSchema: vaultReadSchema },
    (input) => toResult(() => vaultRead(config.VAULT_PATH, input)),
  );

  server.registerTool(
    "vault_write",
    { description: "Create or overwrite a vault file with the given content.", inputSchema: vaultWriteSchema },
    (input) => toResult(() => vaultWrite(config.VAULT_PATH, input)),
  );

  server.registerTool(
    "vault_patch",
    { description: "Patch a heading section or frontmatter field of a vault file.", inputSchema: vaultPatchSchema },
    (input) => toResult(() => vaultPatch(config.VAULT_PATH, input)),
  );

  server.registerTool(
    "vault_list",
    { description: "List files and subdirectories inside a vault directory.", inputSchema: vaultListSchema },
    (input) => toResult(() => vaultList(config.VAULT_PATH, input)),
  );

  server.registerTool(
    "search_query",
    { description: "Search vault notes using a JsonLogic query evaluated against each note's metadata.", inputSchema: searchQuerySchema },
    (input) => toResult(() => searchQuery(config.VAULT_PATH, input)),
  );
}

export function createApp(config: Config): express.Express {
  // Reload clients/tokens that survived a previous process — without this, every container
  // restart wiped OAuth state and forced every client through the password login again.
  initStore(config.OAUTH_STORE_PATH);
  initWebAuthnStore(config.WEBAUTHN_STORE_PATH);

  const oauthServer = createOAuthServer();

  // Preregistered client for the future Mobile/Web Custom Connector flow (claude.ai UI supports
  // entering a fixed client_id/secret directly — no DCR needed for that path). The exact redirect
  // URI claude.ai uses isn't verified yet (M6 Mobile/Web testing is still pending) — set via .env
  // once known, rather than guessing a literal here.
  registerClient({
    id: config.OAUTH_CLIENT_ID,
    clientSecret: config.OAUTH_CLIENT_SECRET,
    redirectUris: [config.OAUTH_CLIENT_REDIRECT_URI],
    grants: ["authorization_code", "refresh_token"],
  });

  // Fires a best-effort push (if NTFY_TOPIC is set) and a generic 429.
  function onRateLimited(label: string): express.RequestHandler {
    return (req, res) => {
      notifySecurityEvent(config.NTFY_TOPIC, `Rate limit hit on ${label} from ${req.ip}`);
      res.status(429).json({ error: "Too many requests" });
    };
  }

  const mcpRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Password-guessing protection for /oauth/authorize: the OAUTH_PASSWORD is the only gate on this
  // publicly reachable endpoint, so it gets a much tighter limit than /mcp.
  const authorizeRateLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: onRateLimited("/oauth/authorize"),
  });

  // /oauth/token is hit by legitimate clients on every refresh, but still needs a ceiling against
  // authorization-code / refresh-token guessing.
  const tokenRateLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: onRateLimited("/oauth/token"),
  });

  // /register is unauthenticated by design (RFC 7591 DCR) — limit it to stop unbounded client
  // registration from filling up the in-memory client store.
  const registerRateLimit = rateLimit({
    windowMs: 60 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: onRateLimited("/register"),
  });

  const app = express();
  // Trust exactly one reverse-proxy hop (NPM, same npm_shared network) so req.protocol reflects
  // the real client-facing scheme (https) via X-Forwarded-Proto, instead of the plain-HTTP hop
  // NPM makes internally to this container. Without this, discovery metadata below advertises
  // "http://" even when reached over HTTPS, which real OAuth clients correctly reject as a mismatch.
  app.set("trust proxy", 1);
  // Method/path/status only — never headers or body, those can carry passwords/tokens/PKCE
  // verifiers. Cheap and permanent, not a temporary debug hack: this is the only place that shows
  // whether a request reached this server at all, useful for exactly this kind of remote client
  // integration debugging.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      let extra = "";
      const location = res.getHeader("location");
      if (typeof location === "string") {
        // Redact the single-use auth code itself (no reason to persist it in logs), but keep
        // error/error_description/state visible — that's the whole point of logging this.
        try {
          const url = new URL(location);
          if (url.searchParams.has("code")) url.searchParams.set("code", "<redacted>");
          extra = ` -> Location: ${url.toString()}`;
        } catch {
          extra = ` -> Location: ${location}`;
        }
      }
      console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)${extra}`);
    });
    next();
  });
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  // OAuth token requests (RFC 6749) and the HTML authorize form both use urlencoded bodies.
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use(express.static(publicDir));
  app.get("/webauthn-browser.js", (_req, res) => {
    res.set("Content-Type", "application/javascript").sendFile(webauthnBrowserBundle);
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.post("/register", registerRateLimit, registerHandler);

  const authorizePostHandler = authorizePost(oauthServer, {
    oauthPassword: config.OAUTH_PASSWORD,
    domain: config.DOMAIN,
    ntfyTopic: config.NTFY_TOPIC,
  });
  app.get("/oauth/authorize", authorizeGet);
  app.post("/oauth/authorize", authorizeRateLimit, authorizePostHandler);
  app.post("/oauth/token", tokenRateLimit, oauthServer.token());

  // Aliases at the conventional root-level paths (no /oauth prefix): the discovery metadata above
  // correctly advertises /oauth/authorize + /oauth/token, and mcp-remote (Desktop/Code) follows it
  // correctly — but claude.ai's Custom Connector flow was observed hitting /authorize directly,
  // ignoring discovery. Same handlers, just reachable at both paths.
  app.get("/authorize", authorizeGet);
  app.post("/authorize", authorizeRateLimit, authorizePostHandler);
  app.post("/token", tokenRateLimit, oauthServer.token());

  app.get("/webauthn/setup", webauthnSetupGet);
  app.post("/webauthn/setup/options", authorizeRateLimit, webauthnSetupOptions(config.OAUTH_PASSWORD, config.DOMAIN));
  app.post("/webauthn/setup/verify", authorizeRateLimit, webauthnSetupVerify(config.DOMAIN));
  app.post("/webauthn/authenticate/options", authorizeRateLimit, webauthnAuthenticateOptions(config.DOMAIN));

  app.post("/mcp", mcpRateLimit, combinedAuth(config.TOKEN_INTERNAL, oauthServer), async (req, res) => {
    const server = new McpServer({ name: "obsidian-mcp-remote", version: "0.1.0" });
    registerTools(server, config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Generic JSON error handler — never leak stack traces or internal paths to clients.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(400).json({ error: "Bad request" });
  });

  return app;
}
