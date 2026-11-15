import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.js";
import type { ScopedToken } from "./config.js";
import { scopedAuth, scopedTokenOf } from "./auth.js";
import { WriteBudget } from "./enforce.js";
import { registerScopedTools } from "./tools.js";

export interface ScopedAppOptions {
  /** Receives the audit and auth-failure lines. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The scoped listener: its own Express app with only POST /mcp and GET /health. No OAuth routes, no
 * TOKEN_INTERNAL, no static files, and no proxy trust: clients must reach this port directly, so the
 * TCP peer address is the real sender and forwarded-for headers are ignored.
 */
export function createScopedApp(config: Config, tokens: ScopedToken[], options: ScopedAppOptions = {}): express.Express {
  const log = options.log ?? ((line: string) => console.log(line));
  const budget = new WriteBudget();

  const app = express();
  app.set("trust proxy", false);
  app.use(helmet());

  // Separate counter from the main listener's /mcp limit. Keyed by req.ip, which without proxy
  // trust is the socket address.
  const scopedRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    // Forwarded-for headers are ignored here on purpose; no need to warn about seeing one.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", scopedRateLimit, scopedAuth(tokens, log), express.json({ limit: "1mb" }), async (req, res) => {
    const server = new McpServer({ name: "obsidian-mcp-remote", version: "0.1.0" });
    registerScopedTools(server, { config, token: scopedTokenOf(res), budget, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Never leak stack traces or internal paths to clients, and never log the error text: body-parser
  // errors quote the request body (note content) in their message.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const type = (err as { type?: unknown })?.type ?? (err instanceof Error ? err.name : typeof err);
    log(`scoped request failed status=400 type=${String(type)}`);
    res.status(400).json({ error: "Bad request" });
  });

  return app;
}
