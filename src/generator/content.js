import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const MODEL = "claude-sonnet-4-6";

// Map Google Places priceLevel enum to a human dollar-tier and rough VND
// expectation. Used by the SHOCK_PRICE hook archetype: the bot weaponizes
// "cheap for what you get" framing to drive comments/saves.
const PRICE_LEVEL_HINTS = {
  PRICE_LEVEL_FREE: { tier: "free", hint: "free entry" },
  PRICE_LEVEL_INEXPENSIVE: { tier: "$", hint: "under $10 a person" },
  PRICE_LEVEL_MODERATE: { tier: "$$", hint: "$15-30 a person" },
  PRICE_LEVEL_EXPENSIVE: { tier: "$$$", hint: "$40-80 a person" },
  PRICE_LEVEL_VERY_EXPENSIVE: { tier: "$$$$", hint: "$100+ a person" },
};

const SYSTEM_PROMPT = `You write social media captions for "Phu Quoc Tips", a daily-post travel page covering hotels, beaches, restaurants, and attractions in Phu Quoc, Vietnam. The audience is English-speaking foreign tourists planning a trip.

LANGUAGE
English for all sentences, hashtags, and on-screen text. ONLY exception: proper nouns — keep the place name, restaurant name, or local landmark name with Vietnamese diacritics exactly as supplied (e.g. "Dinh Cậu", "Bãi Trường", "Chợ đêm Phú Quốc"). Use "Phu Quoc" without diacritics when referring to the island in general English prose.

VOICE — 2026 social algorithm rewards this
Punchy. Pattern interrupt. Specific numbers over generic adjectives. Authentic over polished. Sentences can be fragments. Three short sentences beat one long one.

HOOK ARCHETYPES (video_script.hook + the opening line of every caption must match ONE of these — pick whichever the place data best supports)
1. SHOCK_PRICE — exploits the dollar gap. Examples: "$18 dinner? In PHU QUOC??" / "$45/night ocean view. Yes really." / "Under $10 for ALL of this." — Only use when price tier data is provided.
2. LOCALS_DONT_TELL — anti-tourist framing. Examples: "Locals don't post about this beach." / "Tourists keep walking past this." / "What the resort staff actually order."
3. NUMBER_REVEAL — pure data shock. Examples: "7,116 reviews can't be wrong." / "4.8 stars. Empty at 7am." / "1 of 12 spots locals actually rate."
4. EMOTIONAL_HIT — feeling-first, not place-first. Examples: "This place fixes burnout." / "Phu Quoc that doesn't feel touristy." / "I almost skipped this. Big mistake."
5. POV_REVEAL — first-person discovery. Examples: "POV: you found the good Bún Quậy." / "Walked past 3 times. Don't be me." / "Took a wrong turn. Found this."

BANNED (these get suppressed by the 2026 algorithm)
Phrases: "hidden gem", "stunning views", "must-visit", "paradise", "breathtaking", "nestled", "tucked away", "oasis", "experience the magic"
Hashtags: #wanderlust, #travelgram, #instatravel, #beautifuldestinations, #vacation, #explore (engagement down 60% YoY)
Polite question hooks: "Best café in Phu Quoc?", "Looking for the perfect beach?" (these are dead)
Em dashes (—): never. Use commas or periods.

CTA (use one per caption, rotate across the batch)
- "Save this for your Phu Quoc trip."
- "Share with someone planning Vietnam."
- "Tag your travel buddy."
- "Comment your favorite Phu Quoc [beach/spot/dish]."
- Implied — no CTA at all when the punchline already pulls the save.

GROUNDING
Do not invent ratings, prices, opening hours, or facts not provided. If a field is missing, omit it — don't fabricate.

SCHEMA — return strict JSON only, no prose before or after
{
  "hookArchetype": "SHOCK_PRICE" | "LOCALS_DONT_TELL" | "NUMBER_REVEAL" | "EMOTIONAL_HIT" | "POV_REVEAL",
  "facebook": {
    "caption": string (250-500 chars, photo carousel post. Open with chosen archetype. End with one CTA),
    "video_caption": string (160-320 chars, same-day Reel post. Different opening sentence from caption — fresh angle, action-first, what the VIEWER SEES),
    "first_comment": string (5-7 hashtags space-separated, e.g. "#PhuQuoc #PhuQuocBeaches #ThingsToDoPhuQuoc #VisitVietnam #TravelTips")
  },
  "instagram": {
    "caption": string (80-150 chars, photo carousel. First line is the hook — IG truncates after 125 chars in feed. End with one CTA),
    "video_caption": string (80-140 chars, Reel. Punchy, hook-first, different opener than the photo caption),
    "hashtags": string (7-10 hashtags space-separated. Mandatory mix: 3-4 niche-location like #PhuQuocFood #PhuQuocBeaches, 1-2 broad-intent like #TravelTips #VietnamTravel, 1-2 trend like #TravelReels #PhuQuocTips. NO banned tags above.)
  },
  "tiktok": { "caption": string (max 150 chars including 3-5 inline hashtags) },
  "video_script": {
    "hook": string (max 50 chars, on-screen text for first 2 seconds — MUST match chosen hookArchetype, never a polite question),
    "scenes": array of 3-6 strings (max 40 chars each — concrete visual descriptions, action verbs preferred),
    "cta": string (max 40 chars — pick from CTA library above)
  }
}

The photo caption and video_caption on the same surface appear back-to-back in the feed within minutes of each other. They MUST feel like two distinct posts: different opening sentence, different framing, different verbs. Do not paraphrase one into the other.`;

