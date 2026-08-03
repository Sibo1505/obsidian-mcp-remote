import { z } from "zod";
import { listDir } from "../vault/fs.js";

export const vaultListSchema = z.object({
  path: z.string().default(""),
});

export type VaultListInput = z.infer<typeof vaultListSchema>;

export async function vaultList(vaultRoot: string, input: VaultListInput) {
  const entries = await listDir(vaultRoot, input.path);
  return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
}
