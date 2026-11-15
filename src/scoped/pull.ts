/** How long a finished pull counts as fresh enough for scoped reads. */
export const SCOPED_PULL_INTERVAL_MS = 10_000;

/**
 * Wraps the freshness pull for scoped reads. Every vault_read/vault_list/search_query used to queue
 * its own `git pull` behind the one process-wide git lock, which both listeners share, so a burst
 * of scoped reads could hold up writes on the main port. Now: callers that arrive while a pull runs
 * share it, and for `intervalMs` after a pull started no new one starts (reads may then be up to
 * that many milliseconds behind the remote).
 */
export function throttlePull(
  pull: () => Promise<void>,
  intervalMs = SCOPED_PULL_INTERVAL_MS,
  now: () => number = Date.now,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let lastStart = Number.NEGATIVE_INFINITY;
  return () => {
    if (inFlight) return inFlight;
    if (now() - lastStart < intervalMs) return Promise.resolve();
    lastStart = now();
    inFlight = pull().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
