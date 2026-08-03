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
import { registerClient } from "./oauth/model.js";
import { registerHandler } from "./oauth/register.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./oauth/discovery.js";
import { authorizeGet, authorizePost } from "./oauth/authorize-route.js";

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

  const mcpRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  // OAuth token requests (RFC 6749) and the HTML authorize form both use urlencoded bodies.
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.post("/register", registerHandler);
  app.get("/oauth/authorize", authorizeGet);
  app.post("/oauth/authorize", authorizePost(oauthServer, config.OAUTH_PASSWORD));
  app.post("/oauth/token", oauthServer.token());

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
