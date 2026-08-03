import { z } from "zod";
import { runJsonLogicQuery } from "../vault/search.js";

export const searchQuerySchema = z.object({
  query: z.record(z.string(), z.unknown()),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

export async function searchQuery(vaultRoot: string, input: SearchQueryInput) {
  return runJsonLogicQuery(vaultRoot, input.query as object);
}
