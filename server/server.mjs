import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Busboy from "busboy";
import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  cloudDatabaseEnabledFor,
  cloudDatabaseStatus,
  deleteCloudCapturesByIds,
  readCloudRecentCaptures,
  readCloudVault,
  upsertCloudCapture,
  writeCloudVault,
} from "./cloudDatabase.mjs";

const root = resolve(process.cwd());
const envFile = join(root, ".env");

if (existsSync(envFile)) {
  const envText = readFileSync(envFile, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const distDir = join(root, "dist");
const dataDir = join(root, "server", "data");
const brainFile = join(dataDir, "brain.json");
const sqliteFile = join(dataDir, "nube.sqlite");
const authFile = join(dataDir, "auth.json");
const publicDir = join(root, "public");
const avatarDir = join(publicDir, "uploads", "avatars");
const port = Number(process.env.PORT ?? 8787);
const appUrl = (process.env.APP_URL ?? `http://127.0.0.1:${process.env.VITE_PORT ?? 5174}`).replace(/\/$/, "");
const appOrigin = new URL(appUrl).origin;
const allowedOrigins = new Set([
  appOrigin,
  `http://127.0.0.1:${process.env.VITE_PORT ?? 5174}`,
  `http://localhost:${process.env.VITE_PORT ?? 5174}`,
  ...(process.env.NUBE_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean),
]);
const secureCookies = process.env.NUBE_SECURE_COOKIES === "true" || appOrigin.startsWith("https://");
const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PERSONAL_PRICE_ID && process.env.STRIPE_PRO_PRICE_ID);
const emailForwardingAddress = process.env.NUBE_INBOUND_EMAIL_ADDRESS || (process.env.NUBE_PUBLIC_DOMAIN ? `inbox@${process.env.NUBE_PUBLIC_DOMAIN}` : "");
const emailForwardingReady = () => Boolean(emailForwardingAddress && process.env.NUBE_INBOUND_EMAIL_SECRET);
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? `${appUrl}/api/auth/google/callback`;
const googleScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");
const aiProvider = (process.env.AI_PROVIDER ?? (process.env.GEMINI_API_KEY ? "google" : process.env.OPENROUTER_API_KEY ? "openrouter" : "openai")).toLowerCase();
const model = process.env.AI_MODEL ?? process.env.OPENAI_MODEL ?? (aiProvider === "google" ? "gemini-2.0-flash-lite" : aiProvider === "openrouter" ? "google/gemini-2.5-flash" : "gpt-4o-mini");
const maxUploadBytes = 12 * 1024 * 1024;
const maxJsonBytes = Number(process.env.NUBE_MAX_JSON_BYTES ?? 1_500_000);
const maxCaptureChars = Number(process.env.NUBE_MAX_CAPTURE_CHARS ?? 4000);
const maxAiFileChars = Number(process.env.NUBE_MAX_AI_FILE_CHARS ?? 6000);
const maxStoredExtractedChars = Number(process.env.NUBE_MAX_STORED_EXTRACTED_CHARS ?? 20000);
const allowedUploadExtensions = new Set([".pdf", ".txt", ".md", ".json", ".csv", ".log", ".png", ".jpg", ".jpeg", ".webp"]);
const allowedUploadMimePrefixes = ["text/", "image/"];
const allowedUploadMimeTypes = new Set(["application/pdf", "application/json"]);
const blockedUploadExtensions = new Set([".exe", ".bat", ".cmd", ".com", ".scr", ".ps1", ".msi", ".vbs", ".js", ".mjs", ".cjs", ".jar", ".app", ".dmg"]);
const rateBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(key);
  }
}, 60_000).unref?.();
const r2Bucket = process.env.R2_BUCKET_NAME;
const r2PublicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
const objectStorageProvider = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && r2Bucket ? "cloudflare-r2" : "local";
const r2Client = objectStorageProvider === "cloudflare-r2"
  ? new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;
let db;

const hasAiKey = () => {
  if (aiProvider === "google" || aiProvider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  if (aiProvider === "openrouter") return Boolean(process.env.OPENROUTER_API_KEY);
  if (aiProvider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return false;
};

const releaseReadiness = () => {
  const appUrlIsHttps = appUrl.startsWith("https://");
  const productionOrigins = Array.from(allowedOrigins).filter((origin) => !/localhost|127\.0\.0\.1/i.test(origin));
  const checks = [
    { id: "https", label: "HTTPS app URL", ok: appUrlIsHttps, detail: appUrlIsHttps ? appUrl : "Set APP_URL to the production HTTPS domain." },
    { id: "cookies", label: "Secure cookies", ok: secureCookies, detail: secureCookies ? "Secure cookies are enabled." : "Set NUBE_SECURE_COOKIES=true for production." },
    { id: "origins", label: "Production CORS origins", ok: productionOrigins.length > 0, detail: productionOrigins.length ? productionOrigins.join(", ") : "Add the production domain to NUBE_ALLOWED_ORIGINS." },
    { id: "oauth", label: "Google OAuth", ok: googleAuthConfigured(), detail: googleAuthConfigured() ? googleRedirectUri : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." },
    { id: "ai", label: "AI provider", ok: hasAiKey(), detail: hasAiKey() ? `${aiProvider} · ${model}` : "Set GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY." },
    { id: "maps", label: "Google Places", ok: Boolean(process.env.GOOGLE_MAPS_API_KEY), detail: process.env.GOOGLE_MAPS_API_KEY ? "Place enrichment is ready." : "Set GOOGLE_MAPS_API_KEY for real place cards." },
    { id: "r2", label: "Private file storage", ok: objectStorageProvider === "cloudflare-r2", detail: objectStorageProvider === "cloudflare-r2" ? "Cloudflare R2 is configured." : "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME." },
    { id: "database", label: "Multi-device database", ok: Boolean(process.env.NUBE_CLOUD_DATABASE_URL), detail: process.env.NUBE_CLOUD_DATABASE_URL ? "Cloud database is configured." : "Set NUBE_CLOUD_DATABASE_URL before expecting cross-device sync." },
    { id: "email", label: "Email forwarding", ok: emailForwardingReady(), detail: emailForwardingReady() ? emailForwardingAddress : "Set NUBE_PUBLIC_DOMAIN or NUBE_INBOUND_EMAIL_ADDRESS plus NUBE_INBOUND_EMAIL_SECRET." },
  ];
  const ready = checks.filter((check) => check.ok).length;
  return {
    ready,
    total: checks.length,
    productionReady: ready === checks.length,
    checks,
  };
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const inferDueLocally = (text) => {
  const value = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const target = new Date();
  target.setHours(/\b(morning|mattina)\b/.test(value) ? 9 : /\b(afternoon|pomeriggio)\b/.test(value) ? 15 : /\b(evening|sera|tonight|stasera)\b/.test(value) ? 20 : 12, 0, 0, 0);
  if (/\b(today|oggi)\b/.test(value)) return target.toISOString();
  if (/\b(tomorrow|domani)\b/.test(value)) {
    target.setDate(target.getDate() + 1);
    return target.toISOString();
  }
  const weekdays = { sunday: 0, domenica: 0, monday: 1, lunedi: 1, tuesday: 2, martedi: 2, wednesday: 3, mercoledi: 3, thursday: 4, giovedi: 4, friday: 5, venerdi: 5, saturday: 6, sabato: 6 };
  const weekday = Object.entries(weekdays).find(([label]) => new RegExp(`\\b${label}\\b`, "i").test(value));
  if (weekday) {
    const delta = (weekday[1] - target.getDay() + 7) % 7 || 7;
    target.setDate(target.getDate() + delta);
    return target.toISOString();
  }
  return null;
};

const classifyLocally = (text) => {
  const value = text.toLowerCase();
  let type = "Idea";
  const due = inferDueLocally(text);
  if (due || value.includes("call") || value.includes("send") || value.includes("deadline") || value.includes("todo") || value.includes("task") || value.includes("remind") || value.includes("chiamare") || value.includes("ricordami") || value.includes("andare") || value.includes("fare") || value.includes("comprare") || value.includes("pagare") || value.includes("portare") || value.includes("prenotare")) type = "Actionable";
  else if (value.includes("pay") || value.includes("eur") || value.includes("receipt") || value.includes("$") || value.includes("spent")) type = "Expense";
  else if (value.includes("http") || value.includes("www.") || value.includes("youtube") || value.includes("video")) type = "Link";
  else if (value.includes("tired") || value.includes("sleep") || value.includes("energy") || value.includes("health") || value.includes("stanco")) type = "Health";
  else if (value.includes("journal") || value.includes("diary") || value.includes("felt") || value.includes("mood") || value.includes("today i")) type = "Journal";
  else if (value.includes("study") || value.includes("course") || value.includes("lesson") || value.includes("exam")) type = "Study";
  else if (value.includes("client") || value.includes("contract") || value.includes("meeting") || value.includes("work")) type = "Work";
  else if (value.includes("home") || value.includes("house") || value.includes("laundry") || value.includes("detergent") || value.includes("milk")) type = "Home";
  else if (value.includes("trip") || value.includes("flight") || value.includes("hotel") || value.includes("travel")) type = "Travel";
  else if (value.includes("marco") || value.includes("luca") || value.includes("giulia")) type = "Person";
  else if (value.includes("restaurant") || value.includes("ristorante") || value.includes("osteria") || value.includes("trattoria") || value.includes("place") || value.includes("milan")) type = "Place";
  else if (value.includes("audio") || value.includes("voice note") || value.includes("recording") || value.includes("vocale") || value.includes("registrazione")) type = "Audio";
  else if (value.includes("pdf") || value.includes("doc") || value.includes("file")) type = "Document";

  const tags = new Set([type, "AI tagged"]);
  if (value.includes("marco")) tags.add("Marco");
  if (value.includes("luca")) tags.add("Luca");
  if (value.includes("giulia")) tags.add("Giulia");
  if (value.includes("milan") || value.includes("brera")) tags.add("Milan");
  if (value.includes("restaurant") || value.includes("ristorante") || value.includes("osteria") || value.includes("trattoria")) tags.add("Restaurant");
  if (type === "Actionable") tags.add("Reminder suggested");
  if (type === "Expense") tags.add("Receipt extraction");
  if (type === "Document") tags.add("File indexed");
  if (type === "Health") tags.add("Energy");
  if (type === "Study") tags.add("Resource");
  if (type === "Work") tags.add("Work");
  if (type === "Home") tags.add("Home");
  if (type === "Travel") tags.add("Travel");
  if (type === "Journal") tags.add("Diary");
  if (type === "Link") tags.add("Saved link");
  if (tags.size < 3) tags.add("Auto organized");

  return {
    title: text.length > 52 ? `${text.slice(0, 52)}...` : text,
    summary: text,
    type,
    metadata: Array.from(tags),
    due: type === "Actionable" ? due : null,
    priority: value.includes("urgent") || value.includes("asap") || value.includes("importante") ? "High" : null,
    people: ["Marco", "Luca"].filter((name) => value.includes(name.toLowerCase())),
    places: value.includes("milan") ? ["Milan"] : [],
    suggestedAction: type === "Actionable" ? "Add this to Today" : "",
    confidence: 0.68,
    provider: "local-fallback",
  };
};

async function enrichPlace(query) {
  if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY is missing.");

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.rating,places.location,places.photos",
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 1,
      languageCode: "en",
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Places request failed: ${response.status} ${message}`);
  }

  const payload = await response.json();
  const place = payload.places?.[0];
  if (!place) throw new Error("No place found.");
  const photoName = place.photos?.[0]?.name ?? null;
  return {
    provider: "google-places",
    placeId: place.id,
    name: place.displayName?.text ?? query,
    address: place.formattedAddress ?? null,
    mapsUrl: place.googleMapsUri ?? null,
    rating: place.rating ?? null,
    location: place.location ?? null,
    photoUrl: photoName ? `/api/place/photo?name=${encodeURIComponent(photoName)}&maxWidthPx=900` : null,
  };
}

async function reverseLocation(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Invalid coordinates.");
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return {
      provider: "browser",
      city: "Current location",
      label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      latitude: lat,
      longitude: lng,
    };
  }
  const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  geocodeUrl.searchParams.set("latlng", `${lat},${lng}`);
  geocodeUrl.searchParams.set("key", process.env.GOOGLE_MAPS_API_KEY);
  const response = await fetch(geocodeUrl);
  if (!response.ok) throw new Error(`Google geocode failed: ${response.status}`);
  const payload = await response.json();
  const result = payload.results?.[0];
  const components = result?.address_components ?? [];
  const city = components.find((item) => item.types?.includes("locality"))?.long_name
    ?? components.find((item) => item.types?.includes("administrative_area_level_3"))?.long_name
    ?? components.find((item) => item.types?.includes("administrative_area_level_2"))?.long_name
    ?? "Current location";
  const country = components.find((item) => item.types?.includes("country"))?.long_name;
  return {
    provider: "google-maps",
    city,
    label: [city, country].filter(Boolean).join(", ") || result?.formatted_address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    formattedAddress: result?.formatted_address ?? null,
    latitude: lat,
    longitude: lng,
  };
}

const weatherCodeLabel = (code) => {
  if ([0].includes(code)) return "Clear";
  if ([1, 2].includes(code)) return "Partly cloudy";
  if ([3].includes(code)) return "Cloudy";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Storm";
  return "Weather";
};

async function currentWeather(lat, lng) {
  const latitude = Number.isFinite(lat) ? lat : 44.835;
  const longitude = Number.isFinite(lng) ? lng : 11.619;
  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.searchParams.set("latitude", String(latitude));
  weatherUrl.searchParams.set("longitude", String(longitude));
  weatherUrl.searchParams.set("current", "temperature_2m,weather_code");
  weatherUrl.searchParams.set("timezone", "auto");
  const response = await fetch(weatherUrl);
  if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
  const payload = await response.json();
  const temperature = Number(payload.current?.temperature_2m);
  const code = Number(payload.current?.weather_code);
  return {
    provider: "open-meteo",
    temperature: Number.isFinite(temperature) ? Math.round(temperature) : null,
    temperatureUnit: payload.current_units?.temperature_2m ?? "Â°C",
    condition: weatherCodeLabel(code),
    weatherCode: Number.isFinite(code) ? code : null,
    latitude,
    longitude,
  };
}

const limitText = (text, maxChars) => {
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated by Nube cost guard: ${text.length - maxChars} characters omitted.]`,
    truncated: true,
    originalLength: text.length,
  };
};

const classificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    type: { type: "string", enum: ["Actionable", "Idea", "Expense", "Place", "Document", "Audio", "Health", "Home", "Study", "Work", "Travel", "Person", "Journal", "Link"] },
    metadata: { type: "array", items: { type: "string" } },
    due: { type: ["string", "null"] },
    priority: { type: ["string", "null"], enum: ["Low", "Medium", "High", null] },
    people: { type: "array", items: { type: "string" } },
    places: { type: "array", items: { type: "string" } },
    suggestedAction: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["title", "summary", "type", "metadata", "due", "priority", "people", "places", "suggestedAction", "confidence"],
};

const aiSystemPrompt =
  "You classify personal knowledge captures for Nube, an AI-native personal inbox. Return concise, useful metadata. Preserve the user's original language for title, summary, people, places, and suggestedAction; never translate the capture content unless the user explicitly asks for translation. If the capture is a shopping list, packing list, checklist, or a set of things to remember, keep the summary structured and useful instead of flattening it into one vague sentence. Metadata tags may be short English product labels. If the capture says today/oggi, tomorrow/domani, or a weekday, return a concrete ISO due date string when possible; otherwise use null when the due date is unclear. Use null for priority unless the user clearly says urgent/high/medium/low/important. Return only valid JSON matching the requested schema.";

const parseModelJson = (value) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("AI response did not include text.");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return JSON.parse(fenced ?? text);
};

const usefulSuggestedAction = (action) => {
  const value = String(action ?? "").trim();
  if (!value) return "";
  if (/keep (this )?(organized|saved)|organized in the inbox|no action needed/i.test(value)) return "";
  return value;
};

const stripHtml = (value = "") => String(value)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/https?:\/\/[^\s<>"']{220,}/gi, "[long link removed]")
  .replace(/\s+/g, " ")
  .trim();

const sanitizePlainText = (value = "", maxChars = maxStoredExtractedChars) => limitText(String(value)
  .replace(/\u0000/g, "")
  .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
  .replace(/\s+\n/g, "\n")
  .replace(/[ \t]{2,}/g, " ")
  .trim(), maxChars).text;

const isAllowedUpload = (filename = "", mimeType = "") => {
  const extension = extname(filename).toLowerCase();
  if (blockedUploadExtensions.has(extension)) return false;
  if (allowedUploadExtensions.has(extension)) return true;
  if (allowedUploadMimeTypes.has(mimeType)) return true;
  return allowedUploadMimePrefixes.some((prefix) => mimeType.startsWith(prefix));
};

const captureTypes = new Set(classificationSchema.properties.type.enum);
const priorities = new Set(classificationSchema.properties.priority.enum);
const normalizeClassification = (parsed, fallbackText, provider) => {
  const local = classifyLocally(fallbackText);
  const parsedType = captureTypes.has(parsed?.type) ? parsed.type : local.type;
  const type = local.due && parsedType === "Idea" ? "Actionable" : parsedType;
  const priority = priorities.has(parsed?.priority) ? parsed.priority : local.priority ?? null;
  return {
    title: typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : local.title,
    summary: typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : local.summary,
    type,
    metadata: Array.isArray(parsed?.metadata) ? parsed.metadata.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()).slice(0, 8) : local.metadata,
    due: typeof parsed?.due === "string" && parsed.due.trim() ? parsed.due.trim() : local.due,
    priority,
    people: Array.isArray(parsed?.people) ? parsed.people.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 6) : local.people,
    places: Array.isArray(parsed?.places) ? parsed.places.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()).slice(0, 6) : local.places,
    suggestedAction: usefulSuggestedAction(typeof parsed?.suggestedAction === "string" ? parsed.suggestedAction : local.suggestedAction),
    confidence: typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : local.confidence,
    provider,
  };
};

