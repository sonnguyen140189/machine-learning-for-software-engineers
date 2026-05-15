import { config } from "../config.js";
import { withTransientRetry } from "../util/graphRetry.js";

const GRAPH = "https://graph.facebook.com/v21.0";

async function graphPostRaw(path, body) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`IG Graph ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

function graphPost(path, body) {
  return withTransientRetry(() => graphPostRaw(path, body), { label: `IG ${path}` });
}

async function graphGet(path) {
  const res = await fetch(`${GRAPH}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`IG Graph GET ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function waitForContainerReady(containerId, token, { maxTries = 30, intervalMs = 3000 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    const status = await graphGet(
      `/${containerId}?fields=status_code,status&access_token=${token}`,
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`IG container ${containerId}: ${status.status}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`IG container ${containerId} not ready in time`);
}

/**
 * Post a carousel of photos to Instagram.
 * @param {string[]} photoUrls - public URLs (IG cannot read local files)
 * @param {string} caption - includes hashtags inline
 */
export async function postInstagramCarousel(photoUrls, caption) {
  const { igBusinessAccountId, pageAccessToken } = config.meta;
  if (!igBusinessAccountId || !pageAccessToken) {
    throw new Error("META_IG_BUSINESS_ACCOUNT_ID/META_PAGE_ACCESS_TOKEN not set");
  }

  if (config.dryRun) {
    console.log("[DRY] IG carousel:", { photoUrls, caption });
    return { id: "dry-run" };
  }

  // 1) Create child containers for each photo
  const childIds = [];
  for (const url of photoUrls) {
    const child = await graphPost(`/${igBusinessAccountId}/media`, {
      image_url: url,
      is_carousel_item: true,
      access_token: pageAccessToken,
    });
    childIds.push(child.id);
  }

  // 2) Create the carousel container
  const carousel = await graphPost(`/${igBusinessAccountId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
    access_token: pageAccessToken,
  });

  await waitForContainerReady(carousel.id, pageAccessToken);

  // 3) Publish
  return graphPost(`/${igBusinessAccountId}/media_publish`, {
    creation_id: carousel.id,
    access_token: pageAccessToken,
  });
}

/**
 * Post a Reel (vertical video) to Instagram.
 * @param {string} videoUrl - public URL to mp4
 * @param {string} caption
 */
export async function postInstagramReel(videoUrl, caption) {
  const { igBusinessAccountId, pageAccessToken } = config.meta;
  if (!igBusinessAccountId || !pageAccessToken) {
    throw new Error("META_IG_BUSINESS_ACCOUNT_ID/META_PAGE_ACCESS_TOKEN not set");
  }
  if (config.dryRun) {
    console.log("[DRY] IG reel:", { videoUrl, caption });
    return { id: "dry-run" };
  }

  const container = await graphPost(`/${igBusinessAccountId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: true,
    access_token: pageAccessToken,
  });
  await waitForContainerReady(container.id, pageAccessToken, { intervalMs: 5000 });
  return graphPost(`/${igBusinessAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: pageAccessToken,
  });
}
