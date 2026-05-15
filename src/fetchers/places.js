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

// Vietnamese-language place-type prefixes (temple, market, shrine, mausoleum,
// communal house, mountain, beach, etc). If the name STARTS with any of these,
// the place is locally named and unlikely to read well in an English caption.
const VN_PREFIXES = [
  "Chợ", "Cho ",
  "Đền", "Den ",
  "Đình", "Dinh ",
  "Lăng", "Lang ",
  "Chùa", "Chua ",
  "Miếu", "Mieu ",
  "Núi", "Nui ",
  "Bãi ", "Bai ",
  "Hòn ", "Hon ",
  "Vườn", "Vuon ",
  "Suối", "Suoi ",
];

// Audience is foreign tourists. Reject names that are mostly Vietnamese
// (more than 8% non-ASCII characters) or that start with a Vietnamese
// place-type prefix.
function hasEnglishName(place) {
  const name = place.displayName?.text || "";
  if (!name) return false;
  if (VN_PREFIXES.some((p) => name.startsWith(p))) return false;
  const nonAscii = name.replace(/[\x20-\x7E]/g, "");
  return nonAscii.length / name.length < 0.08;
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
