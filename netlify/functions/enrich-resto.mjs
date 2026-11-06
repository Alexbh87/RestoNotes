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
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return json(503, { error: "OPENAI_API_KEY is not configured in Netlify" });

  try {
    const input = JSON.parse(event.body || "{}");
    const { photo, name = "", address = "", city = "", type = "", findMenu = false } = input;
    let imageContent = null;
    if (photo && !findMenu) {
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return json(400, { error: "Unsupported image format" });
      imageContent = { type: "input_image", image_url: photo, detail: "low" };
    }

    const query = [name, address, city].filter(Boolean).join(", ");
    const task = findMenu
      ? `Find the restaurant's official/current online menu. Restaurant: ${query}. Type: ${type}. Use web search. Return JSON only: {"menuUrl":"the best direct menu URL or empty string","menuText":"short useful summary only if reliably available"}.`
      : `Identify the restaurant category from the photo if possible (e.g. Japanese, Italian, tapas, French, Mexican, seafood, brunch). If the photo is not sufficient, say empty. If a restaurant name is visible, transcribe it. Use web search only if a name/location is provided to verify details. Return JSON only: {"type":"short category in French or empty","name":"visible/verified restaurant name or empty","website":"official website or empty"}.`;

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

    // Find a polished exterior photo using Google Places when its key is configured.
    if (!findMenu && process.env.GOOGLE_MAPS_API_KEY && (result.name || name)) {
      const placeQuery = [result.name || name, address, city].filter(Boolean).join(", ");
      const p = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "places.displayName,places.photos"
        },
        body: JSON.stringify({ textQuery: placeQuery, maxResultCount: 1 })
      });
      if (p.ok) {
        const pd = await p.json();
        const photoName = pd.places?.[0]?.photos?.[0]?.name;
        if (photoName) result.facadeImageUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1000&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      }
    }
    return json(200, result);
  } catch (err) {
    return json(500, { error: "Enrichment failed", detail: String(err?.message || err) });
  }
}