const currentDateContext = () => new Date().toISOString().slice(0, 10);

async function classifyWithOpenAI(text, source) {
  if (!process.env.OPENAI_API_KEY) return classifyLocally(text);

  const limited = limitText(text, maxCaptureChars);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: aiSystemPrompt,
        },
        {
          role: "user",
          content: `Today: ${currentDateContext()}\nSource: ${source ?? "universal input"}\nCapture: ${limited.text}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "nube_capture_classification",
          strict: true,
          schema: classificationSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${message}`);
  }

  const payload = await response.json();
  const outputText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI response did not include output_text.");
  const parsed = normalizeClassification(JSON.parse(outputText), text, "openai");
  if (limited.truncated) parsed.warning = `Input limited to ${maxCaptureChars} characters from ${limited.originalLength}.`;
  return parsed;
}

async function classifyWithOpenRouter(text, source) {
  if (!process.env.OPENROUTER_API_KEY) return classifyLocally(text);

  const limited = limitText(text, maxCaptureChars);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://127.0.0.1:5174",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Nube",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: aiSystemPrompt },
        {
          role: "user",
          content: `Return this exact JSON shape with no markdown:\n${JSON.stringify(classificationSchema.properties, null, 2)}\n\nToday: ${currentDateContext()}\nSource: ${source ?? "universal input"}\nCapture: ${limited.text}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${message}`);
  }

  const payload = await response.json();
  const outputText = payload.choices?.[0]?.message?.content;
  const parsed = normalizeClassification(parseModelJson(outputText), text, "openrouter");
  if (limited.truncated) parsed.warning = `Input limited to ${maxCaptureChars} characters from ${limited.originalLength}.`;
  return parsed;
}

async function classifyWithGoogle(text, source) {
  if (!process.env.GEMINI_API_KEY) return classifyLocally(text);

  const limited = limitText(text, maxCaptureChars);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: aiSystemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Return this exact JSON shape with no markdown:\n${JSON.stringify(classificationSchema.properties, null, 2)}\n\nToday: ${currentDateContext()}\nSource: ${source ?? "universal input"}\nCapture: ${limited.text}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Gemini request failed: ${response.status} ${message}`);
  }

  const payload = await response.json();
  const outputText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  const parsed = normalizeClassification(parseModelJson(outputText), text, "google");
  if (limited.truncated) parsed.warning = `Input limited to ${maxCaptureChars} characters from ${limited.originalLength}.`;
  return parsed;
}

const localReviewFor = (captures = []) => {
  const openTasks = captures.filter((capture) => capture.type === "Actionable" && !capture.completed);
  const starred = captures.filter((capture) => capture.starred);
  const money = captures.filter((capture) => capture.type === "Expense" || capture.metadata?.some?.((tag) => String(tag).startsWith("Money ")));
  const recent = captures.slice(0, 5);
  return {
    headline: openTasks.length ? `${openTasks.length} open tasks need attention.` : "Your inbox is calm right now.",
    focus: openTasks[0]?.title ?? starred[0]?.title ?? recent[0]?.title ?? "Capture anything important when it appears.",
    nextActions: openTasks.slice(0, 3).map((capture) => capture.title),
    patterns: [
      `${captures.length} total captures`,
      `${starred.length} starred items`,
      `${money.length} money-related items`,
    ],
    risks: money.length ? ["Review unclear money items before they get buried."] : [],
    provider: "local-fallback",
  };
};

async function reviewWithAi(captures) {
  const compactCaptures = captures.slice(0, 40).map((capture) => ({
    title: capture.title,
    type: capture.type,
    text: String(capture.text ?? "").slice(0, 240),
    metadata: Array.isArray(capture.metadata) ? capture.metadata.slice(0, 8) : [],
    due: capture.due ?? null,
    priority: capture.priority ?? null,
    completed: Boolean(capture.completed),
    starred: Boolean(capture.starred),
  }));
  const prompt = `Analyze this personal inbox and return JSON only:
{
  "headline": "one short sentence",
  "focus": "the single most useful thing to focus on next",
  "nextActions": ["max 3 short actions"],
  "patterns": ["max 3 observed patterns"],
  "risks": ["max 2 things that may be forgotten"]
}

Captures:
${JSON.stringify(compactCaptures)}`;

  if (!hasAiKey()) return localReviewFor(captures);
  if (aiProvider !== "google" && aiProvider !== "gemini") return localReviewFor(captures);

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You write concise personal knowledge management reviews for Nube. Be practical, specific, and calm. Return valid JSON only." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Gemini review failed: ${response.status} ${message}`);
  }
  const payload = await response.json();
  const outputText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  const parsed = parseModelJson(outputText);
  const fallback = localReviewFor(captures);
  return {
    headline: typeof parsed.headline === "string" && parsed.headline.trim() ? parsed.headline.trim() : fallback.headline,
    focus: typeof parsed.focus === "string" && parsed.focus.trim() ? parsed.focus.trim() : fallback.focus,
    nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.filter((item) => typeof item === "string" && item.trim()).slice(0, 3) : fallback.nextActions,
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns.filter((item) => typeof item === "string" && item.trim()).slice(0, 3) : fallback.patterns,
    risks: Array.isArray(parsed.risks) ? parsed.risks.filter((item) => typeof item === "string" && item.trim()).slice(0, 2) : fallback.risks,
    provider: "google",
  };
}

