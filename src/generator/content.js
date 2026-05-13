import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You write social media captions for a travel page that reviews hotels, beaches, restaurants, and attractions in Phu Quoc, Vietnam. The audience is English-speaking foreign tourists planning a trip.

Language: English only. Always write "Phu Quoc" (no diacritics) even if the input place name uses "Phú Quốc". Do not include Vietnamese words or phrases anywhere in captions, hashtags, video script, or hook text. If a place name contains Vietnamese characters, transliterate to plain ASCII or use a common English rendering.

Voice: warm, informative, slightly playful. No clickbait. No hashtag spam. Avoid em dashes; use commas or periods.

Always return strict JSON matching this schema:
{
  "facebook": { "caption": string (250-500 chars), "first_comment": string with 5-8 hashtags },
  "instagram": { "caption": string (150-280 chars), "hashtags": string with 12-18 hashtags },
  "tiktok": { "caption": string (max 150 chars including hashtags, 3-5 hashtags inline) },
  "video_script": { "hook": string (max 50 chars, on-screen text for first 2 seconds), "scenes": [3-6 short on-screen captions, max 40 chars each], "cta": string (max 40 chars) }
}

Do not invent ratings, prices, or facts not provided. Stay grounded in the place data.`;

function buildUserPrompt(place) {
  const name = place.displayName?.text || "Unknown";
  const address = place.formattedAddress || "Phu Quoc, Vietnam";
  const rating = place.rating ? `${place.rating}/5 (${place.userRatingCount} reviews)` : "no rating yet";
  const summary = place.editorialSummary?.text || "";
  const primaryType = (place.primaryType || place.types?.[0] || "place").replace(/_/g, " ");

  return `Write content for today's daily review post.

Place: ${name}
Type: ${primaryType}
Address: ${address}
Rating: ${rating}
Editorial summary: ${summary || "(none)"}

Highlight what makes this place special for a foreign visitor to Phu Quoc. Mention what to expect, best time to visit if obvious, and one practical tip. Return JSON only.`;
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
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = {
    displayName: { text: "Sao Beach" },
    formattedAddress: "An Thoi, Phu Quoc",
    rating: 4.5,
    userRatingCount: 4200,
    primaryType: "beach",
    editorialSummary: { text: "White sand crescent beach on the southeast coast." },
  };
  console.log(JSON.stringify(await generateContent(sample), null, 2));
}
