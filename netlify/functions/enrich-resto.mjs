// Netlify Function : enrichissement IA / Google Places pour RestoNotes.
// Variables d'environnement Netlify :
//   OPENAI_API_KEY        (obligatoire pour la lecture de façade et la recherche de menu)
//   GOOGLE_PLACES_API_KEY (recommandé : recherche de fiche + photos de façade)
//   OPENAI_MODEL          (optionnel, défaut : gpt-4.1-mini)
//   ALLOWED_ORIGINS       (optionnel : origines supplémentaires autorisées, séparées par des virgules)
//
// Sécurité :
//  - la clé Google Places ne part JAMAIS vers le navigateur : les photos passent par ?photo=… (proxy) ;
//  - les appels POST ne sont acceptés que depuis l'application elle-même (même origine) ;
//  - limite de requêtes par IP (en mémoire : elle protège pendant la vie d'une instance, pas un blocage global).

const TYPE_MAP = {
  italian_restaurant: "Italien", pizza_restaurant: "Pizzeria", japanese_restaurant: "Japonais",
  sushi_restaurant: "Japonais – Sushi", chinese_restaurant: "Chinois", indian_restaurant: "Indien",
  mexican_restaurant: "Mexicain", french_restaurant: "Français", thai_restaurant: "Thaïlandais",
  vietnamese_restaurant: "Vietnamien", korean_restaurant: "Coréen", spanish_restaurant: "Espagnol – Tapas",
  mediterranean_restaurant: "Méditerranéen", seafood_restaurant: "Fruits de mer", steak_house: "Steakhouse",
  hamburger_restaurant: "Burger", vegan_restaurant: "Végétarien / Vegan", vegetarian_restaurant: "Végétarien",
  lebanese_restaurant: "Libanais", middle_eastern_restaurant: "Libanais",
  cafe: "Café / Brunch", bakery: "Boulangerie / Café", bar: "Bar à tapas"
};

const PLACE_FIELDS_LOOKUP = "places.id,places.displayName,places.primaryType,places.types,places.websiteUri,places.photos,places.formattedAddress,places.addressComponents,places.primaryTypeDisplayName,places.location,places.googleMapsUri";
const PLACE_FIELDS_VERIFY = "places.displayName,places.primaryType,places.types,places.websiteUri,places.photos,places.formattedAddress";
const PHOTO_REF = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
const MAX_PHOTO_CHARS = 4_000_000; // ~3 Mo d'image en base64

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  body: JSON.stringify(body)
});

