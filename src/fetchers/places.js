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

// Reject places whose display name is mostly non-ASCII (i.e. Vietnamese-only
// names like "Chợ đêm Phú Quốc"). Audience is foreign tourists reading English.
// Hybrid names like "Vinpearl Resort & Spa Phú Quốc" still pass because the
// Vietnamese fragment is a small share of the total.
function hasEnglishName(place) {
  const name = place.displayName?.text || "";
  if (!name) return false;
  const nonAscii = name.replace(/[\x20-\x7E]/g, "");
  return nonAscii.length / name.length < 0.25;
}

export async function fetchDailyCandidates({ count = 8 } = {}) {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  const places = await searchPhuQuocPlaces({ query, max: count * 4 });
  return places
    .filter((p) => (p.rating || 0) >= 4.0 && (p.userRatingCount || 0) >= 30)
    .filter(hasEnglishName)
    .slice(0, count);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const places = await fetchDailyCandidates({ count: 5 });
  console.log(JSON.stringify(places, null, 2));
}
