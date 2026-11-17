import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.js";
import type { ScopedToken } from "./config.js";
import { scopedAuth, scopedTokenOf } from "./auth.js";
import { WriteBudget } from "./enforce.js";
import { SCOPED_TOOL_NAMES, registerScopedTools } from "./tools.js";
import { throttlePull } from "./pull.js";
import { ScopedSearch } from "./search-runner.js";
import { pullBestEffort } from "../vault/git.js";

export interface ScopedAppOptions {
  /** Receives the audit and auth-failure lines. Defaults to console.log. */
  log?: (line: string) => void;
  /** Hard time limit of one scoped search in milliseconds (default SCOPED_SEARCH_TIMEOUT_MS). */
  searchTimeoutMs?: number;
}

/**
 * The scoped listener: its own Express app with only POST /mcp and GET /health. No OAuth routes, no
 * TOKEN_INTERNAL, no static files, and no proxy trust: clients must reach this port directly, so the
 * TCP peer address is the real sender and forwarded-for headers are ignored.
 */
export function createScopedApp(config: Config, tokens: ScopedToken[], options: ScopedAppOptions = {}): express.Express {
  const log = options.log ?? ((line: string) => console.log(line));
  const budget = new WriteBudget();
  const pull = throttlePull(() => pullBestEffort(config.VAULT_PATH));
  const search = new ScopedSearch(options.searchTimeoutMs);

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
    // Count every single address on its own (the default groups IPv6 addresses by /56, which
    // would put all machines of a tailnet into one bucket).
    ipv6Subnet: false,
    // Forwarded-for headers are ignored here on purpose; no need to warn about seeing one.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", scopedRateLimit, scopedAuth(tokens, log), express.json({ limit: "1mb" }), async (req, res) => {
    const token = scopedTokenOf(res);
    // One JSON-RPC message per HTTP request. A batch would let one request (and one rate-limit
    // slot) carry thousands of tool calls.
    if (Array.isArray(req.body)) {
      log(`scoped token=${token.name} method=batch result=denied:batch`);
      res.status(400).json({ error: "Batch requests are not supported" });
      return;
    }
    // Tool calls get their own audit line from the tool; every other request gets this one.
    const message = req.body as { method?: unknown; params?: { name?: unknown } };
    const method =
      typeof message.method === "string" && /^[\w./$-]{1,64}$/.test(message.method) ? message.method : "invalid";
    const toolName = message.params?.name;
    const toolCall = method === "tools/call" && typeof toolName === "string" && SCOPED_TOOL_NAMES.has(toolName);
    if (!toolCall) log(`scoped token=${token.name} method=${method}`);

    // A tool call can be refused before its tool runs (invalid arguments, a client the transport
    // will not answer). Then the tool writes no line, so this one does, before the answer leaves.
    let reachedTool = false;
    let accounted = !toolCall;
    const account = () => {
      if (accounted) return;
      accounted = true;
      if (!reachedTool) log(`scoped token=${token.name} method=tools/call tool=${String(toolName)} result=rejected`);
    };

    const server = new McpServer({ name: "obsidian-mcp-remote", version: "0.1.0" });
    registerScopedTools(server, { config, token, budget, log, pull, search, reached: () => (reachedTool = true) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const send = transport.send.bind(transport);
    transport.send = (reply, sendOptions) => {
      account();
      return send(reply, sendOptions);
    };
    res.on("close", () => {
      account();
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // The transport answered by itself (406, 415, ...) without handing the message to the server.
    if (res.writableEnded) account();
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