const clean = (value, max = 200) => String(value ?? "").slice(0, max).trim();
const httpUrl = (value) => (/^https?:\/\//i.test(String(value || "")) ? String(value).slice(0, 500) : "");
const header = (event, name) => event.headers?.[name] ?? event.headers?.[name.toLowerCase()] ?? "";
const photoProxy = (photoName) => "/.netlify/functions/enrich-resto?photo=" + encodeURIComponent(photoName);
const pickType = (place) => TYPE_MAP[[place.primaryType, ...(place.types || [])].find((t) => TYPE_MAP[t])] || "";

/* ---------- protection : même origine + limite de débit ---------- */
function isSameOrigin(event) {
  const site = header(event, "sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = header(event, "origin");
  if (!origin) return false; // un POST de navigateur envoie toujours Origin ; curl & co sont refusés
  try {
    const host = new URL(origin).host;
    const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    return host === header(event, "host") || extra.includes(origin);
  } catch { return false; }
}

const buckets = new Map();
function rateLimited(event, limit, scope) {
  const ip = header(event, "x-nf-client-connection-ip") || String(header(event, "x-forwarded-for")).split(",")[0].trim() || "unknown";
  const key = scope + ":" + ip;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    if (buckets.size > 2000) buckets.clear();
    buckets.set(key, { count: 1, reset: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

/* ---------- arrondissement / quartier ---------- */
function extractDistrict(place) {
  const components = place.addressComponents || [];
  const hasType = (c, list) => (c.types || []).some((t) => list.includes(t));
  const districtComponent = components.find((c) =>
    hasType(c, ["neighborhood", "sublocality", "sublocality_level_1", "sublocality_level_2", "administrative_area_level_3"]));
  const districtParts = components
    .filter((c) => hasType(c, ["sublocality", "sublocality_level_1", "sublocality_level_2", "administrative_area_level_3"]))
    .flatMap((c) => [c.longText, c.shortText]).filter(Boolean);
  const postalCode = components.find((c) => (c.types || []).includes("postal_code"))?.longText || "";
  const text = [place.formattedAddress, ...districtParts].filter(Boolean).join(" ");

  let n = null;
  const named = text.match(/(?:^|\D)(\d{1,2})\s*(?:er|e|ème|eme)?\s*arrondissement|arrondissement\s*(?:de\s*paris\s*)?(\d{1,2})/i);
  if (named) n = Number(named[1] || named[2]);
  if (!n && /^750(?:0[1-9]|1[0-9]|20)$/.test(postalCode)) n = Number(postalCode.slice(-2)); // Paris
  if (!n && /^6900[1-9]$/.test(postalCode)) n = Number(postalCode.slice(-1));                // Lyon
  if (!n && /^130(?:0[1-9]|1[0-6])$/.test(postalCode)) n = Number(postalCode.slice(-2));     // Marseille
  if (n) return n === 1 ? "1er arrondissement" : n + "e arrondissement";
  return districtComponent?.longText || districtComponent?.shortText || "";
}

/* ---------- Google Places ---------- */
async function searchPlaces(body, fieldMask) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": fieldMask
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function proxyPhoto(event) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return json(503, { error: "GOOGLE_PLACES_API_KEY is not configured" });
  if (rateLimited(event, 120, "photo")) return json(429, { error: "Too many requests" });
  const resource = event.queryStringParameters.photo;
  if (!PHOTO_REF.test(resource)) return json(400, { error: "Invalid photo reference" });
  const res = await fetch(`https://places.googleapis.com/v1/${resource}/media?maxWidthPx=1000&key=${process.env.GOOGLE_PLACES_API_KEY}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return json(502, { error: "Google Places photo unavailable" });
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    statusCode: 200,
    headers: { "Content-Type": res.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" },
    body: bytes.toString("base64"),
    isBase64Encoded: true
  };
}

async function lookupRestaurant({ name, city }) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return json(503, { error: "GOOGLE_PLACES_API_KEY is not configured in Netlify" });
  const q = [name, city].filter(Boolean).join(", ");
  const { ok, data } = await searchPlaces({ textQuery: q, maxResultCount: 1 }, PLACE_FIELDS_LOOKUP);
  if (!ok) return json(502, { error: data.error?.message || "Google Places search failed" });
  const place = data.places?.[0];
  if (!place) return json(200, { name: "" });
  const photoName = place.photos?.[0]?.name;
  return json(200, {
    name: place.displayName?.text || name,
    address: place.formattedAddress || "",
    type: pickType(place) || place.primaryTypeDisplayName?.text || "",
    district: extractDistrict(place),
    website: httpUrl(place.websiteUri),
    photo: photoName ? photoProxy(photoName) : "",
    lat: place.location?.latitude ?? null,
    lon: place.location?.longitude ?? null,
    mapsUrl: httpUrl(place.googleMapsUri)
  });
}

/* ---------- OpenAI ---------- */
async function askOpenAI({ task, imageContent, useWebSearch }) {
  const content = [{ type: "input_text", text: task }];
  if (imageContent) content.push(imageContent);
  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [{ role: "user", content }],
    text: { format: { type: "json_object" } },
    ...(useWebSearch ? { tools: [{ type: "web_search" }] } : {})
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000)
  });
  const ai = await res.json().catch(() => ({}));
  if (!res.ok) return { error: ai.error?.message || "OpenAI request failed" };
  const text = (ai.output || []).flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("\n");
  try { return { result: JSON.parse(text) }; } catch { return { result: {} }; }
}

export async function handler(event) {
  // Application servie depuis la même origine : aucun en-tête CORS nécessaire.
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: {} };
  try {
    if (event.httpMethod === "GET" && event.queryStringParameters?.photo) return await proxyPhoto(event);
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    if (!isSameOrigin(event)) return json(403, { error: "Forbidden" });
    if (rateLimited(event, 20, "post")) return json(429, { error: "Trop de requêtes, réessaie dans une minute." });

    const input = JSON.parse(event.body || "{}");
    const name = clean(input.name), address = clean(input.address), city = clean(input.city), type = clean(input.type, 80);
    const findMenu = input.findMenu === true;
    const photo = typeof input.photo === "string" ? input.photo : "";

    if (input.lookup === true) return await lookupRestaurant({ name, city });

    if (!process.env.OPENAI_API_KEY) return json(503, { error: "OPENAI_API_KEY is not configured in Netlify" });

    let imageContent = null;
    if (photo && !findMenu) {
      if (photo.length > MAX_PHOTO_CHARS) return json(413, { error: "Image too large" });
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return json(400, { error: "Unsupported image format" });
      imageContent = { type: "input_image", image_url: photo, detail: "high" };
    }

    const query = [name, address, city].filter(Boolean).join(", ");
    const task = findMenu
      ? `Find the restaurant's official/current online menu. Restaurant: ${query}. Type: ${type}. Use web search. Return JSON only: {"menuUrl":"the best direct menu URL or empty string","menuText":"short useful summary only if reliably available"}.`
      : `This is a live photo taken directly in front of a restaurant. Carefully read the business name from the sign or facade (OCR). Do not guess the cuisine from architecture or decor. If the cuisine is explicitly stated on the sign, you may return it; otherwise leave type empty so it can be verified using Google Places. If a name is visible, transcribe it exactly. Return JSON only: {"name":"business name read from the facade or empty","type":"cuisine/category explicitly evident from the facade or empty","website":""}.`;

    const ai = await askOpenAI({ task, imageContent, useWebSearch: findMenu });
    if (ai.error) return json(502, { error: ai.error });
    const raw = ai.result || {};

    if (findMenu) return json(200, { menuUrl: httpUrl(raw.menuUrl), menuText: clean(raw.menuText, 1500) });

    const result = { name: clean(raw.name), type: clean(raw.type, 80), website: httpUrl(raw.website) };

    // Vérifie le nom lu sur l'enseigne avec Google Places (biais GPS de la photo si disponible).
    if (process.env.GOOGLE_PLACES_API_KEY && (result.name || name)) {
      const lat = Number(input.lat), lon = Number(input.lon);
      const hasGps = input.lat != null && input.lon != null && Number.isFinite(lat) && Number.isFinite(lon);
      const { ok, data } = await searchPlaces({
        textQuery: [result.name || name, address, city].filter(Boolean).join(", "),
        maxResultCount: 3,
        ...(hasGps ? { locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 250 } } } : {})
      }, PLACE_FIELDS_VERIFY).catch(() => ({ ok: false, data: {} }));
      const place = ok ? data.places?.[0] : null;
      if (place) {
        const googleType = pickType(place);
        if (googleType) result.type = googleType;
        if (place.websiteUri) result.website = httpUrl(place.websiteUri);
        if (place.displayName?.text && !result.name) result.name = place.displayName.text;
        const photoName = place.photos?.[0]?.name;
        // URL relative via le proxy : la clé Google n'est jamais exposée au navigateur.
        if (photoName) result.facadeImageUrl = photoProxy(photoName);
      }
    }
    return json(200, result);
  } catch (err) {
    return json(500, { error: "Enrichment failed", detail: String(err?.message || err) });
  }
}