function formatRating(place) {
  if (!place.rating) return null;
  const stars = place.rating.toFixed(1);
  const count = place.userRatingCount ? place.userRatingCount.toLocaleString("en-US") : null;
  return count ? `${stars}★ (${count} reviews)` : `${stars}★`;
}

function formatPrice(place) {
  if (!place.priceLevel) return null;
  const meta = PRICE_LEVEL_HINTS[place.priceLevel];
  if (!meta) return null;
  return `${meta.tier} (${meta.hint})`;
}

function buildUserPrompt(place) {
  const name = place.displayName?.text || "Unknown";
  const address = place.formattedAddress || "Phu Quoc, Vietnam";
  const rating = formatRating(place) || "no rating yet";
  const price = formatPrice(place);
  const summary = place.editorialSummary?.text || "";
  const primaryType = (place.primaryType || place.types?.[0] || "place").replace(/_/g, " ");

  const facts = [
    `Place: ${name}`,
    `Type: ${primaryType}`,
    `Address: ${address}`,
    `Rating: ${rating}`,
  ];
  if (price) facts.push(`Price tier: ${price}`);
  facts.push(`Editorial summary: ${summary || "(none)"}`);

  // Seed an archetype rotation hint from the place id so a 12-place daily
  // batch spreads across all 5 archetypes instead of Claude defaulting to
  // NUMBER_REVEAL for every place that has a high rating. Claude is still
  // free to override when the data clearly fits something else (e.g. always
  // use SHOCK_PRICE when a price tier is provided and the place is a
  // restaurant/hotel), but the suggestion breaks the "safest hook" rut.
  const archetypes = ["SHOCK_PRICE", "LOCALS_DONT_TELL", "NUMBER_REVEAL", "EMOTIONAL_HIT", "POV_REVEAL"];
  const seed = (place.id || name).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const suggested = archetypes[seed % archetypes.length];

  return `Write the daily post pack for this place.

${facts.join("\n")}

Suggested hookArchetype for this place: ${suggested}.
Use it unless the data strongly fits a different archetype (SHOCK_PRICE needs a price tier; NUMBER_REVEAL needs a striking rating + review count; LOCALS_DONT_TELL works for off-tourist-trail spots; EMOTIONAL_HIT for sunset bars / quiet beaches / retreats; POV_REVEAL for discovery moments).

Strict on lengths — FB caption must end before 500 chars, IG caption before 150 chars. If you're overflowing, cut adjectives first.

Return JSON only.`;
}

// Belt-and-suspenders cleanup: even with the prompt telling Claude not to,
// em dashes slip through occasionally. Strip them post-generation so they
// never reach Facebook/Instagram. Recurses into nested strings (captions,
// scenes array) without disturbing structure.
function sanitize(value) {
  if (typeof value === "string") {
    return value.replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

export async function generateContent(place) {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(place) }],
  });
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
  }
  return sanitize(JSON.parse(text.slice(jsonStart, jsonEnd + 1)));
}

// CLI: sample 3 places across different types so you can eyeball that the
// 5 hook archetypes actually rotate.
if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = [
    {
      displayName: { text: "Sao Beach" },
      formattedAddress: "An Thoi, Phu Quoc",
      rating: 4.5,
      userRatingCount: 4200,
      primaryType: "beach",
      editorialSummary: { text: "White sand crescent beach on the southeast coast." },
    },
    {
      displayName: { text: "Bún Quậy Kiến Xây" },
      formattedAddress: "153 Đường Trần Hưng Đạo, Dương Đông, Phu Quoc",
      rating: 4.6,
      userRatingCount: 8210,
      primaryType: "restaurant",
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      editorialSummary: { text: "" },
    },
    {
      displayName: { text: "JW Marriott Phu Quoc Emerald Bay" },
      formattedAddress: "Khem Beach, An Thoi, Phu Quoc",
      rating: 4.8,
      userRatingCount: 6300,
      primaryType: "hotel",
      priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
      editorialSummary: { text: "Bill Bensley-designed resort on Khem Beach." },
    },
  ];
  for (const s of samples) {
    console.log(`\n=== ${s.displayName.text} ===`);
    console.log(JSON.stringify(await generateContent(s), null, 2));
  }
}