const _legacyLocalAskNube = (question, captures = []) => {
  const words = String(question).toLowerCase().split(/[^a-z0-9àèéìòù]+/i).filter((word) => word.length > 2);
  const scored = captures
    .map((capture) => {
      const haystack = `${capture.title ?? ""} ${capture.text ?? ""} ${capture.type ?? ""} ${(capture.metadata ?? []).join(" ")} ${capture.place?.address ?? ""}`.toLowerCase();
      const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
      return { capture, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.capture);

  const matches = scored.length ? scored : captures.slice(0, 3);
  return {
    answer: matches.length
      ? `I found ${matches.length} relevant capture${matches.length === 1 ? "" : "s"}. The strongest match is "${matches[0].title}".`
      : "I do not have enough captures to answer that yet.",
    related: matches.map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
    provider: "local-fallback",
  };
};

const captureMoneySignals = (captures = []) => captures
  .map((capture) => {
    const text = `${capture.title ?? ""} ${capture.text ?? ""} ${(capture.metadata ?? []).join(" ")}`;
    const match = text.match(/([+-]?\s?\d+(?:[.,]\d{1,2})?)\s?(?:eur|euro|euros|€|usd|\$)/i);
    if (!match) return null;
    const amount = Math.abs(Number(match[1].replace(/\s/g, "").replace(",", ".")));
    if (!Number.isFinite(amount)) return null;
    const lower = text.toLowerCase();
    const isIncome = /(\+|received|income|paid me|rimborso|entrata|incass|guadagn)/i.test(lower);
    const isExpense = /(-|spent|expense|paid|bought|fuel|gas|speso|spesa|pagato|comprato|benzina)/i.test(lower) || capture.type === "Expense";
    return {
      id: capture.id,
      title: capture.title,
      type: capture.type,
      amount,
      direction: isIncome && !isExpense ? "income" : isExpense ? "expense" : "review",
    };
  })
  .filter(Boolean);

const localAskNube = (question, captures = []) => {
  const query = String(question).toLowerCase();
  const words = query.split(/[^a-z0-9àèéìòù]+/i).filter((word) => word.length > 2);
  const wantsMoney = /(money|spent|expense|expenses|income|eur|euro|€|soldi|quanto|speso|spese|entrate|uscite|benzina|fuel|gas)/i.test(query);
  const wantsPlace = /(place|places|restaurant|restaurants|maps|where|dove|posto|posti|ristorante|ristoranti|luogo|mappa)/i.test(query);
  const wantsSchedule = /(today|tomorrow|upcoming|due|reminder|schedule|oggi|domani|quando|promemoria|scadenza)/i.test(query);
  const wantsFiles = /(file|files|image|images|photo|photos|pdf|document|documents|attachment|allegat|foto|immagin)/i.test(query);
  const wantsTags = /(tag|tags|hashtag|label|labels|etichette|categoria|categorie)/i.test(query);
  const wantsPriority = /(priority|priorit|high|medium|low|urgente|alta|media|bassa)/i.test(query);
  const wantsStarred = /(star|starred|favorite|favourite|preferit|stella)/i.test(query);
  const wantsDone = /(done|completed|complete|finished|fatto|completat)/i.test(query);

  if (wantsMoney) {
    const signals = captureMoneySignals(captures);
    const expenses = signals.filter((signal) => signal.direction === "expense").reduce((sum, signal) => sum + signal.amount, 0);
    const income = signals.filter((signal) => signal.direction === "income").reduce((sum, signal) => sum + signal.amount, 0);
    const review = signals.filter((signal) => signal.direction === "review").length;
    return {
      answer: signals.length
        ? `I found ${signals.length} money signal${signals.length === 1 ? "" : "s"}: €${income.toFixed(2)} income, €${expenses.toFixed(2)} expenses${review ? `, and ${review} item${review === 1 ? "" : "s"} to review` : ""}.`
        : "I do not see any money signals in your captures yet.",
      related: signals.slice(0, 5).map((signal) => ({ id: signal.id, title: signal.title, type: signal.type })),
      provider: "local-fallback",
    };
  }

  if (wantsPlace) {
    const places = captures.filter((capture) => capture.type === "Place" || capture.place);
    return {
      answer: places.length
        ? `I found ${places.length} saved place${places.length === 1 ? "" : "s"}. The first one is ${places[0].place?.name ?? places[0].title}${places[0].place?.address ? ` at ${places[0].place.address}` : ""}.`
        : "I do not see saved places yet.",
      related: places.slice(0, 5).map((capture) => ({ id: capture.id, title: capture.place?.name ?? capture.title, type: capture.type })),
      provider: "local-fallback",
    };
  }

  if (wantsSchedule) {
    const today = new Date().toISOString().slice(0, 10);
    const scheduled = captures
      .filter((capture) => capture.due || capture.type === "Actionable")
      .sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
    const todayItems = scheduled.filter((capture) => String(capture.due ?? "").startsWith(today));
    const items = todayItems.length ? todayItems : scheduled;
    return {
      answer: items.length
        ? `${todayItems.length ? "Today" : "Upcoming"} has ${items.length} relevant capture${items.length === 1 ? "" : "s"}. First: "${items[0].title}".`
        : "I do not see scheduled captures yet.",
      related: items.slice(0, 5).map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
      provider: "local-fallback",
    };
  }

  if (wantsFiles) {
    const files = captures.filter((capture) => capture.attachmentName || capture.imageUrl || capture.attachments?.length);
    return {
      answer: files.length
        ? `I found ${files.length} capture${files.length === 1 ? "" : "s"} with files or images. The latest one is "${files[0].attachmentName ?? files[0].title}".`
        : "I do not see files or images in your captures yet.",
      related: files.slice(0, 5).map((capture) => ({ id: capture.id, title: capture.attachmentName ?? capture.title, type: capture.type })),
      provider: "local-fallback",
    };
  }

  if (wantsTags) {
    const tagCounts = new Map();
    captures.forEach((capture) => (capture.metadata ?? []).forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)));
    const tags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      answer: tags.length
        ? `The most used tags are ${tags.map(([tag, count]) => `${tag} (${count})`).join(", ")}.`
        : "I do not see tags yet.",
      related: captures.filter((capture) => (capture.metadata ?? []).some((tag) => words.includes(String(tag).toLowerCase()))).slice(0, 5).map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
      provider: "local-fallback",
    };
  }

  if (wantsPriority || wantsStarred || wantsDone) {
    const filtered = captures.filter((capture) => {
      if (wantsStarred) return capture.starred;
      if (wantsDone) return capture.completed;
      if (query.includes("high") || query.includes("alta") || query.includes("urgente")) return capture.priority === "High";
      if (query.includes("low") || query.includes("bassa")) return capture.priority === "Low";
      if (query.includes("medium") || query.includes("media")) return capture.priority === "Medium";
      return ["High", "Medium"].includes(capture.priority);
    });
    return {
      answer: filtered.length
        ? `I found ${filtered.length} matching capture${filtered.length === 1 ? "" : "s"}. First: "${filtered[0].title}".`
        : "I do not see matching captures yet.",
      related: filtered.slice(0, 5).map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
      provider: "local-fallback",
    };
  }

  const scored = captures
    .map((capture) => {
      const haystack = `${capture.title ?? ""} ${capture.text ?? ""} ${capture.type ?? ""} ${(capture.metadata ?? []).join(" ")} ${capture.place?.name ?? ""} ${capture.place?.address ?? ""} ${capture.attachmentName ?? ""}`.toLowerCase();
      const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
      return { capture, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.capture);

  const matches = scored.length ? scored : captures.slice(0, 3);
  return {
    answer: matches.length
      ? `I found ${matches.length} relevant capture${matches.length === 1 ? "" : "s"}. The strongest match is "${matches[0].title}".`
      : "I do not have enough captures to answer that yet.",
    related: matches.map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
    provider: "local-fallback",
  };
};

async function askNube(question, captures) {
  const compactCaptures = captures.slice(0, 80).map((capture) => ({
    id: capture.id,
    title: capture.title,
    type: capture.type,
    text: String(capture.text ?? "").slice(0, 320),
    tags: Array.isArray(capture.metadata) ? capture.metadata.slice(0, 10) : [],
    due: capture.due ?? null,
    priority: capture.priority ?? null,
    completed: Boolean(capture.completed),
    starred: Boolean(capture.starred),
    createdAt: capture.createdAt ?? null,
    source: capture.source ?? null,
    place: capture.place ? { name: capture.place.name, address: capture.place.address, rating: capture.place.rating } : null,
    attachment: capture.attachmentName || capture.attachments?.length ? { name: capture.attachmentName ?? capture.attachments?.[0]?.name, size: capture.attachmentSize ?? capture.attachments?.[0]?.size ?? null, hasImage: Boolean(capture.imageUrl) } : null,
  }));
  const moneySummary = captureMoneySignals(captures).reduce((summary, signal) => {
    summary.count += 1;
    if (signal.direction === "income") summary.income += signal.amount;
    else if (signal.direction === "expense") summary.expenses += signal.amount;
    else summary.review += 1;
    return summary;
  }, { count: 0, income: 0, expenses: 0, review: 0 });
  const fallback = localAskNube(question, captures);
  if (!hasAiKey() || (aiProvider !== "google" && aiProvider !== "gemini")) return fallback;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You are Ask Nube, a concise assistant for a personal intelligent inbox. Answer only from the provided captures and summaries. Preserve the user's language. Use the user's language even when captures are in another language. For money questions, include totals and review items. For dates, distinguish today, due dates, and creation dates. For places, include address/rating when present. For tags, files, priority, starred, completed, Gmail, Calendar, and browser captures, use the structured fields. Return valid JSON only." }] },
      contents: [{ role: "user", parts: [{ text: `Question: ${question}\n\nReturn JSON:\n{"answer":"short useful answer","related":[{"id":123,"title":"capture title","type":"CaptureType"}]}\n\nMoney summary:\n${JSON.stringify(moneySummary)}\n\nCaptures:\n${JSON.stringify(compactCaptures)}` }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });
  if (!response.ok) return fallback;
  const payload = await response.json();
  const outputText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  const parsed = parseModelJson(outputText);
  return {
    answer: typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : fallback.answer,
    related: Array.isArray(parsed.related) ? parsed.related.filter((item) => item && typeof item.title === "string").slice(0, 5) : fallback.related,
    provider: "google",
  };
}

async function classifyWithAi(text, source) {
  if (aiProvider === "google" || aiProvider === "gemini") return classifyWithGoogle(text, source);
  if (aiProvider === "openrouter") return classifyWithOpenRouter(text, source);
  if (aiProvider === "openai") return classifyWithOpenAI(text, source);
  return classifyLocally(text);
}

async function readBody(req, limit = maxJsonBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`JSON payload is too large. Limit is ${Math.round(limit / 1024)} KB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  return JSON.parse(await readBody(req) || "{}");
}

const rateLimitKey = (req, bucket) => `${bucket}:${req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "local"}`;
const enforceRateLimit = (req, bucket, limit, windowMs) => {
  const key = rateLimitKey(req, bucket);
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
};

const routeBucketFor = (pathname) => {
  if (pathname === "/api/classify" || pathname === "/api/ask" || pathname === "/api/insights/review") return ["ai", 30, 60_000];
  if (pathname === "/api/ingest" || pathname === "/api/profile/avatar") return ["upload", 18, 60_000];
  if (pathname.startsWith("/api/gmail") || pathname.startsWith("/api/calendar")) return ["google", 40, 60_000];
  if (pathname.startsWith("/api/integrations/")) return ["integration", 80, 60_000];
  if (pathname.startsWith("/api/brain")) return ["brain", 60, 60_000];
  return ["api", 240, 60_000];
};

const defaultAuthStore = () => ({ users: {}, sessions: {}, states: {}, activity: [], files: {} });
async function readAuthStore() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(authFile)) return defaultAuthStore();
  return { ...defaultAuthStore(), ...JSON.parse(await readFile(authFile, "utf8")) };
}

async function writeAuthStore(store) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(authFile, JSON.stringify(store, null, 2));
  return store;
}

const parseCookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
  const index = part.indexOf("=");
  return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
}));

const setCookie = (res, name, value, options = {}) => {
  const pieces = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly !== false) pieces.push("HttpOnly");
  if (secureCookies) pieces.push("Secure");
  if (options.maxAge !== undefined) pieces.push(`Max-Age=${options.maxAge}`);
  res.setHeader("Set-Cookie", pieces.join("; "));
};

async function currentUser(req) {
  const sessionId = parseCookies(req).nube_session;
  if (!sessionId) return null;
  const store = await readAuthStore();
  const session = store.sessions[sessionId];
  if (!session || session.expiresAt < Date.now()) return null;
  return store.users[session.userId] ?? null;
}

const publicUser = (user) => user ? {
  id: user.id,
  name: user.name,
  email: user.email,
  avatarUrl: user.avatarUrl,
  picture: user.picture,
  profile: user.profile ?? null,
  provider: user.provider,
  calendarConnected: Boolean(user.googleTokens?.accessToken),
  gmailConnected: Boolean(user.googleTokens?.accessToken && String(user.googleTokens?.scope ?? "").includes("gmail.readonly")),
} : null;

const planCatalog = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    annualPrice: 0,
    storageGb: 1,
    capturesPerMonth: 100,
    maxUploadMb: 5,
    aiClassificationsPerMonth: 50,
    askNubePerMonth: 10,
    voiceMinutesPerMonth: 15,
    ocr: false,
    cloudSync: false,
    gmailImport: false,
    calendarImport: true,
    browserExtension: true,
    developerApi: false,
  },
  personal: {
    id: "personal",
    name: "Personal",
    monthlyPrice: 8,
    annualPrice: 79,
    storageGb: 20,
    capturesPerMonth: null,
    maxUploadMb: 25,
    aiClassificationsPerMonth: 2000,
    askNubePerMonth: 300,
    voiceMinutesPerMonth: 300,
    ocr: true,
    cloudSync: true,
    gmailImport: true,
    calendarImport: true,
    browserExtension: true,
    developerApi: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 15,
    annualPrice: 149,
    storageGb: 100,
    capturesPerMonth: null,
    maxUploadMb: 100,
    aiClassificationsPerMonth: 10000,
    askNubePerMonth: 1500,
    voiceMinutesPerMonth: 1500,
    ocr: true,
    cloudSync: true,
    gmailImport: true,
    calendarImport: true,
    browserExtension: true,
    developerApi: true,
  },
};

const billingPlanFor = (user) => user?.billing?.plan && planCatalog[user.billing.plan] ? user.billing.plan : "free";

async function updateUserBilling(user, patch) {
  if (!user?.id) return null;
  const store = await readAuthStore();
  const current = store.users[user.id] ?? user;
  const nextUser = {
    ...current,
    billing: {
      ...(current.billing ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: Date.now(),
  };
  store.users[user.id] = nextUser;
  await writeAuthStore(store);
  return nextUser;
}

async function createStripeCheckoutSession(user, plan, interval) {
  if (!stripeConfigured()) {
    return {
      configured: false,
      checkoutUrl: null,
      message: "Billing is not connected yet. Add Stripe keys to enable checkout.",
    };
  }
  const priceId = plan === "pro"
    ? process.env.STRIPE_PRO_PRICE_ID
    : process.env.STRIPE_PERSONAL_PRICE_ID;
  const successUrl = process.env.STRIPE_SUCCESS_URL ?? `${appUrl}/?billing=success`;
  const cancelUrl = process.env.STRIPE_CANCEL_URL ?? `${appUrl}/?billing=cancelled`;
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: user.id,
    customer_email: user.email ?? "",
    "metadata[userId]": user.id,
    "metadata[plan]": plan,
    "metadata[interval]": interval,
    allow_promotion_codes: "true",
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Stripe checkout failed.");
  }
  const session = await response.json();
  await updateUserBilling(user, {
    plan,
    interval,
    checkoutSessionId: session.id,
    status: "checkout_started",
  });
  return { configured: true, checkoutUrl: session.url, sessionId: session.id };
}

const googleAuthConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

async function createSession(res, user) {
  const store = await readAuthStore();
  const sessionId = randomUUID();
  store.sessions[sessionId] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  store.users[user.id] = user;
  await writeAuthStore(store);
  setCookie(res, "nube_session", sessionId, { maxAge: 60 * 60 * 24 * 30 });
}

async function ensureIntegrationToken() {
  const store = await readAuthStore();
  if (!store.integrationToken) {
    store.integrationToken = `nube_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    store.integrationTokenCreatedAt = Date.now();
    await writeAuthStore(store);
  }
  return store.integrationToken;
}

async function rotateIntegrationToken() {
  const store = await readAuthStore();
  store.integrationToken = `nube_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  store.integrationTokenCreatedAt = Date.now();
  await writeAuthStore(store);
  return store.integrationToken;
}

async function validateIntegrationToken(req) {
  const expected = await ensureIntegrationToken();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : req.headers["x-nube-token"];
  return Boolean(token && token === expected);
}

async function validateInboundEmailRequest(req, rawBody) {
  if (!process.env.NUBE_INBOUND_EMAIL_SECRET) return await validateIntegrationToken(req);
  const signature = String(req.headers["x-nube-signature"] ?? "");
  if (!signature) return false;
  const expected = createHmac("sha256", process.env.NUBE_INBOUND_EMAIL_SECRET).update(rawBody).digest("hex");
  const left = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function addActivity(event) {
  const store = await readAuthStore();
  const activity = Array.isArray(store.activity) ? store.activity : [];
  activity.unshift({
    id: randomUUID(),
    time: new Date().toISOString(),
    level: event.level ?? "info",
    source: event.source ?? "system",
    title: event.title ?? "Nube activity",
    detail: event.detail ?? "",
    captureId: event.captureId ?? null,
  });
  store.activity = activity.slice(0, 60);
  await writeAuthStore(store);
  return store.activity[0];
}

async function readActivity() {
  const store = await readAuthStore();
  return Array.isArray(store.activity) ? store.activity.slice(0, 40) : [];
}

async function registerStoredFile(file, storedFile, user) {
  if (!storedFile?.key || !user?.id) return storedFile;
  const store = await readAuthStore();
  const files = store.files && typeof store.files === "object" ? store.files : {};
  files[storedFile.key] = {
    key: storedFile.key,
    provider: storedFile.provider,
    userId: user.id,
    originalName: file.filename ?? "upload",
    mimeType: file.mimeType ?? "application/octet-stream",
    size: file.buffer?.length ?? 0,
    createdAt: new Date().toISOString(),
  };
  store.files = files;
  await writeAuthStore(store);
  return storedFile;
}

async function canReadStoredFile(key, user) {
  const store = await readAuthStore();
  const record = store.files?.[key];
  if (!record) return true;
  return Boolean(user?.id && record.userId === user.id);
}

async function addImportBatch(batch) {
  const store = await readAuthStore();
  const batches = Array.isArray(store.importBatches) ? store.importBatches : [];
  const nextBatch = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: batch.provider ?? "import",
    title: batch.title ?? "Import",
    detail: batch.detail ?? "",
    captureIds: Array.isArray(batch.captureIds) ? batch.captureIds : [],
    count: Number(batch.count ?? batch.captureIds?.length ?? 0),
    skipped: Number(batch.skipped ?? 0),
  };
  batches.unshift(nextBatch);
  store.importBatches = batches.slice(0, 30);
  await writeAuthStore(store);
  return nextBatch;
}

async function readImportBatches() {
  const store = await readAuthStore();
  return Array.isArray(store.importBatches) ? store.importBatches.slice(0, 30) : [];
}

async function deleteCapturesByIds(ids, user = null) {
  const safeIds = Array.from(new Set(ids.map(Number).filter(Number.isFinite)));
  if (!safeIds.length) return 0;
  if (cloudDatabaseEnabledFor(user)) {
    return await deleteCloudCapturesByIds(user, safeIds);
  }
  const database = await getDatabase();
  const deleteOne = database.prepare("DELETE FROM captures WHERE id = ?");
  let deleted = 0;
  database.exec("BEGIN");
  try {
    for (const id of safeIds) deleted += deleteOne.run(id).changes;
    database.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('updatedAt', ?)").run(new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const vault = await readBrainVault();
  if (Array.isArray(vault.captures)) {
    const idSet = new Set(safeIds);
    await writeBrainVault({ ...vault, captures: vault.captures.filter((capture) => !idSet.has(Number(capture.id))) });
  }
  return deleted;
}

async function deleteImportBatch(batchId, user = null) {
  const store = await readAuthStore();
  const batches = Array.isArray(store.importBatches) ? store.importBatches : [];
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return null;
  const deleted = await deleteCapturesByIds(batch.captureIds ?? [], user);
  store.importBatches = batches.filter((item) => item.id !== batchId);
  await writeAuthStore(store);
  await addActivity({
    level: "info",
    source: batch.provider,
    title: "Import deleted",
    detail: `${deleted} capture${deleted === 1 ? "" : "s"} removed from "${batch.title}".`,
  });
  return { batch, deleted };
}

async function saveAvatar(file, user) {
  if (!file.mimeType?.startsWith("image/")) throw new Error("Avatar must be an image.");
  if (file.buffer.length > 5 * 1024 * 1024) throw new Error("Avatar must be under 5 MB.");
  await mkdir(avatarDir, { recursive: true });
  const rawExtension = extname(file.filename ?? "").toLowerCase() || ".png";
  const extension = [".png", ".jpg", ".jpeg", ".webp"].includes(rawExtension) ? rawExtension : ".png";
  const filename = `${safeObjectName(user.id)}-${Date.now()}${extension}`;
  const avatarPath = join(avatarDir, filename);
  await writeFile(avatarPath, file.buffer);
  return `/uploads/avatars/${filename}`;
}

async function refreshGoogleAccessToken(user) {
  const tokens = user?.googleTokens;
  if (!tokens?.refreshToken || !googleAuthConfigured()) return tokens?.accessToken ?? null;
  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return tokens.accessToken ?? null;
  const payload = await response.json();
  const store = await readAuthStore();
  const nextUser = {
    ...user,
    googleTokens: {
      ...tokens,
      accessToken: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
      scope: payload.scope ?? tokens.scope,
    },
    updatedAt: Date.now(),
  };
  store.users[user.id] = nextUser;
  await writeAuthStore(store);
  return nextUser.googleTokens.accessToken;
}

const googleEventToCapture = (event, index = 0) => {
  const start = event.start?.dateTime ?? event.start?.date ?? new Date().toISOString();
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  const title = event.summary || "Google Calendar event";
  const details = [
    event.description ? String(event.description).replace(/<[^>]+>/g, "").trim() : null,
    event.location ? `Location: ${event.location}` : null,
  ].filter(Boolean).join("\n");
  return {
    id: Date.now() * 1000 + index,
    title,
    text: details,
    type: "Actionable",
    source: "google calendar",
    time: "Now",
    metadata: Array.from(new Set(["Google Calendar", event.location ? "Location" : null].filter(Boolean))),
    createdAt: new Date().toISOString(),
    due: start,
    priority: null,
    provider: "local-fallback",
    confidence: 0.82,
    calendar: {
      provider: "google",
      eventId: event.id,
      htmlLink: event.htmlLink,
      start,
      end,
      location: event.location ?? null,
    },
  };
};

const isUsefulGoogleCalendarEvent = (event) => {
  const summary = String(event.summary ?? "").trim().toLowerCase();
  if (event.status === "cancelled") return false;
  if (event.eventType === "birthday") return false;
  if (/^(buon compleanno!?|happy birthday!?)/i.test(summary)) return false;
  return true;
};

const hasGoogleScope = (user, scopePart) => String(user?.googleTokens?.scope ?? "").includes(scopePart);

const decodeBase64Url = (value = "") => Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const getHeader = (message, name) => message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

const walkGmailParts = (part, parts = []) => {
  if (!part) return parts;
  parts.push(part);
  for (const child of part.parts ?? []) walkGmailParts(child, parts);
  return parts;
};

const plainTextFromGmail = (message) => {
  const parts = walkGmailParts(message.payload);
  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data);
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  const raw = plain?.body?.data ? decodeBase64Url(plain.body.data) : html?.body?.data ? decodeBase64Url(html.body.data).replace(/<[^>]+>/g, " ") : message.snippet ?? "";
  return raw
    .replace(/\{[^{}]{20,}\}/g, " ")
    .replace(/[#.@]?[a-z0-9_-]+[^{]{0,80}\{[^}]*\}/gi, " ")
    .replace(/https?:\/\/\S{80,}/g, "[link]")
    .replace(/[-_=]{12,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
};

const attachmentsFromGmail = (payload) => walkGmailParts(payload)
  .filter((part) => part.filename)
  .map((part) => ({
    filename: part.filename,
    mimeType: part.mimeType ?? "application/octet-stream",
    size: part.body?.size ?? null,
  }))
  .slice(0, 8);

const gmailFilterQuery = (filters = {}) => {
  const range = filters.range ?? "all";
  const importantFocused = Boolean(filters.importantOnly);
  const parts = importantFocused ? [] : ["-category:promotions", "-category:social", "-category:forums", "-unsubscribe"];
  if (range === "today") parts.push("newer_than:1d");
  else if (range === "30d") parts.push("newer_than:30d");
  else if (range === "7d") parts.push("newer_than:7d");
  const usefulGroups = [];
  if (filters.receipts !== false) usefulGroups.push("receipt OR invoice OR order OR payment OR fattura OR ricevuta OR scontrino");
  if (filters.bookings) usefulGroups.push("booking OR reservation OR appointment OR prenotazione OR appuntamento OR ticket OR flight OR hotel");
  if (filters.attachments) usefulGroups.push("has:attachment");
  if (filters.importantOnly) usefulGroups.push("is:important");
  if (filters.specialOnly) usefulGroups.push("is:starred");
  if (filters.unreadOnly) usefulGroups.push("is:unread");
  if (usefulGroups.length) parts.push(`(${usefulGroups.map((group) => `(${group})`).join(" OR ")})`);
  if (filters.from) parts.push(`from:${String(filters.from).replace(/\s+/g, "")}`);
  return parts.join(" ");
};

const isUsefulGmailMessage = (message, filters = {}) => {
  const subject = getHeader(message, "Subject").toLowerCase();
  const from = getHeader(message, "From").toLowerCase();
  const text = `${subject} ${from} ${message.snippet ?? ""}`.toLowerCase();
  if (/\b(newsletter|unsubscribe|promo|discount|sale|offerta|marketing|advertisement)\b/.test(text)) return false;
  if (filters.receipts !== false && /\b(receipt|invoice|order|payment|fattura|ricevuta|scontrino)\b/.test(text)) return true;
  if (filters.bookings && /\b(booking|reservation|appointment|prenotazione|appuntamento|ticket|flight|hotel)\b/.test(text)) return true;
  if (filters.attachments && attachmentsFromGmail(message.payload).length) return true;
  if (filters.importantOnly && message.labelIds?.includes("IMPORTANT")) return true;
  if (filters.specialOnly && message.labelIds?.includes("STARRED")) return true;
  if (filters.unreadOnly && message.labelIds?.includes("UNREAD")) return true;
  if (filters.from) return true;
  return false;
};

const gmailMessageToPreview = (message) => {
  const subject = getHeader(message, "Subject") || "Untitled email";
  const from = getHeader(message, "From") || "Unknown sender";
  const date = getHeader(message, "Date");
  const body = plainTextFromGmail(message);
  const attachments = attachmentsFromGmail(message.payload);
  return {
    id: message.id,
    subject,
    from,
    date,
    snippet: message.snippet ?? body.slice(0, 160),
    bodyPreview: body.slice(0, 700),
    attachments,
  };
};

const gmailPreviewToCapture = (preview, index = 0) => {
  const lower = `${preview.subject} ${preview.bodyPreview}`.toLowerCase();
  const type = /\b(receipt|invoice|order|payment|fattura|ricevuta|scontrino)\b/.test(lower) ? "Expense"
    : preview.attachments?.length ? "Document"
    : /\b(booking|reservation|appointment|prenotazione|appuntamento)\b/.test(lower) ? "Actionable"
    : "Document";
  return {
    id: Date.now() * 1000 + index,
    title: preview.subject,
    text: preview.bodyPreview || preview.snippet || "",
    type,
    source: "gmail",
    time: "Now",
    metadata: Array.from(new Set(["Gmail", type === "Expense" ? "Receipt" : null, preview.attachments?.length ? "Attachment" : null].filter(Boolean))),
    createdAt: new Date().toISOString(),
    due: null,
    priority: null,
    provider: "local-fallback",
    confidence: 0.78,
    email: {
      provider: "gmail",
      messageId: preview.id,
      from: preview.from,
      subject: preview.subject,
      date: preview.date,
      bodyPreview: preview.bodyPreview || preview.snippet,
      attachments: preview.attachments ?? [],
    },
  };
};

async function fetchGmailPreviews(user, filters = {}) {
  if (!hasGoogleScope(user, "gmail.readonly")) throw new Error("Gmail is not connected. Sign in with Google again to grant Gmail readonly access.");
  const accessToken = await refreshGoogleAccessToken(user);
  if (!accessToken) throw new Error("Gmail is not connected.");
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(Math.min(Math.max(Number(filters.max ?? 50), 1), 100)));
  listUrl.searchParams.set("q", gmailFilterQuery(filters));
  const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listResponse.ok) throw new Error(`Gmail request failed: ${listResponse.status} ${await listResponse.text()}`);
  const listPayload = await listResponse.json();
  const messages = [];
  for (const item of listPayload.messages ?? []) {
    const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}`);
    detailUrl.searchParams.set("format", "full");
    const detailResponse = await fetch(detailUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (detailResponse.ok) messages.push(await detailResponse.json());
  }
  return messages.filter((message) => isUsefulGmailMessage(message, filters)).map(gmailMessageToPreview);
}

