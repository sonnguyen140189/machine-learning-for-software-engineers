import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";

const MEDIA_DIR = "out/media";

/**
 * @typedef {Object} BrollMeta
 * @property {string} source
 * @property {string} url            — direct mp4 link from Pexels CDN
 * @property {number} duration       — seconds, integer
 * @property {number} width
 * @property {number} height
 * @property {string} photographer
 * @property {string} photographerUrl
 */

async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`B-roll download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return filePath;
}

// Pexels returns multiple `video_files` per clip (different resolutions and
// formats). Prefer the smallest portrait mp4 ≥ 1080 tall so cropping to
// 1080×1920 is a downscale (no upscale blur); if none qualify, fall back to
// the largest portrait we have rather than skipping the clip entirely.
function pickBestPortrait(videoFiles) {
  const portrait = videoFiles.filter(
    (vf) => vf.file_type === "video/mp4" && vf.height >= vf.width,
  );
  if (!portrait.length) return null;
  portrait.sort((a, b) => a.height - b.height);
  const aboveThreshold = portrait.find((vf) => vf.height >= 1080);
  return aboveThreshold || portrait[portrait.length - 1];
}

/**
 * Search Pexels Videos for portrait B-roll clips matching the query.
 * @param {string} query
 * @param {number} count            — number of distinct clips to return
 * @returns {Promise<BrollMeta[]>}
 */
export async function fetchPexelsBroll(query, count = 2) {
  if (!config.pexelsApiKey) return [];
  const url =
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
    `&per_page=${Math.max(count * 3, 6)}&orientation=portrait&min_duration=3&max_duration=15`;
  const res = await fetch(url, { headers: { Authorization: config.pexelsApiKey } });
  if (!res.ok) return [];
  const data = await res.json();
  const videos = data.videos || [];
  const picked = [];
  for (const v of videos) {
    if (picked.length >= count) break;
    const file = pickBestPortrait(v.video_files || []);
    if (!file) continue;
    picked.push({
      source: "pexels_video",
      url: file.link,
      duration: v.duration,
      width: file.width,
      height: file.height,
      photographer: v.user?.name || "Unknown",
      photographerUrl: v.user?.url || "https://pexels.com",
    });
  }
  return picked;
}

// Crop & normalize a downloaded B-roll clip to 1080×1920 portrait, trim to
// scene length, and strip audio (the slideshow mixes music separately so any
// B-roll audio would clash). Re-encoding to h264/yuv420p also guarantees
// xfade compatibility with the still-image scenes built by zoompan.
function cropToPortrait(inputPath, outputPath, durationSec) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", inputPath,
      "-t", String(durationSec),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p",
      "-an",
      "-r", "30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);
    ff.on("error", reject);
    ff.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg crop B-roll exited ${code}`)),
    );
  });
}

/**
 * Download Pexels B-roll clips and crop each to 1080×1920 at the requested
 * scene duration. Skips clips that fail to download/crop rather than aborting
 * the whole batch — returning fewer paths than requested is fine because
 * buildSlideshowVideo tolerates an empty brollPaths array.
 *
 * @param {BrollMeta[]} clips
 * @param {string} prefix
 * @param {number} sceneDuration    — seconds per scene (default 3)
 * @returns {Promise<string[]>}     — local paths to cropped, normalized mp4s
 */
export async function downloadBrollClips(clips, prefix, sceneDuration = 3) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const paths = [];
  for (let i = 0; i < clips.length; i++) {
    const rawPath = join(MEDIA_DIR, `${prefix}-broll-${i}.raw.mp4`);
    const outPath = join(MEDIA_DIR, `${prefix}-broll-${i}.mp4`);
    try {
      await downloadTo(clips[i].url, rawPath);
      await cropToPortrait(rawPath, outPath, sceneDuration);
      await unlink(rawPath).catch(() => {});
      paths.push(outPath);
    } catch (err) {
      console.warn(`Skipping B-roll ${i}: ${err.message}`);
      await unlink(rawPath).catch(() => {});
    }
  }
  return paths;
}

/**
 * One-call helper: fetch + download + crop B-roll for a place. Returns up to
 * `count` local mp4 paths. Falls back to a generic Phú Quốc query when the
 * specific place query yields nothing — better generic drone footage than no
 * motion at all.
 */
export async function gatherBrollForPlace(placeName, prefix, { count = 2, sceneDuration = 3 } = {}) {
  if (!config.pexelsApiKey) return [];
  const specific = `${placeName} Phu Quoc Vietnam`;
  let clips = await fetchPexelsBroll(specific, count);
  if (clips.length < count) {
    const generic = "Phu Quoc Vietnam beach drone";
    const more = await fetchPexelsBroll(generic, count - clips.length);
    clips = [...clips, ...more];
  }
  if (!clips.length) return [];
  return downloadBrollClips(clips, prefix, sceneDuration);
}

// CLI test
if (import.meta.url === `file://${process.argv[1]}`) {
  const clips = await fetchPexelsBroll("Phu Quoc Vietnam beach", 2);
  console.log(JSON.stringify(clips, null, 2));
}
