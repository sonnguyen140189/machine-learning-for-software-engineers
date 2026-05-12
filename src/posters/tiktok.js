import { config } from "../config.js";

const API = "https://open.tiktokapis.com/v2";

async function tiktokPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Authorization: `Bearer ${config.tiktok.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== "ok") {
    throw new Error(`TikTok ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function tiktokGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${config.tiktok.accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== "ok") {
    throw new Error(`TikTok GET ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Publish a video to TikTok via Content Posting API (PULL_FROM_URL mode).
 * Requires app review approval and the video.publish scope.
 *
 * @param {string} videoUrl - publicly accessible mp4 URL on a verified domain
 * @param {string} title - caption with inline hashtags, max ~150 chars
 */
export async function postTikTokVideo(videoUrl, title) {
  if (!config.tiktok.accessToken) {
    throw new Error("TIKTOK_ACCESS_TOKEN not set");
  }
  if (config.dryRun) {
    console.log("[DRY] TikTok video:", { videoUrl, title });
    return { publish_id: "dry-run" };
  }

  const init = await tiktokPost("/post/publish/video/init/", {
    post_info: {
      title,
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl,
    },
  });

  const publishId = init.data.publish_id;

  // Poll status
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await tiktokGet(`/post/publish/status/fetch/?publish_id=${publishId}`);
    const s = status.data.status;
    if (s === "PUBLISH_COMPLETE") return { publishId, status: s };
    if (s === "FAILED") throw new Error(`TikTok publish failed: ${JSON.stringify(status.data)}`);
  }
  throw new Error(`TikTok publish ${publishId} did not complete in time`);
}

/**
 * Post a photo carousel to TikTok (PHOTO mode).
 * @param {string[]} photoUrls
 * @param {string} title
 * @param {string} description
 */
export async function postTikTokPhotos(photoUrls, title, description) {
  if (config.dryRun) {
    console.log("[DRY] TikTok photos:", { photoUrls, title, description });
    return { publish_id: "dry-run" };
  }
  return tiktokPost("/post/publish/content/init/", {
    post_info: {
      title,
      description,
      privacy_level: "PUBLIC_TO_EVERYONE",
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_images: photoUrls.map((url) => ({ image_url: url })),
      photo_cover_index: 0,
    },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO",
  });
}
