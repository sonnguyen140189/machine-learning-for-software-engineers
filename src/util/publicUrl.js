import { basename } from "node:path";
import { config } from "../config.js";

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
