import { z } from "zod";

const configSchema = z.object({
  VAULT_PATH: z.string().min(1),
  TOKEN_INTERNAL: z.string().min(32),
  DOMAIN: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  OAUTH_PASSWORD: z.string().min(16),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_CLIENT_SECRET: z.string().min(32),
  OAUTH_CLIENT_REDIRECT_URI: z.string().min(1),
  OAUTH_STORE_PATH: z.string().min(1).default("/data/oauth-store.json"),
  WEBAUTHN_STORE_PATH: z.string().min(1).default("/data/webauthn-credential.json"),
  // Opt-in: unset (or empty — docker-compose passes "" for an unset .env var, not an absent key)
  // means no security-event notifications, not an error.
  NTFY_TOPIC: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid configuration:", result.error.format());
    process.exit(1);
  }
  return result.data;
}
