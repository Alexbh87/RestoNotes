// Netlify Function: AI enrichment for RestoNotes.
// Configure OPENAI_API_KEY in Netlify environment variables.
// Optional: GOOGLE_MAPS_API_KEY enables a real Google Places facade photo.
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body)
});

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  // Proxy Google Places photo bytes so the private Google API key is never exposed in the browser.
  if (event.httpMethod === "GET" && event.queryStringParameters?.photo) {
    if (!process.env.GOOGLE_MAPS_API_KEY) return json(503, { error: "GOOGLE_MAPS_API_KEY is not configured" });
    const resource = event.queryStringParameters.photo;
    if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(resource)) return json(400, { error: "Invalid photo reference" });
    const photoRes = await fetch(`https://places.googleapis.com/v1/${resource}/media?maxWidthPx=1000&key=${process.env.GOOGLE_MAPS_API_KEY}`);
    if (!photoRes.ok) return json(502, { error: "Google Places photo unavailable" });
    const bytes = Buffer.from(await photoRes.arrayBuffer());
    return { statusCode: 200, headers: { "Content-Type": photoRes.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" }, body: bytes.toString("base64"), isBase64Encoded: true };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return json(503, { error: "OPENAI_API_KEY is not configured in Netlify" });

  try {
    const input = JSON.parse(event.body || "{}");
    const { photo, name = "", address = "", city = "", type = "", findMenu = false } = input;
    let imageContent = null;
    if (photo && !findMenu) {
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return json(400, { error: "Unsupported image format" });
      imageContent = { type: "input_image", image_url: photo, detail: "high" };
    }

    const query = [name, address, city].filter(Boolean).join(", ");
    const task = findMenu
      ? `Find the restaurant's official/current online menu. Restaurant: ${query}. Type: ${type}. Use web search. Return JSON only: {"menuUrl":"the best direct menu URL or empty string","menuText":"short useful summary only if reliably available"}.`
      : `This is a live photo taken directly in front of a restaurant. Carefully read the business name from the sign or facade (OCR). Do not guess the cuisine from architecture or decor. If the cuisine is explicitly stated on the sign, you may return it; otherwise leave type empty so it can be verified using Google Places. If a name is visible, transcribe it exactly. Return JSON only: {"name":"business name read from the facade or empty","type":"cuisine/category explicitly evident from the facade or empty","website":""}.`;

    const content = [{ type: "input_text", text: task }];
    if (imageContent) content.push(imageContent);
    const payload = {
      model: "gpt-4.1-mini",
      input: [{ role: "user", content }],
      tools: [{ type: "web_search" }],
      text: { format: { type: "json_object" } }
    };
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const ai = await aiRes.json();
    if (!aiRes.ok) return json(502, { error: ai.error?.message || "OpenAI request failed" });
    const outputText = (ai.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
    let result = {};
    try { result = JSON.parse(outputText); } catch { result = {}; }

    // Vérifie le nom lu sur l'enseigne avec Google Places, en privilégiant la position GPS de la photo.
    if (!findMenu && process.env.GOOGLE_MAPS_API_KEY && (result.name || name)) {
      const placeQuery = [result.name || name, address, city].filter(Boolean).join(", ");
      const locationBias = Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lon))
        ? { circle: { center: { latitude: Number(input.lat), longitude: Number(input.lon) }, radius: 250 } }
        : undefined;
      const p = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "places.displayName,places.primaryType,places.types,places.websiteUri,places.photos,places.formattedAddress"
        },
        body: JSON.stringify({ textQuery: placeQuery, maxResultCount: 3, ...(locationBias ? { locationBias } : {}) })
      });
      if (p.ok) {
        const pd = await p.json();
        const candidates = pd.places || [];
        const place = candidates[0];
        if (place) {
          const typeMap = {
            italian_restaurant: "Italien", pizza_restaurant: "Pizzeria", japanese_restaurant: "Japonais",
            sushi_restaurant: "Japonais – Sushi", chinese_restaurant: "Chinois", indian_restaurant: "Indien",
            mexican_restaurant: "Mexicain", french_restaurant: "Français", thai_restaurant: "Thaïlandais",
            vietnamese_restaurant: "Vietnamien", korean_restaurant: "Coréen", spanish_restaurant: "Espagnol – Tapas",
            mediterranean_restaurant: "Méditerranéen", seafood_restaurant: "Fruits de mer", steak_house: "Steakhouse",
            hamburger_restaurant: "Burger", vegan_restaurant: "Végétarien / Vegan", vegetarian_restaurant: "Végétarien",
            cafe: "Café / Brunch", bakery: "Boulangerie / Café", bar: "Bar à tapas"
          };
          const googleType = place.primaryType || (place.types || []).find(t => typeMap[t]);
          if (googleType && typeMap[googleType]) result.type = typeMap[googleType];
          if (place.websiteUri) result.website = place.websiteUri;
          if (place.displayName?.text && !result.name) result.name = place.displayName.text;
          const photoName = place.photos?.[0]?.name;
          if (photoName) result.facadeImageUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1000&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        }
      }
    }
    return json(200, result);
  } catch (err) {
    return json(500, { error: "Enrichment failed", detail: String(err?.message || err) });
  }
}
