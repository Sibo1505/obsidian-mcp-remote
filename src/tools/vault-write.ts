import { z } from "zod";
import { writeNote } from "../vault/fs.js";

export const vaultWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type VaultWriteInput = z.infer<typeof vaultWriteSchema>;

export async function vaultWrite(vaultRoot: string, input: VaultWriteInput) {
  await writeNote(vaultRoot, input.path, input.content);
  return { path: input.path, written: true };
}
