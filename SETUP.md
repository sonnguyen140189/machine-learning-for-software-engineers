# Phu Quoc Review Bot — Setup Guide

Daily automated hotel & places reviews for **Facebook Page**, **Instagram Business**, and **TikTok**. Targeted at foreign tourists (English content).

Runs on **GitHub Actions** on a daily cron. No server needed.

---

## How it works

```
fetchDailyCandidates()   → Google Places (Phu Quoc, rating ≥ 4.0)
gatherPhotosForPlace()   → Google Place Photos + Unsplash/Pexels fallback
generateContent()        → Claude API → captions + hashtags + video script
buildSlideshowVideo()    → ffmpeg → 1080x1920 vertical mp4 with on-screen text
postFacebookCarousel()   → Meta Graph API
postInstagramCarousel()  + postInstagramReel()
postTikTokVideo()        → TikTok Content Posting API
saveState()              → out/state.json so we never repost the same place
```

---

## One-time manual setup

You **must** do these yourself — they require human ID/phone verification.

### 1. Create the social accounts
- **Facebook Page** — facebook.com → Create → Page (category: Travel & transportation).
- **Instagram Business** — create an IG account in the app, switch to **Professional → Business**, then in Settings → "Linked accounts" link it to the Facebook Page above.
- **TikTok** — create the account in the TikTok app.

### 2. Meta (Facebook + Instagram) API
1. Go to https://developers.facebook.com → My Apps → **Create App** → "Business".
2. Add products: **Facebook Login for Business** + **Instagram Graph API**.
3. Grab a **long-lived Page access token** with scopes: `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`. Use the Graph API Explorer + the token debugger to extend it to 60 days, then exchange for a never-expiring Page token.
4. Get:
   - `META_PAGE_ID` — Graph API Explorer: `GET /me/accounts`
   - `META_PAGE_ACCESS_TOKEN` — the long-lived token from step 3
   - `META_IG_BUSINESS_ACCOUNT_ID` — `GET /{page-id}?fields=instagram_business_account`

### 3. TikTok Content Posting API
1. https://developers.tiktok.com → register your app.
2. Request the **`video.publish`** scope. **App review is required** before public posting works; until then you can only post to your sandbox/unaudited accounts.
3. Run the OAuth flow to obtain `TIKTOK_ACCESS_TOKEN` and `TIKTOK_OPEN_ID`. Refresh tokens are valid 365 days.
4. For the `PULL_FROM_URL` mode used in `src/posters/tiktok.js`, the public video URL host must be **verified** in your TikTok developer console (Domain verification).

### 4. Other API keys
- **Anthropic** — https://console.anthropic.com → API keys → `ANTHROPIC_API_KEY`
- **Google Places (new)** — Google Cloud Console → enable **Places API (New)** → create API key → `GOOGLE_PLACES_API_KEY`
- **Unsplash** — https://unsplash.com/developers → `UNSPLASH_ACCESS_KEY`
- **Pexels** — https://www.pexels.com/api/ → `PEXELS_API_KEY`

### 5. Public media host (required for IG + TikTok)
Instagram and TikTok cannot read local files — they fetch from a public URL.

**Easiest option: GitHub Pages of this repo.**
1. Repo Settings → **Pages** → Source: `Deploy from a branch` → branch `main` (or your default) → folder `/ (root)`.
2. After first run, media will live at `out/media/`. Your public base URL becomes:
   `https://<your-github-username>.github.io/<repo-name>/out/media`
3. Set this as the GitHub Actions **variable** (not secret) `PUBLIC_MEDIA_BASE_URL`.

Alternatives: Cloudflare R2 + custom domain, AWS S3 + CloudFront, Supabase Storage. The pipeline only needs `PUBLIC_MEDIA_BASE_URL` to point at where `out/media/<filename>` ends up reachable.

⚠️ TikTok's `PULL_FROM_URL` requires the host domain to be **verified** in your TikTok developer console.

---

## Configure GitHub Actions

Repo → **Settings → Secrets and variables → Actions**.

### Secrets (encrypted)
```
ANTHROPIC_API_KEY
GOOGLE_PLACES_API_KEY
UNSPLASH_ACCESS_KEY
PEXELS_API_KEY
META_PAGE_ID
META_PAGE_ACCESS_TOKEN
META_IG_BUSINESS_ACCOUNT_ID
TIKTOK_ACCESS_TOKEN
TIKTOK_OPEN_ID
```

### Variables (plaintext)
```
PUBLIC_MEDIA_BASE_URL=https://<user>.github.io/<repo>/out/media
```

The workflow `.github/workflows/daily-post.yml` runs daily at **02:00 UTC (09:00 Vietnam time)**. To change the time, edit the `cron:` line.

---

## Local development

```bash
cp .env.example .env
# fill in keys; keep DRY_RUN=true while testing
npm install
sudo apt-get install ffmpeg   # macOS: brew install ffmpeg

# Test individual stages
node src/fetchers/places.js
node src/fetchers/photos.js
node src/generator/content.js
node src/video/build.js       # generates a 2-frame test video

# Full pipeline (DRY_RUN=true → builds media, prints what would be posted)
npm run daily
```

Generated artifacts land in `out/`:
- `out/content-YYYY-MM-DD.json` — captions
- `out/media/YYYY-MM-DD-*.jpg` — downloaded photos
- `out/media/YYYY-MM-DD.mp4` — assembled video
- `out/state.json` — posted-place memory, prevents repeats

---

## Triggering manually

GitHub → Actions → **Daily Phu Quoc Post** → Run workflow. Set `dry_run: true` to test end-to-end without publishing.

---

## Compliance notes

- Captions are generated, but they're grounded in real Google Places data — no fabricated facts.
- Google Place Photos are surfaced via the official API and credit the original photographer in metadata. If you re-host them outside Google's URLs (as we do for IG/TikTok), Google's attribution requirement still applies — the bot stores attribution in `out/content-*.json`; consider appending it to the first comment if you want to be conservative.
- Unsplash + Pexels images allow commercial use; the bot keeps credit strings on each photo for transparency.
- Don't scrape TripAdvisor / Booking.com — both prohibit it and will IP-block. Use Google Places.