async function fetchGoogleCalendarEvents(user, maxResults = 20, range = "6m") {
  const accessToken = await refreshGoogleAccessToken(user);
  if (!accessToken) throw new Error("Google Calendar is not connected.");
  const timeMax = new Date();
  if (range === "30d") timeMax.setDate(timeMax.getDate() + 30);
  else if (range === "1y") timeMax.setFullYear(timeMax.getFullYear() + 1);
  else timeMax.setMonth(timeMax.getMonth() + 6);
  const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  calendarUrl.searchParams.set("singleEvents", "true");
  calendarUrl.searchParams.set("orderBy", "startTime");
  calendarUrl.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 100)));
  calendarUrl.searchParams.set("timeMin", new Date().toISOString());
  calendarUrl.searchParams.set("timeMax", timeMax.toISOString());
  const response = await fetch(calendarUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Calendar request failed: ${response.status} ${message}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.items) ? payload.items : [];
}

async function readMultipart(req) {
  return new Promise((resolvePromise, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: maxUploadBytes,
      },
    });
    const fields = {};
    let uploadedFile = null;

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (_name, file, info) => {
      const chunks = [];
      if (!isAllowedUpload(info.filename, info.mimeType)) {
        file.resume();
        reject(new Error("This file type is not supported. Upload images, PDFs, or plain text documents."));
        return;
      }
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => reject(new Error("File is too large.")));
      file.on("end", () => {
        uploadedFile = {
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
        };
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (!uploadedFile) {
        reject(new Error("No file uploaded."));
        return;
      }
      resolvePromise({ fields, file: uploadedFile });
    });

    req.pipe(busboy);
  });
}

