import "dotenv/config";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY,
  pexelsApiKey: process.env.PEXELS_API_KEY,
  meta: {
    pageId: process.env.META_PAGE_ID,
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN,
    igBusinessAccountId: process.env.META_IG_BUSINESS_ACCOUNT_ID,
  },
  tiktok: {
    accessToken: process.env.TIKTOK_ACCESS_TOKEN,
    openId: process.env.TIKTOK_OPEN_ID,
  },
  publicMediaBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL,
  dryRun: process.env.DRY_RUN !== "false",
  timezone: process.env.TIMEZONE || "Asia/Ho_Chi_Minh",
  // Phu Quoc center coordinates
  phuQuoc: {
    lat: 10.2270,
    lng: 103.9602,
    radiusMeters: 25000,
  },
};

export function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
