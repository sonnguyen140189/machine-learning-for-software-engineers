import { basename } from "node:path";
import { config } from "../config.js";
import { sleep } from "./sleep.js";

/**
 * Map a local generated media file path to a public URL.
 * Assumes the file is committed to the repo and exposed via GitHub Pages
 * (or another static host) at PUBLIC_MEDIA_BASE_URL/<filename>.
 *
 * @param {string} localPath
 * @returns {string}
 */
export function toPublicUrl(localPath) {
  if (!config.publicMediaBaseUrl) {
    throw new Error("PUBLIC_MEDIA_BASE_URL not set; cannot expose media publicly");
  }
  const base = config.publicMediaBaseUrl.replace(/\/+$/, "");
  return `${base}/${basename(localPath)}`;
}

/**
 * Poll a URL with HEAD until it returns 2xx, or throw on timeout.
 * GitHub Pages CDN can take several minutes to propagate newly-pushed files
 * across edges, and the FB media fetcher caches 404 responses for a while —
 * so we verify EACH URL from the post-phase side before handing it to Graph.
 *
 * @param {string} url
 * @param {{ maxSeconds?: number, intervalMs?: number }} [opts]
 */
export async function ensureUrlReady(url, { maxSeconds = 120, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + maxSeconds * 1000;
  let lastCode = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      lastCode = res.status;
      if (res.ok) return;
    } catch {
      // network blip — keep polling
    }
    await sleep(intervalMs);
  }
  throw new Error(`URL not ready after ${maxSeconds}s (last HTTP ${lastCode}): ${url}`);
}
