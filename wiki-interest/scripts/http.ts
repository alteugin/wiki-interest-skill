import axios, { type AxiosError } from "axios";

// Wikimedia asks API clients to identify themselves with a descriptive User-Agent.
const USER_AGENT =
  "wiki-interest-skill/0.1 (https://github.com/alteugin/wiki-interest-skill)";

const client = axios.create({
  timeout: 20_000,
  headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
});

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: AxiosError): boolean {
  const status = err.response?.status;
  // Network errors have no response; 429 and 5xx are transient on Wikimedia.
  return status === undefined || status === 429 || status >= 500;
}

/**
 * GET a JSON document. Returns null on 404 (the pageviews API uses 404 for
 * "no data for this article/range"), retries transient failures with backoff.
 */
export async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.get<T>(url);
      return res.data;
    } catch (e) {
      const err = e as AxiosError;
      if (err.response?.status === 404) return null;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) {
        const status = err.response?.status ?? "network";
        throw new Error(`HTTP ${status} for ${url}: ${err.message}`);
      }
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 500 * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
}
