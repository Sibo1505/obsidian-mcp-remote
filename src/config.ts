import { z } from "zod";

const configSchema = z.object({
  VAULT_PATH: z.string().min(1),
  TOKEN_INTERNAL: z.string().min(32),
  TOKEN_EXTERNAL: z.string().min(32),
  DOMAIN: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
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
