import { sleep } from "./sleep.js";

/**
 * Wrap a Graph API call so that "transient" errors (Meta marks them with
 * `is_transient: true` — typically image/video fetch hiccups while their
 * crawler waits for CDN propagation) get retried with exponential backoff.
 *
 * Non-transient errors throw immediately so we don't burn time retrying
 * permission or aspect-ratio rejections.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 8000;
  const label = opts.label ?? "graph call";

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const isTransient =
        msg.includes('"is_transient":true') ||
        msg.includes("is_transient: true") ||
        // FB's image-fetch failure: "Missing or invalid image file"
        msg.includes("Missing or invalid image file") ||
        // FB's video-fetch failure
        msg.includes("Unable to fetch video file from URL") ||
        // IG's media-fetch failure
        msg.includes("Media download has failed") ||
        msg.includes("Only photo or video can be accepted");
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `${label} attempt ${attempt}/${maxAttempts} failed transiently, retrying in ${delay}ms: ${msg.slice(0, 200)}`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
