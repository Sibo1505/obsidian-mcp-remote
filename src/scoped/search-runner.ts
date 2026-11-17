import { Worker, type ResourceLimits } from "node:worker_threads";
import { SearchLimitError, type SearchQueryResult } from "../vault/search.js";
import { ScopedDenied } from "./guard.js";
import type { SearchJob, SearchReply } from "./search-worker.js";

/** Hard limit for one scoped search, from start to end (worker start included). */
export const SCOPED_SEARCH_TIMEOUT_MS = 10_000;

/** Memory ceiling of the worker thread that runs one scoped search. */
export const SCOPED_SEARCH_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

// Built to dist/scoped/search-worker.js; under tsx (tests, `npm run dev`) the source file is .ts.
const WORKER_URL = new URL(`./search-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url);

type Outcome = { results: SearchQueryResult[] } | { error: Error };

function replyError(reply: Extract<SearchReply, { ok: false }>): Error {
  if (reply.limit) return new SearchLimitError(reply.message);
  // Keep the code, so a system error becomes the fixed client text (see clientError in tools.ts).
  return Object.assign(new Error(reply.message), reply.code ? { code: reply.code } : {});
}

/**
 * Runs scoped searches in a worker thread, one at a time. A search that takes longer than
 * `timeoutMs` or needs more memory than `resourceLimits` is stopped and ends with a SearchLimitError;
 * the main thread (and with it the main listener) never waits on the search itself. A second search
 * while one runs is refused instead of queued, so a client cannot pile them up.
 */
export class ScopedSearch {
  private running = false;

  constructor(
    private readonly timeoutMs = SCOPED_SEARCH_TIMEOUT_MS,
    private readonly resourceLimits = SCOPED_SEARCH_RESOURCE_LIMITS,
  ) {}

  async run(job: SearchJob): Promise<SearchQueryResult[]> {
    if (this.running) {
      throw new ScopedDenied("search-busy", "Another search is still running on this listener; try again in a few seconds");
    }
    this.running = true;
    try {
      return await this.inWorker(job);
    } finally {
      this.running = false;
    }
  }

  /** Settles only once the worker has exited, so two search workers never run side by side. */
  private inWorker(job: SearchJob): Promise<SearchQueryResult[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL, { workerData: job, resourceLimits: this.resourceLimits });
      let outcome: Outcome | undefined;
      const finish = (next: Outcome) => {
        outcome ??= next;
        void worker.terminate();
      };
      const timer = setTimeout(() => {
        finish({ error: new SearchLimitError(`Search stopped after ${this.timeoutMs / 1000} seconds; narrow the query`) });
      }, this.timeoutMs);
      worker.on("message", (reply: SearchReply) => {
        finish(reply.ok ? { results: reply.results } : { error: replyError(reply) });
      });
      worker.on("error", (error) => {
        const outOfMemory = (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY";
        const megabytes = this.resourceLimits.maxOldGenerationSizeMb;
        finish({
          error: outOfMemory
            ? new SearchLimitError(`Search stopped: it needed more than ${megabytes} MB of memory; narrow the query`)
            : new Error("Search failed"),
        });
      });
      worker.on("exit", () => {
        clearTimeout(timer);
        if (outcome && "results" in outcome) resolve(outcome.results);
        else reject(outcome?.error ?? new Error("Search failed"));
      });
    });
  }
}