async function extractTextFromUpload(file) {
  const extension = extname(file.filename ?? "").toLowerCase();
  const mimeType = file.mimeType ?? "";

  if (mimeType === "application/pdf" || extension === ".pdf") {
    const parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return {
      kind: "pdf",
      text: parsed.text.trim(),
      pages: parsed.total,
    };
  }

  if (mimeType.startsWith("text/") || [".txt", ".md", ".json", ".csv", ".log"].includes(extension)) {
    return {
      kind: "text",
      text: file.buffer.toString("utf8").trim(),
      pages: null,
    };
  }

  if (mimeType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(file.buffer);
      return {
        kind: "image",
        text: result.data.text.trim(),
        pages: null,
      };
    } finally {
      await worker.terminate();
    }
  }

  return {
    kind: "binary",
    text: "",
    pages: null,
  };
}

const safeObjectName = (value) => (value || "upload")
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/(^-+|-+$)/g, "")
  .slice(0, 120) || "upload";

async function storeUpload(file, user = null) {
  if (!r2Client) return { provider: "local", key: null, url: null };
  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeObjectName(file.filename)}`;
  await r2Client.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimeType || "application/octet-stream",
    Metadata: {
      originalName: file.filename || "upload",
      ownerId: user?.id ?? "local",
    },
  }));
  const storedFile = {
    provider: "cloudflare-r2",
    key,
    url: r2PublicUrl ? `${r2PublicUrl}/${key}` : `/api/file?key=${encodeURIComponent(key)}`,
  };
  return await registerStoredFile(file, storedFile, user);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readBrainVault(user = null) {
  const cloudVault = await readCloudVault(user, sanitizeCapture);
  if (cloudVault) return cloudVault;
  const database = await getDatabase();
  const captures = database
    .prepare("SELECT payload FROM captures ORDER BY datetime(created_at) DESC, id DESC")
    .all()
    .map((row) => sanitizeCapture(JSON.parse(row.payload)))
    .filter((capture) => visibleToUser(capture, user));
  const focusText = database.prepare("SELECT value FROM state WHERE key = 'focusText'").get()?.value ?? "";
  const updatedAt = database.prepare("SELECT value FROM state WHERE key = 'updatedAt'").get()?.value ?? null;
  return { app: "Nube", captures, focusText, updatedAt, storage: "sqlite" };
}

async function searchBrain(query, user = null) {
  const cloudCaptures = await readCloudRecentCaptures(user, 80, sanitizeCapture);
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 2);
  const database = cloudCaptures ? null : await getDatabase();
  const captures = cloudCaptures ?? database.prepare("SELECT payload FROM captures ORDER BY datetime(created_at) DESC, id DESC")
    .all()
    .map((row) => sanitizeCapture(JSON.parse(row.payload)))
    .filter((capture) => visibleToUser(capture, user));
  const results = captures
    .map((capture) => {
      const haystack = `${capture.title} ${capture.text} ${capture.type} ${capture.source} ${(capture.metadata ?? []).join(" ")}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { capture, score };
    })
    .filter((result) => terms.length === 0 || result.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    query,
    terms,
    provider: cloudCaptures ? "cloud-postgres" : "sqlite",
    results: results.map((result) => result.capture),
  };
}

async function readRecentCaptures(limit = 30, user = null) {
  const cloudCaptures = await readCloudRecentCaptures(user, limit, sanitizeCapture);
  if (cloudCaptures) return cloudCaptures;
  const database = await getDatabase();
  return database
    .prepare("SELECT payload FROM captures ORDER BY datetime(created_at) DESC, id DESC LIMIT ?")
    .all(Math.min(Math.max(Number(limit) || 30, 1), 80))
    .map((row) => sanitizeCapture(JSON.parse(row.payload)))
    .filter((capture) => visibleToUser(capture, user));
}

