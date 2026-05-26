import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { sleep } from "./util/sleep.js";
import { fetchDailyCandidates } from "./fetchers/places.js";
import { gatherPhotosForPlace, downloadPhotos } from "./fetchers/photos.js";
import { gatherBrollForPlace } from "./fetchers/broll.js";
import { generateContent } from "./generator/content.js";
import { buildSlideshowVideo } from "./video/build.js";
import { pickRandomMusic } from "./util/music.js";
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

async function generateForPlace(place, stamp, mode) {
  const placeName = place.displayName?.text || "Phu Quoc";
  console.log(`\n--- Generate (${mode}): ${placeName} (${place.id}) ---`);

  const placeShort = place.id.slice(-12);
  const prefix = `${stamp}-${placeShort}`;

  // Photos are always downloaded — video mode uses them as slideshow frames,
  // photo mode uses them as the carousel.
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

  let videoPath = null;
  if (mode === "video") {
    videoPath = join(OUT_DIR, "media", `${prefix}.mp4`);
    const musicPath = await pickRandomMusic();
    if (musicPath) console.log(`Music: ${musicPath}`);
    else console.log("No music in assets/music/ — building silent video");
    // Pexels B-roll: fail open. If the fetcher errors or returns nothing the
    // video still builds with just the photos — the Steps 1-3 enhancements
    // (Ken Burns + crossfade + brand font) already give it plenty of motion.
    let brollPaths = [];
    try {
      brollPaths = await gatherBrollForPlace(placeName, prefix, { count: 2, sceneDuration: 3 });
      if (brollPaths.length) console.log(`B-roll: ${brollPaths.length} clip(s)`);
    } catch (err) {
      console.warn(`B-roll fetch failed (continuing without): ${err.message}`);
    }
    await buildSlideshowVideo(
      photoPaths.slice(0, 6),
      content.video_script,
      videoPath,
      3,
      musicPath,
      brollPaths,
    );
    console.log(`Built video: ${videoPath}`);
  }

  return {
    placeId: place.id,
    placeName,
    mode,
    photoPaths,
    videoPath,
    content,
  };
}

async function postOnePending(item) {
  const { placeName, photoPaths, videoPath, content, mode } = item;
  console.log(`\n--- Post (${mode}): ${placeName} ---`);

  const photoUrls = photoPaths.map(toPublicUrl);
  const videoUrl = videoPath ? toPublicUrl(videoPath) : null;

  // Verify every media URL is reachable on Pages BEFORE handing it to Graph.
  // Pages CDN propagates across edges asynchronously, and FB caches 404s from
  // failed fetches — so probing per-URL right before posting catches stragglers
  // that the workflow's single-file wait step missed.
  // Throw on failure so the caller leaves the place in the candidate pool
  // and a later run can retry it instead of treating it as "already posted".
  const urlsToCheck = mode === "video" ? [videoUrl] : photoUrls;
  console.log(`Verifying ${urlsToCheck.length} media URLs reachable...`);
  for (const url of urlsToCheck) {
    await ensureUrlReady(url, { maxSeconds: 120, intervalMs: 5000 });
  }

  const results = {};

  if (mode === "photo") {
    // Photo-only run: FB carousel + IG carousel. Skip the video surfaces so
    // the feed doesn't show the same place twice in 1 minute.
    const fbPhotoCaption = content.facebook.first_comment
      ? `${content.facebook.caption}\n\n${content.facebook.first_comment}`
      : content.facebook.caption;
    const igPhotoCaption = `${content.instagram.caption}\n\n${content.instagram.hashtags}`;

    try {
      results.facebook = await postFacebookCarousel(photoUrls, fbPhotoCaption);
    } catch (err) {
      results.facebook = { error: err.message };
      console.error("FB carousel failed:", err.message);
    }
    if (!config.skipInstagram) {
      try {
        results.instagram = await postInstagramCarousel(photoUrls, igPhotoCaption);
      } catch (err) {
        results.instagram = { error: err.message };
        console.error("IG carousel failed:", err.message);
      }
    } else {
      results.instagram = { skipped: "SKIP_INSTAGRAM=true" };
    }
  } else {
    // Video-only run: FB video + IG Reel + TikTok. Prefer the video_caption so
    // the wording lines up with what the viewer SEES in the clips. Fall back
    // to the photo caption if older content didn't carry the new field.
    const fbVideoBase = content.facebook.video_caption || content.facebook.caption;
    const fbVideoCaption = content.facebook.first_comment
      ? `${fbVideoBase}\n\n${content.facebook.first_comment}`
      : fbVideoBase;
    const igVideoBase = content.instagram.video_caption || content.instagram.caption;
    const igVideoCaption = `${igVideoBase}\n\n${content.instagram.hashtags}`;

    try {
      results.facebookVideo = await postFacebookVideo(videoUrl, fbVideoCaption);
    } catch (err) {
      results.facebookVideo = { error: err.message };
      console.error("FB video failed:", err.message);
    }
    if (!config.skipInstagram) {
      try {
        results.instagramReel = await postInstagramReel(videoUrl, igVideoCaption);
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
  }

  return { placeId: item.placeId, placeName, mode, results };
}

async function generatePhase() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(join(OUT_DIR, "media"), { recursive: true });
  const state = await loadState();
  const stamp = todayStamp();
  const n = config.postsPerRun;

  console.log(`=== GENERATE phase: ${stamp} (posts=${n}) ===`);

  const candidates = await fetchDailyCandidates({
    count: Math.max(n * 4, 12),
    excludeIds: new Set(state.postedPlaceIds),
  });
  if (!candidates.length) throw new Error("No fresh place candidates returned (exhausted pool?)");

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
    // Alternate so the feed reads as "photo place, video place, photo place,
    // ..." instead of doubling every place across both formats. Index 0 is
    // photo so a 1-post ad-hoc run defaults to the cheaper / faster surface.
    const mode = i % 2 === 0 ? "photo" : "video";
    try {
      const item = await generateForPlace(place, stamp, mode);
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
