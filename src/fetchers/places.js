import { config } from "../config.js";

const PLACE_TYPES = [
  "lodging",
  "tourist_attraction",
  "restaurant",
  "beach",
  "cafe",
  "natural_feature",
];

const SEARCH_QUERIES = [
  "best hotels Phu Quoc",
  "top beaches Phu Quoc",
  "best restaurants Phu Quoc",
  "must visit places Phu Quoc",
  "luxury resorts Phu Quoc",
  "cafes Phu Quoc",
  "night market Phu Quoc",
  "snorkeling Phu Quoc",
];

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.editorialSummary",
  "places.primaryType",
  "places.types",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.priceLevel",
  "places.photos",
].join(",");

export async function searchPhuQuocPlaces({ query, max = 10 }) {
  if (!config.googlePlacesApiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY not set");
  }
  const res = await fetch(TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googlePlacesApiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: {
          center: {
            latitude: config.phuQuoc.lat,
            longitude: config.phuQuoc.lng,
          },
          radius: config.phuQuoc.radiusMeters,
        },
      },
      maxResultCount: max,
      languageCode: "en",
    }),
  });
  if (!res.ok) {
    throw new Error(`Places search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.places || [];
}

export async function getPhotoUrl(photoName, maxWidthPx = 1600) {
  // Photo `name` looks like "places/XXX/photos/YYY"
  const url =
    `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxWidthPx=${maxWidthPx}&key=${config.googlePlacesApiKey}&skipHttpRedirect=true`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.photoUri || null;
}

// Audience is foreign tourists but local proper nouns are allowed in place /
// restaurant names per the page owner's instruction. Captions are still
// authored in English by the Claude prompt — we only relax the name filter.
function hasUsableName(place) {
  return Boolean(place.displayName?.text);
}

export async function fetchDailyCandidates({ count = 8, excludeIds = new Set() } = {}) {
  // Pull from MULTIPLE search queries so a single noisy query (e.g. only
  // surfaces local-named night markets) doesn't starve a large batch.
  // Caller passes excludeIds so we keep iterating queries until we collect
  // enough FRESH candidates instead of returning a pool that's already
  // entirely covered by state.postedPlaceIds (which would silently produce
  // 0 posts for a small ad-hoc run).
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const queries = [...SEARCH_QUERIES].sort(() => Math.random() - 0.5);
  const seen = new Set();
  const collected = [];
  const targetFresh = count * 2; // 2× buffer so the rating/name filters can prune
  for (const query of queries) {
    const batch = await searchPhuQuocPlaces({ query, max: 20 });
    for (const p of batch) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      collected.push(p);
    }
    const fresh = collected.filter((p) => !exclude.has(p.id));
    if (fresh.length >= targetFresh) break;
  }
  return collected
    .filter((p) => !exclude.has(p.id))
    .filter((p) => (p.rating || 0) >= 4.0 && (p.userRatingCount || 0) >= 30)
    .filter(hasUsableName)
    .slice(0, count);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const places = await fetchDailyCandidates({ count: 5 });
  console.log(JSON.stringify(places, null, 2));
}
