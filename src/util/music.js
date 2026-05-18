import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MUSIC_DIR = "assets/music";

/**
 * Pick a random music track from assets/music/. Returns the relative path,
 * or null when the directory is missing or empty so the video build can
 * gracefully fall back to a silent video instead of crashing the cron.
 *
 * Supported extensions: .mp3, .m4a, .wav, .aac, .ogg
 *
 * @returns {Promise<string | null>}
 */
export async function pickRandomMusic() {
  let entries;
  try {
    entries = await readdir(MUSIC_DIR);
  } catch {
    return null;
  }
  const tracks = entries.filter((name) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(name));
  if (!tracks.length) return null;
  const choice = tracks[Math.floor(Math.random() * tracks.length)];
  return join(MUSIC_DIR, choice);
}