async function writeBrainVault(data, user = null) {
  if (!Array.isArray(data.captures) || typeof data.focusText !== "string") {
    throw new Error("Invalid brain payload.");
  }
  const ownedCaptures = data.captures.map((capture) => withCaptureOwner(sanitizeCapture(capture), user));
  const cloudVault = await writeCloudVault(user, { ...data, captures: ownedCaptures }, sanitizeCapture);
  if (cloudVault) return cloudVault;

  const database = await getDatabase();
  const payload = {
    app: "Nube",
    captures: ownedCaptures,
    focusText: data.focusText,
    updatedAt: new Date().toISOString(),
  };
  try {
    database.exec("BEGIN");
    database.prepare("DELETE FROM captures").run();
    const insertCapture = database.prepare(`
      INSERT INTO captures (
        id, title, type, source, created_at, completed, due, priority, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const capture of ownedCaptures) {
      insertCapture.run(
        capture.id,
        capture.title,
        capture.type,
        capture.source,
        capture.createdAt,
        capture.completed ? 1 : 0,
        capture.due ?? null,
        capture.priority ?? null,
        JSON.stringify(capture),
      );
    }
    database.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('focusText', ?)").run(data.focusText);
    database.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('updatedAt', ?)").run(payload.updatedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(brainFile, JSON.stringify(payload, null, 2), "utf8");
  return { ...payload, storage: "sqlite" };
}

const normalizeDedupeText = (value) => String(value ?? "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/https?:\/\/\S+/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .slice(0, 220);

const stripCalendarEndText = (value) => String(value ?? "")
  .replace(/(?:^|\n)\s*Ends:\s*[^\n]+/gi, "")
  .replace(/\s*Ends:\s*\d{4}-\d{2}-\d{2}T\S+/gi, "")
  .trim();

const sanitizeCapture = (capture) => {
  if (!capture || typeof capture !== "object") return capture;
  if (capture.source === "google calendar" || capture.calendar?.provider) {
    return { ...capture, text: stripCalendarEndText(capture.text) };
  }
  return capture;
};

const withCaptureOwner = (capture, user = null) => user?.id ? { ...capture, ownerId: user.id } : capture;

const visibleToUser = (capture, user = null) => {
  if (!user?.id) return true;
  return !capture?.ownerId || capture.ownerId === user.id;
};

const captureDedupeKey = (capture) => {
  if (capture.calendar?.provider && capture.calendar?.eventId) return `calendar:${capture.calendar.provider}:${capture.calendar.eventId}`;
  if (capture.email?.from && capture.email?.subject) return `email:${normalizeDedupeText(capture.email.from)}:${normalizeDedupeText(capture.email.subject)}:${normalizeDedupeText(capture.email.bodyPreview).slice(0, 80)}`;
  if (capture.external?.source && capture.external?.url) {
    const kind = capture.external.rawType ?? "page";
    const textPart = ["note", "selection", "image"].includes(kind) ? `:${normalizeDedupeText(capture.text).slice(0, 120)}` : "";
    return `web:${normalizeDedupeText(capture.external.source)}:${kind}:${normalizeDedupeText(capture.external.url)}${textPart}`;
  }
  if (capture.attachmentName && capture.attachmentSize) return `file:${normalizeDedupeText(capture.attachmentName)}:${capture.attachmentSize}`;
  return `capture:${normalizeDedupeText(capture.title)}:${normalizeDedupeText(capture.text).slice(0, 100)}:${capture.due ?? ""}`;
};

async function findDuplicateCapture(capture, user = null) {
  const key = captureDedupeKey(capture);
  const cloudCaptures = await readCloudRecentCaptures(user, 500, sanitizeCapture);
  const database = cloudCaptures ? null : await getDatabase();
  const captures = cloudCaptures ?? database.prepare("SELECT payload FROM captures ORDER BY datetime(created_at) DESC, id DESC LIMIT 500")
    .all()
    .map((row) => sanitizeCapture(JSON.parse(row.payload)))
    .filter((existing) => visibleToUser(existing, user));
  for (const existing of captures) {
    if (captureDedupeKey(existing) === key) return existing;
  }
  return null;
}

async function appendCapture(capture, user = null) {
  capture = withCaptureOwner(sanitizeCapture(capture), user);
  const duplicate = await findDuplicateCapture(capture, user);
  if (duplicate) {
    const shouldUpgradeBrowserCapture = capture.external?.url && duplicate.source === "browser extension" && !["note", "selection", "image"].includes(capture.external.rawType ?? "");
    const upgradedDuplicate = shouldUpgradeBrowserCapture ? {
      ...duplicate,
      type: capture.type === "Link" ? "Link" : duplicate.type,
      external: capture.external ?? duplicate.external,
      metadata: Array.from(new Set([...(duplicate.metadata ?? []), ...(capture.metadata ?? [])]))
        .filter((tag) => !["Webhook", "browser extension"].includes(tag))
        .slice(0, 12),
    } : duplicate;
    if (shouldUpgradeBrowserCapture && cloudDatabaseEnabledFor(user)) {
      await upsertCloudCapture(user, upgradedDuplicate, sanitizeCapture);
    } else if (shouldUpgradeBrowserCapture) {
      const database = await getDatabase();
      database.prepare(`
        UPDATE captures
        SET title = ?, type = ?, source = ?, created_at = ?, completed = ?, due = ?, priority = ?, payload = ?
        WHERE id = ?
      `).run(
        upgradedDuplicate.title,
        upgradedDuplicate.type,
        upgradedDuplicate.source,
        upgradedDuplicate.createdAt,
        upgradedDuplicate.completed ? 1 : 0,
        upgradedDuplicate.due ?? null,
        upgradedDuplicate.priority ?? null,
        JSON.stringify(upgradedDuplicate),
        upgradedDuplicate.id,
      );
    }
    await addActivity({
      level: "warning",
      source: capture.source ?? "capture",
      title: "Duplicate skipped",
      detail: `"${capture.title}" matched an existing capture.`,
      captureId: upgradedDuplicate.id,
    });
    return { capture: upgradedDuplicate, duplicate: true };
  }
  if (cloudDatabaseEnabledFor(user)) {
    const cloudCapture = await upsertCloudCapture(user, capture, sanitizeCapture);
    await addActivity({
      level: "info",
      source: capture.source ?? "capture",
      title: "Capture added",
      detail: `"${capture.title}" was saved to your cloud vault.`,
      captureId: capture.id,
    });
    return { capture: cloudCapture, duplicate: false };
  }
  const database = await getDatabase();
  database.prepare(`
    INSERT INTO captures (
      id, title, type, source, created_at, completed, due, priority, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    capture.id,
    capture.title,
    capture.type,
    capture.source,
    capture.createdAt,
    capture.completed ? 1 : 0,
    capture.due ?? null,
    capture.priority ?? null,
    JSON.stringify(capture),
  );
  database.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('updatedAt', ?)").run(new Date().toISOString());
  await addActivity({
    level: "success",
    source: capture.source ?? "capture",
    title: "Capture added",
    detail: capture.title,
    captureId: capture.id,
  });
  return { capture, duplicate: false };
}

const normalizeEmailAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 10).map((attachment) => ({
    filename: String(attachment?.filename ?? "attachment").slice(0, 160),
    mimeType: String(attachment?.mimeType ?? attachment?.contentType ?? "application/octet-stream").slice(0, 120),
    size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
    url: typeof attachment?.url === "string" ? attachment.url.slice(0, 1200) : null,
  }));
};

const normalizeWebhookAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 8).map((attachment, index) => {
    const name = String(attachment?.name ?? attachment?.filename ?? `attachment-${index + 1}`).slice(0, 160);
    const mimeType = String(attachment?.mimeType ?? attachment?.contentType ?? "application/octet-stream").slice(0, 120);
    if (!isAllowedUpload(name, mimeType)) return null;
    const dataUrl = typeof attachment?.dataUrl === "string" && attachment.dataUrl.startsWith("data:")
      ? attachment.dataUrl.slice(0, 8_500_000)
      : null;
    return {
      id: String(attachment?.id ?? `webhook-${Date.now()}-${index}`).slice(0, 80),
      name,
      size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : 0,
      mimeType,
      dataUrl,
    };
  }).filter(Boolean);
};

const buildForwardedEmailCapture = async (payload) => {
  const from = typeof payload.from === "string" ? payload.from.trim().slice(0, 240) : "";
  const to = typeof payload.to === "string" ? payload.to.trim().slice(0, 240) : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim().slice(0, 240) : "";
  const textBody = typeof payload.text === "string" ? sanitizePlainText(payload.text) : "";
  const htmlBody = typeof payload.html === "string" ? stripHtml(payload.html) : "";
  const body = sanitizePlainText(textBody || htmlBody);
  const attachments = normalizeEmailAttachments(payload.attachments);

  if (!subject && !body && attachments.length === 0) {
    throw new Error("Forwarded email needs a subject, body, or attachment metadata.");
  }

  const attachmentLines = attachments.map((attachment) => {
    const size = attachment.size ? `, ${Math.round(attachment.size / 1024)} KB` : "";
    return `- ${attachment.filename} (${attachment.mimeType}${size})`;
  });
  const input = [
    "Forwarded email",
    from ? `From: ${from}` : null,
    to ? `To: ${to}` : null,
    subject ? `Subject: ${subject}` : null,
    body ? `Body:\n${limitText(body, maxAiFileChars).text}` : null,
    attachmentLines.length ? `Attachments:\n${attachmentLines.join("\n")}` : null,
  ].filter(Boolean).join("\n\n");

  let classification;
  try {
    classification = await classifyWithAi(input, "email forwarding");
  } catch (error) {
    classification = { ...classifyLocally(input), provider: "local-fallback", warning: error.message };
  }

  const senderDomain = from.includes("@") ? from.split("@").pop()?.replace(/[>)]$/, "") : "";
  const metadata = Array.from(new Set([
    ...(classification.metadata ?? []),
    "Email",
    "Forwarded",
    attachments.length ? "Has attachments" : null,
    senderDomain ? senderDomain : null,
  ].filter(Boolean))).slice(0, 12);

  return {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    title: classification.title || subject || "Forwarded email",
    text: sanitizePlainText(classification.summary || body || subject || "Forwarded email captured by Nube."),
    type: classification.type,
    source: "email forwarding",
    time: "Now",
    createdAt: new Date().toISOString(),
    completed: false,
    due: classification.due ?? null,
    priority: classification.priority ?? null,
    metadata,
    people: classification.people ?? [],
    places: classification.places ?? [],
    suggestedAction: classification.suggestedAction ?? "",
    confidence: classification.confidence ?? null,
    provider: classification.provider ?? aiProvider,
    email: {
      from,
      to,
      subject,
      bodyPreview: body.slice(0, 600),
      attachments,
    },
  };
};

const buildWebhookCapture = async (payload) => {
  const title = typeof payload.title === "string" ? sanitizePlainText(payload.title, 180) : "";
  const text = typeof payload.text === "string" ? sanitizePlainText(payload.text, maxStoredExtractedChars) : "";
  const source = typeof payload.source === "string" ? payload.source.trim().slice(0, 80) : "webhook";
  const url = typeof payload.url === "string" ? payload.url.slice(0, 1200) : null;
  const isBrowserExtension = source.toLowerCase() === "browser extension";
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim().slice(0, 40)).slice(0, 12) : [];
  const attachments = normalizeWebhookAttachments(payload.attachments);
  if (!title && !text && attachments.length === 0) throw new Error("Webhook capture needs title, text, or attachments.");
  const input = [title, text].filter(Boolean).join("\n\n");
  let classification;
  try {
    classification = await classifyWithAi(input, source);
  } catch (error) {
    classification = { ...classifyLocally(input), provider: "local-fallback", warning: error.message };
  }
  return {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    title: title || sanitizePlainText(classification.title || input.slice(0, 80), 180),
    text: text || sanitizePlainText(classification.summary || title),
    type: captureTypes.has(payload.type) ? payload.type : (url ? "Link" : classification.type),
    source,
    time: "Now",
    createdAt: new Date().toISOString(),
    completed: false,
    starred: Boolean(payload.starred),
    due: typeof payload.due === "string" ? payload.due : classification.due ?? null,
    priority: priorities.has(payload.priority) ? payload.priority : classification.priority ?? null,
    metadata: Array.from(new Set([
      ...(classification.metadata ?? []),
      ...tags,
      isBrowserExtension && url ? "Web page" : null,
      isBrowserExtension ? null : "Webhook",
    ].filter(Boolean))).slice(0, 12),
    suggestedAction: classification.suggestedAction ?? "",
    confidence: classification.confidence ?? null,
    provider: classification.provider ?? aiProvider,
    external: {
      source,
      url,
      rawType: typeof payload.kind === "string" ? payload.kind : typeof payload.type === "string" ? payload.type : null,
    },
    attachments,
  };
};

