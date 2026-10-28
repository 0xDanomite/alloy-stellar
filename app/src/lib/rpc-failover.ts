/**
 * Public Stellar RPCs rate-limit per IP (roughly 60 to 80 requests in a short
 * window), and their 429s carry no CORS headers, so the browser reports a bare
 * network error. Everyone on one Wi-Fi shares that quota. This wraps `fetch`
 * for RPC requests only: on a network error, 429 or 5xx it moves to the next
 * endpoint and stays there while it keeps answering. The SDK sends its RPC
 * calls through global `fetch` too, so this covers every read and write.
 */

const ROUNDS = 3;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function installRpcFailover(urls: readonly string[]): void {
  const bases = urls.map((url) => url.replace(/\/$/, ""));
  const primary = bases[0];
  if (primary === undefined) return;
  const native = globalThis.fetch.bind(globalThis);
  let current = 0;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (input instanceof Request || !url.startsWith(primary)) return native(input, init);
    const path = url.slice(primary.length);

    let lastError: unknown;
    for (let round = 0; round < ROUNDS; round++) {
      if (round > 0) await sleep(1000 * 2 ** (round - 1));
      for (let tried = 0; tried < bases.length; tried++) {
        const index = (current + tried) % bases.length;
        try {
          const response = await native(`${bases[index]}${path}`, init);
          if (isRetryable(response.status)) {
            lastError = new Error(`RPC returned HTTP ${response.status}`);
            continue;
          }
          current = index;
          return response;
        } catch (error) {
          if (init?.signal?.aborted) throw error;
          lastError = error;
        }
      }
    }
    throw lastError;
  };
}
