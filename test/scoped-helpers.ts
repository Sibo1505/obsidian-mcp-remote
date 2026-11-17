import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Config } from "../src/config.js";
import type { ScopedToken } from "../src/scoped/config.js";
import { createScopedApp, type ScopedAppOptions } from "../src/scoped/app.js";
import { makeTestConfig } from "./helpers.js";

// Test-only secrets: long enough for the 32-character minimum, obviously not real.
export const SCOPED_SECRET = "scoped-test-secret-not-real-0000000001";
export const OTHER_SCOPED_SECRET = "scoped-test-secret-not-real-0000000002";
export const WRITE_DIR = "notes-inbox";

/**
 * A scoped token that is valid for requests from this machine's loopback address. Like the config,
 * it changes only its own existing notes with the whole vault ("own") and any note in one folder.
 */
export function makeScopedToken(overrides: Partial<ScopedToken> = {}): ScopedToken {
  return {
    name: "test-agent",
    secret: SCOPED_SECRET,
    allowFrom: ["127.0.0.1"],
    writeDir: WRITE_DIR,
    writeDeny: [],
    readDeny: [],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    writesPerHour: 60,
    frontmatter: { source: "test-agent" },
    tags: ["scoped"],
    modifyExisting: (overrides.writeDir ?? WRITE_DIR) === "" ? "own" : "any",
    ...overrides,
  };
}

export interface ScopedTestContext {
  baseUrl: string;
  vaultRoot: string;
  config: Config;
  logs: string[];
}

/** Boots only the scoped listener on a random port against `vaultRoot` (or a fresh temp vault). */
export async function withScopedServer(
  tokens: ScopedToken[],
  fn: (ctx: ScopedTestContext) => Promise<void>,
  options: { vaultRoot?: string; app?: Omit<ScopedAppOptions, "log"> } = {},
) {
  const ownVault = options.vaultRoot === undefined;
  const vaultRoot = options.vaultRoot ?? (await mkdtemp(path.join(tmpdir(), "scoped-vault-")));
  const config = makeTestConfig(vaultRoot);
  const logs: string[] = [];
  const app = createScopedApp(config, tokens, { ...options.app, log: (line) => logs.push(line) });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, vaultRoot, config, logs });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (ownVault) await rm(vaultRoot, { recursive: true, force: true });
  }
}

export interface McpResponse {
  status: number;
  /** Parsed JSON-RPC message (from JSON or from the first SSE `data:` line), or the raw JSON error body. */
  body: unknown;
}

/** Sends one JSON-RPC request to `${baseUrl}/mcp` the way an MCP client over Streamable HTTP does. */
export async function mcpRequest(
  baseUrl: string,
  bearer: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  let body: unknown = text;
  try {
    body = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
  } catch {
    // leave the raw text
  }
  return { status: res.status, body };
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
}

/** Calls one MCP tool with the scoped test secret and returns its text result. */
export async function callTool(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  secret = SCOPED_SECRET,
): Promise<ToolCallResult> {
  const res = await mcpRequest(baseUrl, secret, "tools/call", { name, arguments: args });
  if (res.status !== 200) {
    throw new Error(`tools/call ${name} returned HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const result = (res.body as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
  if (!result) throw new Error(`tools/call ${name} returned no result: ${JSON.stringify(res.body)}`);
  return { isError: result.isError === true, text: result.content?.map((c) => c.text).join("\n") ?? "" };
}
