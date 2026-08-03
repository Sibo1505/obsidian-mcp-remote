import { z } from "zod";
import matter from "gray-matter";
import { readNote, writeNote } from "../vault/fs.js";
import { patchHeadingSection } from "./heading.js";

export const vaultPatchSchema = z.object({
  path: z.string().min(1),
  targetType: z.enum(["heading", "block", "frontmatter"]),
  target: z.string().min(1),
  operation: z.enum(["replace", "prepend", "append"]),
  content: z.unknown(),
  contentType: z.enum(["text/markdown", "application/json"]).default("text/markdown"),
  createTargetIfMissing: z.boolean().default(false),
  trimTargetWhitespace: z.boolean().default(false),
  rejectIfContentPreexists: z.boolean().default(false),
  targetScope: z.enum(["content", "marker", "markerAndContent"]).default("content"),
  targetDelimiter: z.string().default("::"),
});

export type VaultPatchInput = z.infer<typeof vaultPatchSchema>;

function parseContentValue(input: VaultPatchInput): unknown {
  if (input.contentType === "application/json") {
    return typeof input.content === "string" ? JSON.parse(input.content) : input.content;
  }
  return input.content;
}

function patchFrontmatterValue(
  existing: Record<string, unknown>,
  target: string,
  operation: VaultPatchInput["operation"],
  value: unknown,
  createTargetIfMissing: boolean,
): Record<string, unknown> {
  const hasTarget = target in existing;
  if (!hasTarget && !createTargetIfMissing) {
    throw new Error(`Frontmatter key not found: ${target}`);
  }

  const current = existing[target];
  const next = { ...existing };

  if (operation === "replace" || current === undefined) {
    next[target] = value;
    return next;
  }

  if (Array.isArray(current)) {
    const additions = Array.isArray(value) ? value : [value];
    next[target] = operation === "prepend" ? [...additions, ...current] : [...current, ...additions];
    return next;
  }

  if (typeof current === "string") {
    next[target] = operation === "prepend" ? `${String(value)}${current}` : `${current}${String(value)}`;
    return next;
  }

  throw new Error(`Cannot ${operation} onto frontmatter key '${target}' of type ${typeof current}`);
}

export async function vaultPatch(vaultRoot: string, input: VaultPatchInput) {
  if (input.targetType === "block") {
    throw new Error("targetType 'block' is not supported in v1");
  }

  const raw = await readNote(vaultRoot, input.path);
  const value = parseContentValue(input);

  if (input.targetType === "frontmatter") {
    const { content, data } = matter(raw);
    const nextData = patchFrontmatterValue(data, input.target, input.operation, value, input.createTargetIfMissing);
    const output = matter.stringify(content, nextData);
    await writeNote(vaultRoot, input.path, output);
    return { path: input.path, patched: true };
  }

  const { content, data } = matter(raw);
  const patchedContent = patchHeadingSection(content, input.target, input.targetDelimiter, {
    operation: input.operation,
    newContent: typeof value === "string" ? value : JSON.stringify(value),
    scope: input.targetScope,
    createTargetIfMissing: input.createTargetIfMissing,
    trimTargetWhitespace: input.trimTargetWhitespace,
    rejectIfContentPreexists: input.rejectIfContentPreexists,
  });
  const output = Object.keys(data).length > 0 ? matter.stringify(patchedContent, data) : patchedContent;
  await writeNote(vaultRoot, input.path, output);
  return { path: input.path, patched: true };
}