async function getDatabase() {
  if (db) return db;

  await mkdir(dataDir, { recursive: true });
  db = new DatabaseSync(sqliteFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      due TEXT,
      priority TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_captures_type ON captures(type);
    CREATE INDEX IF NOT EXISTS idx_captures_created_at ON captures(created_at);
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  if (existsSync(brainFile) && db.prepare("SELECT COUNT(*) AS count FROM captures").get().count === 0) {
    const legacy = JSON.parse(await readFile(brainFile, "utf8"));
    if (Array.isArray(legacy.captures) && typeof legacy.focusText === "string") {
      await writeBrainVault(legacy);
    }
  }

  return db;
}

const originFor = (req) => {
  const origin = req.headers.origin;
  if (origin?.startsWith("chrome-extension://") || origin?.startsWith("moz-extension://")) return origin;
  if (origin && allowedOrigins.has(origin.replace(/\/$/, ""))) return origin;
  return appOrigin;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isTrustedOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
  return allowedOrigins.has(origin.replace(/\/$/, ""));
};

const securityHeaders = () => ({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(self), payment=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://openidconnect.googleapis.com https://www.googleapis.com https://gmail.googleapis.com https://calendar.googleapis.com https://generativelanguage.googleapis.com https://places.googleapis.com https://maps.googleapis.com",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
});

const corsHeaders = (req) => ({
  "Access-Control-Allow-Origin": originFor(req),
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Nube-Token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Vary": "Origin",
});

function sendJson(req, res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/uploads/")) {
    const publicPath = join(publicDir, pathname.slice(1));
    if (publicPath.startsWith(publicDir) && existsSync(publicPath)) {
      const ext = extname(publicPath);
      const body = await readFile(publicPath);
      res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream", "Cache-Control": "no-store", ...securityHeaders() });
      res.end(body);
      return;
    }
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(distDir, requested);
  const safePath = filePath.startsWith(distDir) ? filePath : join(distDir, "index.html");
  const finalPath = existsSync(safePath) ? safePath : join(distDir, "index.html");
  const ext = extname(finalPath);
  const body = await readFile(finalPath);
  res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream", ...securityHeaders() });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...securityHeaders(),
        ...corsHeaders(req),
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (unsafeMethods.has(req.method ?? "") && !isTrustedOrigin(req)) {
        sendJson(req, res, 403, { error: "Request origin is not allowed." });
        return;
      }
      const [bucket, limit, windowMs] = routeBucketFor(url.pathname);
      if (!enforceRateLimit(req, bucket, limit, windowMs)) {
        sendJson(req, res, 429, { error: "Too many requests. Give Nube a moment, then try again." });
        return;
      }
    }
    if (url.pathname === "/api/health") {
      sendJson(req, res, 200, {
        ok: true,
        ai: hasAiKey() ? aiProvider : "local-fallback",
        model,
        storage: "sqlite",
        objectStorage: objectStorageProvider,
        limits: {
          maxUploadBytes,
          maxJsonBytes,
          allowedFileTypes: Array.from(allowedUploadExtensions),
        },
        cloudDatabase: process.env.NUBE_CLOUD_DATABASE_URL ? "configured" : "not-configured",
        cloudDatabaseStatus: cloudDatabaseStatus(),
        googleCalendar: googleAuthConfigured(),
        googlePlaces: Boolean(process.env.GOOGLE_MAPS_API_KEY),
        integrations: {
          emailForwarding: emailForwardingReady(),
          emailForwardingAddress,
          emailForwardingEndpoint: "/api/integrations/email/inbound",
          googleCalendar: googleAuthConfigured(),
        },
        releaseReadiness: releaseReadiness(),
      });
      return;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      sendJson(req, res, 200, {
        user: publicUser(await currentUser(req)),
        googleConfigured: googleAuthConfigured(),
      });
      return;
    }

    if (url.pathname === "/api/sync/status" && req.method === "GET") {
      const user = await currentUser(req);
      const localVault = await readBrainVault(null);
      const cloudVault = user && cloudDatabaseEnabledFor(user) ? await readCloudVault(user, sanitizeCapture) : null;
      sendJson(req, res, 200, {
        signedIn: Boolean(user),
        cloudConfigured: Boolean(process.env.NUBE_CLOUD_DATABASE_URL),
        cloudReady: Boolean(cloudVault),
        localCaptures: localVault.captures?.filter((capture) => visibleToUser(capture, user)).length ?? 0,
        cloudCaptures: cloudVault?.captures?.length ?? 0,
        storage: cloudVault ? "cloud-postgres" : "sqlite",
      });
      return;
    }

    if (url.pathname === "/api/sync/push-local" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      if (!cloudDatabaseEnabledFor(user)) {
        sendJson(req, res, 409, { error: "Cloud database is not configured." });
        return;
      }
      const localVault = await readBrainVault(null);
      const captures = (localVault.captures ?? []).filter((capture) => visibleToUser(capture, user));
      const cloudVault = await writeCloudVault(user, { captures, focusText: localVault.focusText ?? "" }, sanitizeCapture);
      await addActivity({
        level: "success",
        source: "sync",
        title: "Local vault pushed to cloud",
        detail: `${captures.length} capture${captures.length === 1 ? "" : "s"} prepared for multi-device sync.`,
      });
      sendJson(req, res, 200, {
        ok: true,
        pushed: captures.length,
        cloudCaptures: cloudVault.captures.length,
      });
      return;
    }

    if (url.pathname === "/api/billing/status" && req.method === "GET") {
      const user = await currentUser(req);
      const plan = billingPlanFor(user);
      sendJson(req, res, 200, {
        configured: stripeConfigured(),
        signedIn: Boolean(user),
        currentPlan: plan,
        billing: user?.billing ?? { plan: "free", status: "free" },
        plans: planCatalog,
      });
      return;
    }

    if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required before upgrading." });
        return;
      }
      const body = await readJson(req);
      const plan = body.plan === "pro" ? "pro" : body.plan === "personal" ? "personal" : null;
      const interval = body.interval === "annual" ? "annual" : "monthly";
      if (!plan) {
        sendJson(req, res, 400, { error: "Choose a valid plan." });
        return;
      }
      sendJson(req, res, 200, await createStripeCheckoutSession(user, plan, interval));
      return;
    }

    if (url.pathname === "/api/auth/google" && req.method === "GET") {
      if (!googleAuthConfigured()) {
        sendJson(req, res, 501, { error: "Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env." });
        return;
      }
      const state = randomUUID();
      const store = await readAuthStore();
      store.states[state] = { createdAt: Date.now() };
      await writeAuthStore(store);
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", googleRedirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", googleScopes);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("prompt", "consent select_account");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("include_granted_scopes", "true");
      res.writeHead(302, { Location: authUrl.toString() });
      res.end();
      return;
    }

    if (url.pathname === "/api/auth/google/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const store = await readAuthStore();
      if (!code || !state || !store.states[state]) {
        res.writeHead(302, { Location: `${appUrl}/?auth=failed` });
        res.end();
        return;
      }
      delete store.states[state];
      await writeAuthStore(store);
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: googleRedirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResponse.ok) {
        res.writeHead(302, { Location: `${appUrl}/?auth=failed` });
        res.end();
        return;
      }
      const tokenPayload = await tokenResponse.json();
      const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
      });
      const googleProfile = await profileResponse.json();
      const existingUser = store.users[`google:${googleProfile.sub}`] ?? {};
      const user = {
        id: `google:${googleProfile.sub}`,
        provider: "google",
        email: googleProfile.email,
        name: existingUser.name ?? googleProfile.name ?? googleProfile.email ?? "Nube user",
        picture: googleProfile.picture ?? "",
        avatarUrl: existingUser.avatarUrl ?? googleProfile.picture ?? "",
        googleTokens: {
          accessToken: tokenPayload.access_token,
          refreshToken: tokenPayload.refresh_token ?? existingUser.googleTokens?.refreshToken ?? null,
          expiresAt: Date.now() + Number(tokenPayload.expires_in ?? 3600) * 1000,
          scope: tokenPayload.scope ?? googleScopes,
        },
        gmailEnabled: existingUser.gmailEnabled,
        createdAt: existingUser.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await createSession(res, user);
      res.writeHead(302, { Location: `${appUrl}/?auth=google` });
      res.end();
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const sessionId = parseCookies(req).nube_session;
      if (sessionId) {
        const store = await readAuthStore();
        delete store.sessions[sessionId];
        await writeAuthStore(store);
      }
      setCookie(res, "nube_session", "", { maxAge: 0 });
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/profile/avatar" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const { file } = await readMultipart(req);
      const avatarUrl = await saveAvatar(file, user);
      const store = await readAuthStore();
      store.users[user.id] = { ...user, avatarUrl, updatedAt: Date.now() };
      await writeAuthStore(store);
      sendJson(req, res, 200, { user: publicUser(store.users[user.id]) });
      return;
    }

    if (url.pathname === "/api/profile" && req.method === "PATCH") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const body = await readJson(req);
      const safeProfile = {
        name: typeof body.name === "string" ? body.name.trim().slice(0, 80) : user.profile?.name ?? user.name,
        city: typeof body.city === "string" ? body.city.trim().slice(0, 80) : user.profile?.city ?? "",
        locationLabel: typeof body.locationLabel === "string" ? body.locationLabel.trim().slice(0, 160) : user.profile?.locationLabel ?? "",
        latitude: Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : user.profile?.latitude ?? null,
        longitude: Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : user.profile?.longitude ?? null,
        currency: ["EUR", "USD", "GBP"].includes(body.currency) ? body.currency : user.profile?.currency ?? "EUR",
      };
      const store = await readAuthStore();
      store.users[user.id] = { ...user, name: safeProfile.name || user.name, profile: safeProfile, updatedAt: Date.now() };
      await writeAuthStore(store);
      sendJson(req, res, 200, { user: publicUser(store.users[user.id]) });
      return;
    }

    if (url.pathname === "/api/calendar/status" && req.method === "GET") {
      const user = await currentUser(req);
      sendJson(req, res, 200, {
        configured: googleAuthConfigured(),
        connected: Boolean(user?.googleTokens?.accessToken),
        scope: user?.googleTokens?.scope ?? null,
      });
      return;
    }

    if (url.pathname === "/api/calendar/events" && req.method === "GET") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const rawEvents = await fetchGoogleCalendarEvents(user, Number(url.searchParams.get("max") ?? 20), url.searchParams.get("range") ?? "6m");
      const events = rawEvents.filter(isUsefulGoogleCalendarEvent);
      sendJson(req, res, 200, {
        ok: true,
        provider: "google-calendar",
        events,
        ignored: rawEvents.length - events.length,
        captures: events.map(googleEventToCapture),
      });
      return;
    }

    if (url.pathname === "/api/calendar/import" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const body = req.headers["content-type"]?.includes("application/json") ? await readJson(req) : {};
      const rawEvents = await fetchGoogleCalendarEvents(user, Number(body.max ?? 50), body.range ?? "6m");
      const events = rawEvents.filter(isUsefulGoogleCalendarEvent);
      const captures = events.map(googleEventToCapture);
      const results = [];
      for (const capture of captures) results.push(await appendCapture(capture, user));
      const added = results.filter((result) => !result.duplicate).map((result) => result.capture);
      const skipped = results.length - added.length;
      const batch = added.length ? await addImportBatch({
        provider: "google calendar",
        title: "Google Calendar import",
        detail: `${added.length} upcoming event${added.length === 1 ? "" : "s"} imported.`,
        captureIds: added.map((capture) => capture.id),
        count: added.length,
        skipped,
      }) : null;
      sendJson(req, res, 200, {
        ok: true,
        provider: "google-calendar",
        imported: added.length,
        skipped,
        ignored: rawEvents.length - events.length,
        batch,
        captures: added,
      });
      return;
    }

    if (url.pathname === "/api/calendar/disconnect" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const store = await readAuthStore();
      const nextUser = { ...user, googleTokens: null, updatedAt: Date.now() };
      store.users[user.id] = nextUser;
      await writeAuthStore(store);
      await addActivity({
        level: "info",
        source: "google calendar",
        title: "Calendar disconnected",
        detail: "Google Calendar access was removed from this local Nube profile.",
      });
      sendJson(req, res, 200, { ok: true, connected: false });
      return;
    }

    if (url.pathname === "/api/gmail/status" && req.method === "GET") {
      const user = await currentUser(req);
      const hasAccess = Boolean(user?.googleTokens?.accessToken && hasGoogleScope(user, "gmail.readonly"));
      sendJson(req, res, 200, {
        configured: googleAuthConfigured(),
        connected: hasAccess,
        enabled: hasAccess && user?.gmailEnabled !== false,
        scope: user?.googleTokens?.scope ?? null,
      });
      return;
    }

    if (url.pathname === "/api/gmail/toggle" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      const body = await readJson(req);
      const enabled = Boolean(body.enabled);
      const store = await readAuthStore();
      store.users[user.id] = { ...user, gmailEnabled: enabled, updatedAt: Date.now() };
      await writeAuthStore(store);
      await addActivity({
        level: "info",
        source: "gmail",
        title: enabled ? "Gmail import enabled" : "Gmail import paused",
        detail: enabled ? "Gmail previews can be scanned manually." : "Gmail access remains connected, but imports are paused.",
      });
      sendJson(req, res, 200, { ok: true, enabled });
      return;
    }

    if (url.pathname === "/api/gmail/preview" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      if (user.gmailEnabled === false) {
        sendJson(req, res, 409, { error: "Gmail import is paused." });
        return;
      }
      const filters = await readJson(req);
      const previews = await fetchGmailPreviews(user, filters);
      sendJson(req, res, 200, {
        ok: true,
        provider: "gmail",
        query: gmailFilterQuery(filters),
        previews,
      });
      return;
    }

    if (url.pathname === "/api/gmail/import" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      if (user.gmailEnabled === false) {
        sendJson(req, res, 409, { error: "Gmail import is paused." });
        return;
      }
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        sendJson(req, res, 400, { error: "Select at least one Gmail message before importing." });
        return;
      }
      const selectedIds = new Set(body.ids.map(String));
      const previews = await fetchGmailPreviews(user, body.filters ?? {});
      const selected = previews.filter((preview) => selectedIds.has(String(preview.id)));
      const captures = selected.map(gmailPreviewToCapture);
      const results = [];
      for (const capture of captures) results.push(await appendCapture(capture, user));
      const added = results.filter((result) => !result.duplicate).map((result) => result.capture);
      const skipped = results.length - added.length;
      const batch = added.length ? await addImportBatch({
        provider: "gmail",
        title: "Gmail import",
        detail: `${added.length} email${added.length === 1 ? "" : "s"} imported.`,
        captureIds: added.map((capture) => capture.id),
        count: added.length,
        skipped,
      }) : null;
      sendJson(req, res, 200, {
        ok: true,
        provider: "gmail",
        imported: added.length,
        skipped,
        batch,
        captures: added,
      });
      return;
    }

    if (url.pathname === "/api/imports" && req.method === "GET") {
      sendJson(req, res, 200, { imports: await readImportBatches() });
      return;
    }

    if (url.pathname.startsWith("/api/imports/") && req.method === "DELETE") {
      const batchId = decodeURIComponent(url.pathname.replace("/api/imports/", ""));
      const result = await deleteImportBatch(batchId, await currentUser(req));
      if (!result) {
        sendJson(req, res, 404, { error: "Import batch not found." });
        return;
      }
      sendJson(req, res, 200, { ok: true, deleted: result.deleted, batch: result.batch });
      return;
    }

    if (url.pathname === "/api/location/reverse" && req.method === "GET") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      sendJson(req, res, 200, await reverseLocation(lat, lng));
      return;
    }

    if (url.pathname === "/api/weather" && req.method === "GET") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      sendJson(req, res, 200, await currentWeather(lat, lng));
      return;
    }

    if (url.pathname === "/api/place/enrich" && req.method === "POST") {
      const { query } = await readJson(req);
      if (!query || typeof query !== "string") {
        sendJson(req, res, 400, { error: "Missing query." });
        return;
      }
      sendJson(req, res, 200, await enrichPlace(query.slice(0, 300)));
      return;
    }

    if (url.pathname === "/api/place/photo" && req.method === "GET") {
      if (!process.env.GOOGLE_MAPS_API_KEY) {
        sendJson(req, res, 500, { error: "GOOGLE_MAPS_API_KEY is missing." });
        return;
      }
      const name = url.searchParams.get("name");
      const maxWidthPx = url.searchParams.get("maxWidthPx") ?? "900";
      if (!name || !name.startsWith("places/")) {
        sendJson(req, res, 400, { error: "Missing photo name." });
        return;
      }
      const photoUrl = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${encodeURIComponent(maxWidthPx)}&key=${encodeURIComponent(process.env.GOOGLE_MAPS_API_KEY)}`;
      const photoResponse = await fetch(photoUrl, { redirect: "follow" });
      if (!photoResponse.ok) {
        sendJson(req, res, photoResponse.status, { error: "Photo request failed." });
        return;
      }
      const contentType = photoResponse.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await photoResponse.arrayBuffer());
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store", ...securityHeaders(), ...corsHeaders(req) });
      res.end(buffer);
      return;
    }

    if (url.pathname === "/api/file" && req.method === "GET") {
      if (!r2Client) {
        sendJson(req, res, 404, { error: "Cloud storage is not configured." });
        return;
      }
      const key = url.searchParams.get("key");
      if (!key || key.includes("..") || !key.startsWith("uploads/")) {
        sendJson(req, res, 400, { error: "Invalid file key." });
        return;
      }
      if (!await canReadStoredFile(key, await currentUser(req))) {
        sendJson(req, res, 403, { error: "You do not have access to this file." });
        return;
      }
      const object = await r2Client.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
      const buffer = await streamToBuffer(object.Body);
      res.writeHead(200, {
        "Content-Type": object.ContentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        ...securityHeaders(),
        ...corsHeaders(req),
      });
      res.end(buffer);
      return;
    }

    if (url.pathname === "/api/classify" && req.method === "POST") {
      const { text, source } = await readJson(req);
      if (!text || typeof text !== "string") {
        sendJson(req, res, 400, { error: "Missing text." });
        return;
      }
      if (text.length > maxStoredExtractedChars) {
        sendJson(req, res, 413, { error: `Capture is too long. Limit is ${maxStoredExtractedChars} characters.` });
        return;
      }

      try {
        sendJson(req, res, 200, await classifyWithAi(text, source));
      } catch (error) {
        sendJson(req, res, 200, { ...classifyLocally(text), provider: "local-fallback", warning: error.message });
      }
      return;
    }

    if (url.pathname === "/api/insights/review" && req.method === "POST") {
      const { captures } = await readJson(req);
      if (!Array.isArray(captures)) {
        sendJson(req, res, 400, { error: "Missing captures." });
        return;
      }
      try {
        sendJson(req, res, 200, await reviewWithAi(captures));
      } catch (error) {
        sendJson(req, res, 200, { ...localReviewFor(captures), warning: error.message });
      }
      return;
    }

    if (url.pathname === "/api/ask" && req.method === "POST") {
      const { question, captures } = await readJson(req);
      if (!question || typeof question !== "string" || !Array.isArray(captures)) {
        sendJson(req, res, 400, { error: "Missing question or captures." });
        return;
      }
      try {
        sendJson(req, res, 200, await askNube(question.slice(0, 600), captures));
      } catch (error) {
        sendJson(req, res, 200, { ...localAskNube(question, captures), warning: error.message });
      }
      return;
    }

    if (url.pathname === "/api/ingest" && req.method === "POST") {
      const user = await currentUser(req);
      const { file } = await readMultipart(req);
      const storedFile = await storeUpload(file, user);
      const extraction = await extractTextFromUpload(file);
      const storedExtraction = limitText(extraction.text, maxStoredExtractedChars);
      const aiExtraction = limitText(extraction.text, maxAiFileChars);
      const extractedText = storedExtraction.text || `File uploaded: ${file.filename}`;
      const input = [
        `Indexed file: ${file.filename} (${Math.round(file.buffer.length / 1024)} KB)`,
        extraction.pages ? `Pages: ${extraction.pages}` : null,
        aiExtraction.text ? `Extracted text:\n${aiExtraction.text}` : "No readable text was extracted.",
      ]
        .filter(Boolean)
        .join("\n\n");

      let classification;
      try {
        classification = await classifyWithAi(input, "file upload");
      } catch (error) {
        classification = { ...classifyLocally(input), provider: "local-fallback", warning: error.message };
      }

      sendJson(req, res, 200, {
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.buffer.length,
        storage: storedFile.provider,
        fileKey: storedFile.key,
        fileUrl: storedFile.url,
        kind: extraction.kind,
        pages: extraction.pages,
        extractedText,
        limits: {
          maxUploadBytes,
          maxAiFileChars,
          maxStoredExtractedChars,
          aiTextTruncated: aiExtraction.truncated,
          storedTextTruncated: storedExtraction.truncated,
          originalExtractedChars: extraction.text.length,
        },
        classification,
      });
      return;
    }

    if (url.pathname === "/api/integrations/status" && req.method === "GET") {
      const token = await ensureIntegrationToken();
      sendJson(req, res, 200, {
        emailForwarding: {
          endpoint: "/api/integrations/email/inbound",
          enabled: emailForwardingReady(),
          address: emailForwardingAddress,
          signed: Boolean(process.env.NUBE_INBOUND_EMAIL_SECRET),
        },
        webhooks: {
          endpoint: "/api/integrations/webhook/capture",
          enabled: true,
        },
        token,
      });
      return;
    }

    if (url.pathname === "/api/extension/session" && req.method === "GET") {
      const user = await currentUser(req);
      sendJson(req, res, 200, {
        signedIn: Boolean(user),
        user: publicUser(user),
        captureEndpoint: "/api/extension/capture",
        fallbackEndpoint: "/api/integrations/webhook/capture",
      });
      return;
    }

    if (url.pathname === "/api/extension/capture" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        sendJson(req, res, 401, { error: "Sign in to Nube before capturing from the extension." });
        return;
      }
      const capture = await buildWebhookCapture(await readJson(req));
      const result = await appendCapture(capture, user);
      sendJson(req, res, 200, {
        ok: true,
        duplicate: result.duplicate,
        provider: result.capture.provider,
        storage: cloudDatabaseEnabledFor(user) ? "cloud-postgres" : "sqlite",
        capture: result.capture,
      });
      return;
    }

    if (url.pathname === "/api/activity" && req.method === "GET") {
      sendJson(req, res, 200, { activity: await readActivity() });
      return;
    }

    if (url.pathname === "/api/integrations/token/rotate" && req.method === "POST") {
      if (!await currentUser(req)) {
        sendJson(req, res, 401, { error: "Login required." });
        return;
      }
      sendJson(req, res, 200, { token: await rotateIntegrationToken() });
      return;
    }

    if (url.pathname === "/api/integrations/email/inbound" && req.method === "POST") {
      const rawBody = await readBody(req, maxJsonBytes);
      if (!await validateInboundEmailRequest(req, rawBody)) {
        sendJson(req, res, 401, { error: "Invalid or missing Nube integration token." });
        return;
      }
      const capture = await buildForwardedEmailCapture(JSON.parse(rawBody));
      const result = await appendCapture(capture, await currentUser(req));
      sendJson(req, res, 200, {
        ok: true,
        duplicate: result.duplicate,
        provider: result.capture.provider,
        storage: "sqlite",
        capture: result.capture,
      });
      return;
    }

    if (url.pathname === "/api/integrations/webhook/capture" && req.method === "POST") {
      if (!await validateIntegrationToken(req)) {
        sendJson(req, res, 401, { error: "Invalid or missing Nube integration token." });
        return;
      }
      const capture = await buildWebhookCapture(await readJson(req));
      const result = await appendCapture(capture, await currentUser(req));
      sendJson(req, res, 200, {
        ok: true,
        duplicate: result.duplicate,
        provider: result.capture.provider,
        storage: "sqlite",
        capture: result.capture,
      });
      return;
    }

    if (url.pathname === "/api/brain" && req.method === "GET") {
      sendJson(req, res, 200, await readBrainVault(await currentUser(req)));
      return;
    }

    if (url.pathname === "/api/captures/recent" && req.method === "GET") {
      sendJson(req, res, 200, {
        captures: await readRecentCaptures(Number(url.searchParams.get("limit") ?? 30), await currentUser(req)),
      });
      return;
    }

    if (url.pathname === "/api/brain" && req.method === "PUT") {
      sendJson(req, res, 200, await writeBrainVault(await readJson(req), await currentUser(req)));
      return;
    }

    if (url.pathname === "/api/search" && req.method === "GET") {
      sendJson(req, res, 200, await searchBrain(url.searchParams.get("q") ?? "", await currentUser(req)));
      return;
    }

    if (req.method === "GET" && existsSync(distDir)) {
      await serveStatic(req, res);
      return;
    }

    sendJson(req, res, 404, { error: "Not found. Run npm run build to serve the production app." });
  } catch (error) {
    sendJson(req, res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Nube server listening on http://127.0.0.1:${port}`);
  console.log(`AI provider: ${hasAiKey() ? `${aiProvider} (${model})` : "local fallback"}`);
});

