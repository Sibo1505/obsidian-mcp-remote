import { z } from "zod";
import matter from "gray-matter";
import { readNote, statNote } from "../vault/fs.js";
import { extractHeadingSection } from "./heading.js";

export const vaultReadSchema = z.object({
  path: z.string().min(1),
  target: z.string().optional(),
  targetType: z.enum(["heading", "block", "frontmatter"]).optional(),
  targetDelimiter: z.string().default("::"),
});

export type VaultReadInput = z.infer<typeof vaultReadSchema>;

export async function vaultRead(vaultRoot: string, input: VaultReadInput) {
  const raw = await readNote(vaultRoot, input.path);

  if (!input.targetType || !input.target) {
    const { content, data } = matter(raw);
    const stat = await statNote(vaultRoot, input.path);
    return { path: input.path, content, frontmatter: data, stat };
  }

  if (input.targetType === "frontmatter") {
    const { data } = matter(raw);
    if (!(input.target in data)) {
      throw new Error(`Frontmatter key not found: ${input.target}`);
    }
    return data[input.target];
  }

  if (input.targetType === "heading") {
    const { content } = matter(raw);
    const section = extractHeadingSection(content, input.target, input.targetDelimiter);
    if (!section) {
      throw new Error(`Heading not found: ${input.target}`);
    }
    return section.text;
  }

  throw new Error("targetType 'block' is not supported in v1");
}
