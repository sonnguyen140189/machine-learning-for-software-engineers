import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { sleep } from "./util/sleep.js";
import { fetchDailyCandidates } from "./fetchers/places.js";
import { gatherPhotosForPlace, downloadPhotos } from "./fetchers/photos.js";
import { generateContent } from "./generator/content.js";
import { buildSlideshowVideo } from "./video/build.js";
import { toPublicUrl, ensureUrlReady } from "./util/publicUrl.js";
import { loadState, saveState } from "./util/state.js";
import { postFacebookCarousel, postFacebookVideo } from "./posters/facebook.js";
import { postInstagramCarousel, postInstagramReel } from "./posters/instagram.js";
import { postTikTokVideo } from "./posters/tiktok.js";

const OUT_DIR = "out";
const PENDING_FILE = join(OUT_DIR, "pending-batch.json");

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function generateForPlace(place, stamp) {
  const placeName = place.displayName?.text || "Phu Quoc";
  console.log(`\n--- Generate: ${placeName} (${place.id}) ---`);

  const placeShort = place.id.slice(-12);
  const prefix = `${stamp}-${placeShort}`;

  const photoMeta = await gatherPhotosForPlace(place, { count: 8 });
  if (photoMeta.length < 3) throw new Error(`Not enough photos for ${placeName}`);
  const downloaded = await downloadPhotos(photoMeta, prefix);
  const photoPaths = downloaded.map((p) => p.localPath);
  console.log(`Downloaded ${photoPaths.length} photos`);

  const content = await generateContent(place);
  await writeFile(
    join(OUT_DIR, `content-${prefix}.json`),
    JSON.stringify(content, null, 2),
  );

  const videoPath = join(OUT_DIR, "media", `${prefix}.mp4`);
  await buildSlideshowVideo(photoPaths.slice(0, 6), content.video_script, videoPath, 3);
  console.log(`Built video: ${videoPath}`);

  return {
    placeId: place.id,
    placeName,
    photoPaths,
    videoPath,
    content,
  };
}

async function postOnePending(item) {
  const { placeName, photoPaths, videoPath, content } = item;
  console.log(`\n--- Post: ${placeName} ---`);

  const photoUrls = photoPaths.map(toPublicUrl);
  const videoUrl = toPublicUrl(videoPath);

  // Verify every media URL is reachable on Pages BEFORE handing it to Graph.
  // Pages CDN propagates across edges asynchronously, and FB caches 404s from
  // failed fetches — so probing per-URL right before posting catches stragglers
  // that the workflow's single-file wait step missed.
  // Throw on failure so the caller leaves the place in the candidate pool
  // and a later run can retry it instead of treating it as "already posted".
  console.log(`Verifying ${photoUrls.length + 1} media URLs reachable...`);
  for (const url of [...photoUrls, videoUrl]) {
    await ensureUrlReady(url, { maxSeconds: 120, intervalMs: 5000 });
  }

  const results = {};
  const fbCaption = content.facebook.first_comment
    ? `${content.facebook.caption}\n\n${content.facebook.first_comment}`
    : content.facebook.caption;

  try {
    results.facebook = await postFacebookCarousel(photoUrls, fbCaption);
  } catch (err) {
    results.facebook = { error: err.message };
    console.error("FB carousel failed:", err.message);
  }

  if (!config.skipInstagram) {
    try {
      results.instagram = await postInstagramCarousel(
        photoUrls,
        `${content.instagram.caption}\n\n${content.instagram.hashtags}`,
      );
    } catch (err) {
      results.instagram = { error: err.message };
      console.error("IG carousel failed:", err.message);
    }
  } else {
    results.instagram = { skipped: "SKIP_INSTAGRAM=true" };
  }

  try {
    results.facebookVideo = await postFacebookVideo(videoUrl, fbCaption);
  } catch (err) {
    results.facebookVideo = { error: err.message };
    console.error("FB video failed:", err.message);
  }

  if (!config.skipInstagram) {
    try {
      results.instagramReel = await postInstagramReel(videoUrl, content.instagram.caption);
    } catch (err) {
      results.instagramReel = { error: err.message };
      console.error("IG Reel failed:", err.message);
    }
  } else {
    results.instagramReel = { skipped: "SKIP_INSTAGRAM=true" };
  }

  try {
    results.tiktok = await postTikTokVideo(videoUrl, content.tiktok.caption);
  } catch (err) {
    results.tiktok = { error: err.message };
  }

  return { placeId: item.placeId, placeName, results };
}

async function generatePhase() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(join(OUT_DIR, "media"), { recursive: true });
  const state = await loadState();
  const stamp = todayStamp();
  const n = config.postsPerRun;

  console.log(`=== GENERATE phase: ${stamp} (posts=${n}) ===`);

  const candidates = await fetchDailyCandidates({ count: Math.max(n * 4, 12) });
  if (!candidates.length) throw new Error("No place candidates returned");

  const pending = [];
  const chosenIds = new Set();
  for (let i = 0; i < n; i++) {
    const place = candidates.find(
      (p) => !state.postedPlaceIds.includes(p.id) && !chosenIds.has(p.id),
    );
    if (!place) {
      console.warn(`Ran out of fresh candidates after ${i} places`);
      break;
    }
    chosenIds.add(place.id);
    try {
      const item = await generateForPlace(place, stamp);
      pending.push(item);
    } catch (err) {
      console.error(`Generate failed for ${place.id}: ${err.message}`);
    }
  }

  await writeFile(PENDING_FILE, JSON.stringify({ stamp, items: pending }, null, 2));
  console.log(`\n=== Generated ${pending.length}/${n}. Wrote ${PENDING_FILE}. ===`);
}

async function postPhase() {
  const state = await loadState();
  const raw = await readFile(PENDING_FILE, "utf8").catch(() => null);
  if (!raw) throw new Error(`${PENDING_FILE} not found — run generate phase first`);
  const { stamp, items } = JSON.parse(raw);

  console.log(`=== POST phase: ${stamp} (${items.length} items, skipIG=${config.skipInstagram}) ===`);

  if (config.dryRun) {
    console.log("[DRY] would post:", items.map((i) => i.placeName));
    return;
  }

  for (let i = 0; i < items.length; i++) {
    try {
      const out = await postOnePending(items[i]);
      state.postedPlaceIds = [items[i].placeId, ...state.postedPlaceIds].slice(0, 500);
      state.history.unshift({ date: stamp, placeId: items[i].placeId, placeName: out.placeName, results: out.results });
    } catch (err) {
      console.error(`Post failed for ${items[i].placeId}: ${err.message}`);
    }
    if (i < items.length - 1) await sleep(5000);
  }
  state.history = state.history.slice(0, 200);
  await saveState(state);

  // Clear pending so next generate run starts clean
  await unlink(PENDING_FILE).catch(() => {});
  console.log("\n=== Post phase done ===");
}

async function main() {
  const phase = (process.env.PHASE || "all").toLowerCase();
  if (phase === "generate") return generatePhase();
  if (phase === "post") return postPhase();
  // Legacy single-shot for ad-hoc local runs (generate + post in one process).
  // Not safe for cloud runs because URLs aren't yet served by Pages.
  await generatePhase();
  await postPhase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
