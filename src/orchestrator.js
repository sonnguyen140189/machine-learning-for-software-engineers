import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { fetchDailyCandidates } from "./fetchers/places.js";
import { gatherPhotosForPlace, downloadPhotos } from "./fetchers/photos.js";
import { generateContent } from "./generator/content.js";
import { buildSlideshowVideo } from "./video/build.js";
import { toPublicUrl } from "./util/publicUrl.js";
import { loadState, saveState } from "./util/state.js";
import { postFacebookCarousel, postFacebookVideo } from "./posters/facebook.js";
import { postInstagramCarousel, postInstagramReel } from "./posters/instagram.js";
import { postTikTokVideo } from "./posters/tiktok.js";

const OUT_DIR = "out";

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postOnePlace(place, stamp, state) {
  const placeName = place.displayName?.text || "Phu Quoc";
  console.log(`\n--- Posting: ${placeName} (${place.id}) ---`);

  // Unique per-run prefix so URLs never collide with a previous run's
  // still-cached files on GitHub Pages.
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

  let photoUrls = [];
  let videoUrl = null;
  try {
    photoUrls = photoPaths.map(toPublicUrl);
    videoUrl = toPublicUrl(videoPath);
  } catch (err) {
    if (!config.dryRun) throw err;
    console.warn(`[DRY] skipping URL resolution: ${err.message}`);
  }

  const results = {};

  const fbCaption = content.facebook.first_comment
    ? `${content.facebook.caption}\n\n${content.facebook.first_comment}`
    : content.facebook.caption;

  try {
    results.facebook = await postFacebookCarousel(photoUrls, fbCaption);
  } catch (err) {
    results.facebook = { error: err.message };
    console.error("Facebook post failed:", err.message);
  }

  if (!config.skipInstagram) {
    try {
      results.instagram = await postInstagramCarousel(
        photoUrls,
        `${content.instagram.caption}\n\n${content.instagram.hashtags}`,
      );
    } catch (err) {
      results.instagram = { error: err.message };
      console.error("Instagram carousel failed:", err.message);
    }
  } else {
    results.instagram = { skipped: "SKIP_INSTAGRAM=true" };
  }

  if (videoUrl) {
    try {
      results.facebookVideo = await postFacebookVideo(videoUrl, fbCaption);
    } catch (err) {
      results.facebookVideo = { error: err.message };
      console.error("Facebook video failed:", err.message);
    }

    if (!config.skipInstagram) {
      try {
        results.instagramReel = await postInstagramReel(videoUrl, content.instagram.caption);
      } catch (err) {
        results.instagramReel = { error: err.message };
        console.error("Instagram Reel failed:", err.message);
      }
    } else {
      results.instagramReel = { skipped: "SKIP_INSTAGRAM=true" };
    }

    try {
      results.tiktok = await postTikTokVideo(videoUrl, content.tiktok.caption);
    } catch (err) {
      results.tiktok = { error: err.message };
      console.error("TikTok post failed:", err.message);
    }
  }

  state.postedPlaceIds = [place.id, ...state.postedPlaceIds].slice(0, 500);
  state.history.unshift({ date: stamp, placeId: place.id, placeName, results });
  state.history = state.history.slice(0, 200);
  await saveState(state);

  return { placeName, results };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const state = await loadState();
  const stamp = todayStamp();
  const n = config.postsPerRun;

  console.log(
    `=== Phu Quoc batch: ${stamp} (dryRun=${config.dryRun}, ` +
      `posts=${n}, skipInstagram=${config.skipInstagram}) ===`,
  );

  // Pull a larger candidate pool so we always have N fresh places.
  const candidates = await fetchDailyCandidates({ count: Math.max(n * 4, 12) });
  if (!candidates.length) throw new Error("No place candidates returned");

  const summary = [];
  for (let i = 0; i < n; i++) {
    const fresh = candidates.filter(
      (p) =>
        !state.postedPlaceIds.includes(p.id) &&
        !summary.some((s) => s.placeId === p.id),
    );
    const place = fresh[0] || candidates[i % candidates.length];
    try {
      const out = await postOnePlace(place, stamp, state);
      summary.push({ placeId: place.id, placeName: out.placeName, results: out.results });
    } catch (err) {
      console.error(`Post ${i + 1}/${n} failed for ${place.id}: ${err.message}`);
      summary.push({ placeId: place.id, error: err.message });
    }
    // Brief pacing between posts to ease API rate-limit pressure.
    if (i < n - 1) await sleep(5000);
  }

  console.log("\n=== Batch done ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
