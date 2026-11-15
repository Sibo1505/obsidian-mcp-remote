import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { writeDirProblem } from "./names.js";

/** One scoped token after validation: everything the scoped listener needs to decide a request. */
export interface ScopedToken {
  name: string;
  secret: string;
  /** Exact peer addresses, IPv4-mapped prefix removed. */
  allowFrom: string[];
  /** Vault-relative folder, "/"-separated, no trailing slash. */
  writeDir: string;
  /** Vault-relative path prefixes, "/"-separated, no trailing slash. */
  readDeny: string[];
  expiresAt: Date;
  writesPerHour: number;
  frontmatter: Record<string, string | number | boolean>;
  tags: string[];
}

export type ScopedSetup =
  | { status: "disabled" }
  | { status: "invalid"; errors: string[] }
  | { status: "enabled"; port: number; tokens: ScopedToken[] };

/** Peer address as the scoped listener compares it: IPv4-mapped IPv6 unwrapped, lowercase. */
export function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith("::ffff:") && net.isIPv4(lower.slice("::ffff:".length)) ? lower.slice("::ffff:".length) : lower;
}

/** "a\\b/./c/" -> "a/b/c"; returns undefined for anything that is not a plain path inside the vault. */
function normalizeVaultPrefix(value: string): string | undefined {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return undefined;
  }
  return normalized;
}

const isoDate = z.string().date();
const isoDateTime = z.string().datetime({ offset: true });

const tokenEntrySchema = z
  .object({
    name: z.string().max(64).regex(/^[a-z0-9-]+$/, 'only lowercase letters, digits and "-"'),
    tokenEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the name of an environment variable"),
    allowFrom: z
      .array(z.string().refine((value) => net.isIP(value) !== 0, "must be an exact IP address (no ranges, no host names)"))
      .min(1, "list at least one address")
      .transform((list) => list.map(normalizeAddress)),
    writeDir: z
      .string()
      .transform((value) => value.replace(/\/+$/, ""))
      .superRefine((value, ctx) => {
        const problem = writeDirProblem(value);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    readDeny: z
      .array(
        z.string().transform((value, ctx) => {
          const normalized = normalizeVaultPrefix(value);
          if (normalized === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a path inside the vault (not the root)" });
            return z.NEVER;
          }
          return normalized;
        }),
      )
      .default([]),
    expiresAt: z
      .string({ required_error: "required: every scoped token must expire" })
      .refine(
        (value) => isoDate.safeParse(value).success || isoDateTime.safeParse(value).success,
        "must be an ISO date (2026-12-31, meaning 00:00 UTC) or date-time with offset (2026-12-31T23:59:00Z)",
      )
      .transform((value) => new Date(value)),
    writesPerHour: z.number().int().positive().max(10_000).default(60),
    frontmatter: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]+$/, "front matter keys: letters, digits, _ and -"),
        z.union([z.string(), z.number(), z.boolean()]),
      )
      .refine((fields) => !("tags" in fields), 'set tags with the "tags" field, not in "frontmatter"')
      .default({}),
    tags: z.array(z.string().regex(/^[A-Za-z0-9_/-]+$/, "tags: letters, digits, _, - and /")).default([]),
  })
  .strict();

const tokenListSchema = z.array(tokenEntrySchema).min(1, "configure at least one token");

const portSchema = z.coerce.number().int().min(0).max(65_535);

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("");
    return `${prefix}${where}: ${issue.message}`;
  });
}

/**
 * Reads the scoped-token settings from `env`. Never throws and never falls back to wider access:
 * any problem makes the whole scoped setup "invalid" (the scoped listener then does not start).
 * Error strings name fields, never secret values.
 */
export function loadScopedConfig(env: NodeJS.ProcessEnv, mainConfig: Config): ScopedSetup {
  const rawPort = env.SCOPED_PORT;
  if (rawPort === undefined || rawPort === "") return { status: "disabled" };

  const errors: string[] = [];

  const port = portSchema.safeParse(rawPort);
  if (!port.success) {
    errors.push("SCOPED_PORT: must be a port number");
  } else if (port.data !== 0 && port.data === mainConfig.PORT) {
    errors.push("SCOPED_PORT: must differ from PORT");
  }

  const rawTokens = env.SCOPED_TOKENS_JSON;
  let parsedJson: unknown;
  if (rawTokens === undefined || rawTokens === "") {
    errors.push("SCOPED_TOKENS_JSON: not set");
    return { status: "invalid", errors };
  }
  try {
    parsedJson = JSON.parse(rawTokens);
  } catch {
    errors.push("SCOPED_TOKENS_JSON: not valid JSON");
    return { status: "invalid", errors };
  }

  const entries = tokenListSchema.safeParse(parsedJson);
  if (!entries.success) {
    errors.push(...formatIssues("SCOPED_TOKENS_JSON", entries.error));
    return { status: "invalid", errors };
  }

  // Secrets the main listener already accepts: a scoped token must never double as one of them.
  const mainSecrets = [mainConfig.TOKEN_INTERNAL, mainConfig.OAUTH_CLIENT_SECRET, mainConfig.OAUTH_PASSWORD];
  const tokens: ScopedToken[] = [];
  const seenNames = new Set<string>();
  const seenSecrets = new Set<string>();

  entries.data.forEach((entry, index) => {
    const where = `SCOPED_TOKENS_JSON[${index}]`;
    if (seenNames.has(entry.name)) errors.push(`${where}.name: "${entry.name}" is used twice`);
    seenNames.add(entry.name);

    const secret = env[entry.tokenEnv];
    if (secret === undefined || secret === "") {
      errors.push(`${where}.tokenEnv: environment variable ${entry.tokenEnv} is not set`);
      return;
    }
    if (secret.length < 32) {
      errors.push(`${where}.tokenEnv: the value of ${entry.tokenEnv} must be at least 32 characters`);
      return;
    }
    if (mainSecrets.includes(secret)) {
      errors.push(`${where}.tokenEnv: the value of ${entry.tokenEnv} must differ from the main listener's secrets`);
      return;
    }
    if (seenSecrets.has(secret)) {
      errors.push(`${where}.tokenEnv: the value of ${entry.tokenEnv} is already used by another token`);
      return;
    }
    seenSecrets.add(secret);

    tokens.push({
      name: entry.name,
      secret,
      allowFrom: entry.allowFrom,
      writeDir: entry.writeDir,
      readDeny: entry.readDeny,
      expiresAt: entry.expiresAt,
      writesPerHour: entry.writesPerHour,
      frontmatter: entry.frontmatter,
      tags: entry.tags,
    });
  });

  if (errors.length > 0 || !port.success) return { status: "invalid", errors };
  return { status: "enabled", port: port.data, tokens };
}
