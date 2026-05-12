import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { getPhotoUrl } from "./places.js";

const MEDIA_DIR = "out/media";

async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return filePath;
}

export async function fetchUnsplash(query, count = 6) {
  if (!config.unsplashAccessKey) return [];
  const url =
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
    `&per_page=${count}&orientation=portrait`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${config.unsplashAccessKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => ({
    source: "unsplash",
    url: r.urls.regular,
    credit: `Photo by ${r.user.name} on Unsplash`,
    creditUrl: r.user.links.html,
  }));
}

export async function fetchPexels(query, count = 6) {
  if (!config.pexelsApiKey) return [];
  const url =
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
    `&per_page=${count}&orientation=portrait`;
  const res = await fetch(url, {
    headers: { Authorization: config.pexelsApiKey },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.photos || []).map((p) => ({
    source: "pexels",
    url: p.src.large2x,
    credit: `Photo by ${p.photographer} on Pexels`,
    creditUrl: p.photographer_url,
  }));
}

async function fetchGooglePlacePhotos(place, count = 6) {
  if (!place.photos?.length) return [];
  const slice = place.photos.slice(0, count);
  const out = [];
  for (const p of slice) {
    const url = await getPhotoUrl(p.name, 1600);
    if (url) {
      out.push({
        source: "google_places",
        url,
        credit: p.authorAttributions?.[0]?.displayName
          ? `Photo: ${p.authorAttributions[0].displayName} (via Google)`
          : "Photo via Google",
      });
    }
  }
  return out;
}

export async function gatherPhotosForPlace(place, { count = 8 } = {}) {
  const placeName = place.displayName?.text || "Phu Quoc";
  const fromGoogle = await fetchGooglePlacePhotos(place, count);
  if (fromGoogle.length >= count) return fromGoogle.slice(0, count);

  // Fill remaining slots from stock photo sources
  const needed = count - fromGoogle.length;
  const query = `${placeName} Phu Quoc Vietnam`;
  const [unsplash, pexels] = await Promise.all([
    fetchUnsplash(query, Math.ceil(needed / 2)),
    fetchPexels(query, Math.ceil(needed / 2)),
  ]);
  return [...fromGoogle, ...unsplash, ...pexels].slice(0, count);
}

export async function downloadPhotos(photos, prefix) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const downloaded = [];
  for (let i = 0; i < photos.length; i++) {
    const filePath = join(MEDIA_DIR, `${prefix}-${i}.jpg`);
    try {
      await downloadTo(photos[i].url, filePath);
      downloaded.push({ ...photos[i], localPath: filePath });
    } catch (err) {
      console.warn(`Skipping photo ${i}: ${err.message}`);
    }
  }
  return downloaded;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const photos = await fetchUnsplash("Phu Quoc beach", 3);
  console.log(JSON.stringify(photos, null, 2));
}
