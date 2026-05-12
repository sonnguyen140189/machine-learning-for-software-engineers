import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { fetchDailyCandidates } from "./fetchers/places.js";
import { gatherPhotosForPlace, downloadPhotos } from "./fetchers/photos.js";
import { generateContent } from "./generator/content.js";
import { buildSlideshowVideo } from "./video/build.js";
import { toPublicUrl } from "./util/publicUrl.js";
import { loadState, saveState } from "./util/state.js";
import { postFacebookCarousel } from "./posters/facebook.js";
import { postInstagramCarousel, postInstagramReel } from "./posters/instagram.js";
import { postTikTokVideo } from "./posters/tiktok.js";

const OUT_DIR = "out";

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function pickFreshPlace(candidates, postedIds) {
  const fresh = candidates.filter((p) => !postedIds.includes(p.id));
  return fresh[0] || candidates[0];
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const state = await loadState();
  const stamp = todayStamp();

  console.log(`=== Daily Phu Quoc post: ${stamp} (dryRun=${config.dryRun}) ===`);

  // 1. Find a place to feature today
  const candidates = await fetchDailyCandidates({ count: 12 });
  if (!candidates.length) throw new Error("No place candidates returned");
  const place = pickFreshPlace(candidates, state.postedPlaceIds);
  const placeName = place.displayName?.text || "Phu Quoc";
  console.log(`Today's place: ${placeName} (${place.id})`);

  // 2. Gather + download photos
  const photoMeta = await gatherPhotosForPlace(place, { count: 8 });
  if (photoMeta.length < 3) throw new Error(`Not enough photos for ${placeName}`);
  const downloaded = await downloadPhotos(photoMeta, stamp);
  const photoPaths = downloaded.map((p) => p.localPath);
  console.log(`Downloaded ${photoPaths.length} photos`);

  // 3. Generate captions / hashtags / video script
  const content = await generateContent(place);
  await writeFile(join(OUT_DIR, `content-${stamp}.json`), JSON.stringify(content, null, 2));

  // 4. Build the video
  const videoPath = join(OUT_DIR, "media", `${stamp}.mp4`);
  await buildSlideshowVideo(photoPaths.slice(0, 6), content.video_script, videoPath, 3);
  console.log(`Built video: ${videoPath}`);

  // 5. Resolve public URLs (will throw if PUBLIC_MEDIA_BASE_URL unset)
  let photoUrls = [];
  let videoUrl = null;
  try {
    photoUrls = photoPaths.map(toPublicUrl);
    videoUrl = toPublicUrl(videoPath);
  } catch (err) {
    if (!config.dryRun) throw err;
    console.warn(`[DRY] skipping URL resolution: ${err.message}`);
  }

  // 6. Post to each platform (no-op when DRY_RUN=true)
  const results = {};

  try {
    results.facebook = await postFacebookCarousel(
      photoUrls,
      content.facebook.caption,
      content.facebook.first_comment,
    );
  } catch (err) {
    results.facebook = { error: err.message };
    console.error("Facebook post failed:", err.message);
  }

  try {
    results.instagram = await postInstagramCarousel(
      photoUrls,
      `${content.instagram.caption}\n\n${content.instagram.hashtags}`,
    );
  } catch (err) {
    results.instagram = { error: err.message };
    console.error("Instagram carousel failed:", err.message);
  }

  if (videoUrl) {
    try {
      results.instagramReel = await postInstagramReel(videoUrl, content.instagram.caption);
    } catch (err) {
      results.instagramReel = { error: err.message };
      console.error("Instagram Reel failed:", err.message);
    }
    try {
      results.tiktok = await postTikTokVideo(videoUrl, content.tiktok.caption);
    } catch (err) {
      results.tiktok = { error: err.message };
      console.error("TikTok post failed:", err.message);
    }
  }

  // 7. Persist state
  state.postedPlaceIds = [place.id, ...state.postedPlaceIds].slice(0, 200);
  state.history.unshift({ date: stamp, placeId: place.id, placeName, results });
  state.history = state.history.slice(0, 90);
  await saveState(state);

  console.log("Done.");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
