/**
 * Worker thread for one scoped search (started by search-runner.ts). Indexes every note the token
 * may read and evaluates the query under the scoped search limits. It runs in its own thread so the
 * main thread can stop it at any point, even inside a single slow regular expression, and so its
 * memory has a ceiling of its own.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runJsonLogicQuery, SearchLimitError, type SearchLimits, type SearchQueryResult } from "../vault/search.js";
import { checkReadable } from "./guard.js";

export interface SearchJob {
  vaultRoot: string;
  readDeny: string[];
  query: object;
  limits: SearchLimits;
}

export type SearchReply =
  | { ok: true; results: SearchQueryResult[] }
  | { ok: false; limit: boolean; message: string; code?: string };

const job = workerData as SearchJob;

const readable = async (relativePath: string) => {
  try {
    await checkReadable(job.vaultRoot, job.readDeny, relativePath);
    return true;
  } catch {
    return false;
  }
};

let reply: SearchReply;
try {
  reply = { ok: true, results: await runJsonLogicQuery(job.vaultRoot, job.query, readable, job.limits) };
} catch (error) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  reply = {
    ok: false,
    limit: error instanceof SearchLimitError,
    message: error instanceof Error ? error.message : String(error),
    code: typeof code === "string" ? code : undefined,
  };
}
parentPort!.postMessage(reply);
