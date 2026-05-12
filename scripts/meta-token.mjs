#!/usr/bin/env node
// Exchange a short-lived Meta USER access token for the 3 values the bot needs.
//
// Prerequisites (do these in Meta dev console first):
//   1. Create a Business-type app at developers.facebook.com → My Apps
//   2. Add products: Facebook Login for Business + Instagram Graph API
//   3. In Graph API Explorer, select your app, "Get User Access Token" with scopes:
//        pages_manage_posts, pages_read_engagement,
//        instagram_basic, instagram_content_publish, business_management
//      Copy the short-lived USER token shown.
//   4. From dev console → Settings → Basic: copy App ID and App Secret.
//
// Usage:
//   META_APP_ID=... META_APP_SECRET=... META_SHORT_TOKEN=... \
//     node scripts/meta-token.mjs
//
// Output: prints META_PAGE_ID, META_PAGE_ACCESS_TOKEN, META_IG_BUSINESS_ACCOUNT_ID
// ready to paste into GitHub Actions secrets (or .env for local dry-run).

const API = 'https://graph.facebook.com/v21.0';

const { META_APP_ID, META_APP_SECRET, META_SHORT_TOKEN } = process.env;
if (!META_APP_ID || !META_APP_SECRET || !META_SHORT_TOKEN) {
  console.error('Missing env: META_APP_ID, META_APP_SECRET, META_SHORT_TOKEN required');
  process.exit(1);
}

async function api(path, params) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`${path}: ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

// Step 1 — short-lived USER → long-lived USER (~60 days)
const longLived = await api('/oauth/access_token', {
  grant_type: 'fb_exchange_token',
  client_id: META_APP_ID,
  client_secret: META_APP_SECRET,
  fb_exchange_token: META_SHORT_TOKEN,
});
const longLivedUserToken = longLived.access_token;

// Step 2 — list pages. Page tokens from a long-lived user token do not expire.
const pages = await api('/me/accounts', { access_token: longLivedUserToken });
if (!pages.data || pages.data.length === 0) {
  throw new Error('No pages found for this user. Did you grant pages_manage_posts scope?');
}

const phuquocPage = pages.data.find((p) =>
  (p.username || '').toLowerCase() === 'phuquoctips' ||
  (p.name || '').toLowerCase().includes('phu quoc tips')
) || pages.data[0];

const pageId = phuquocPage.id;
const pageToken = phuquocPage.access_token;

// Step 3 — IG Business Account id linked to this page
const igLink = await api(`/${pageId}`, {
  fields: 'instagram_business_account',
  access_token: pageToken,
});
if (!igLink.instagram_business_account) {
  throw new Error(
    `Page ${pageId} has no linked IG Business account. ` +
    `Link IG → FB in the IG app first (Settings → Linked accounts → Facebook).`
  );
}
const igBusinessId = igLink.instagram_business_account.id;

console.log('\n=== Paste these into GitHub Actions secrets (or .env) ===\n');
console.log(`META_PAGE_ID=${pageId}`);
console.log(`META_PAGE_ACCESS_TOKEN=${pageToken}`);
console.log(`META_IG_BUSINESS_ACCOUNT_ID=${igBusinessId}`);
console.log(`\nPage matched: ${phuquocPage.name} (@${phuquocPage.username || 'no-username'})`);
