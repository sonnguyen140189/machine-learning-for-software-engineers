import { config } from "../config.js";
import { withTransientRetry } from "../util/graphRetry.js";

const GRAPH = "https://graph.facebook.com/v21.0";

async function graphPostRaw(path, body) {
  const url = `${GRAPH}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Graph API ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function graphPost(path, body) {
  return withTransientRetry(() => graphPostRaw(path, body), { label: `FB ${path}` });
}

/**
 * Post a multi-photo album to a Facebook Page.
 * @param {string[]} photoUrls - publicly accessible image URLs
 * @param {string} message - main caption
 * @param {string} firstComment - optional first comment (e.g. hashtags)
 */
export async function postFacebookCarousel(photoUrls, message, firstComment) {
  const { pageId, pageAccessToken } = config.meta;
  if (!pageId || !pageAccessToken) throw new Error("META_PAGE_ID/META_PAGE_ACCESS_TOKEN not set");

  if (config.dryRun) {
    console.log("[DRY] FB carousel:", { photoUrls, message, firstComment });
    return { id: "dry-run" };
  }

  // 1) Upload each photo unpublished, get media_fbid
  const mediaIds = [];
  for (const url of photoUrls) {
    const r = await graphPost(`/${pageId}/photos`, {
      url,
      published: false,
      access_token: pageAccessToken,
    });
    mediaIds.push({ media_fbid: r.id });
  }

  // 2) Create a feed post that attaches all of them
  const post = await graphPost(`/${pageId}/feed`, {
    message,
    attached_media: mediaIds,
    access_token: pageAccessToken,
  });

  // 3) Optional first comment with hashtags
  if (firstComment) {
    await graphPost(`/${post.id}/comments`, {
      message: firstComment,
      access_token: pageAccessToken,
    });
  }
  return post;
}

export async function postFacebookVideo(videoUrl, message) {
  const { pageId, pageAccessToken } = config.meta;
  if (!pageId || !pageAccessToken) throw new Error("META_PAGE_ID/META_PAGE_ACCESS_TOKEN not set");

  if (config.dryRun) {
    console.log("[DRY] FB video:", { videoUrl, message });
    return { id: "dry-run" };
  }
  return graphPost(`/${pageId}/videos`, {
    file_url: videoUrl,
    description: message,
    access_token: pageAccessToken,
  });
}
