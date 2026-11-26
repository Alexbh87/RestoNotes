// Configuration publique pour Google Maps JavaScript API.
// Une clé Maps JS est forcément visible dans le navigateur : elle DOIT être restreinte
// dans Google Cloud (référents HTTP = ton domaine Netlify, et uniquement « Maps JavaScript API »).
// Cette clé doit être différente de GOOGLE_PLACES_API_KEY (qui, elle, reste côté serveur).
const respond = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

export async function handler(event) {
  if (event.httpMethod !== "GET") return respond(405, { error: "Method not allowed" });
  const site = event.headers?.["sec-fetch-site"];
  if (site && site !== "same-origin") return respond(403, { error: "Forbidden" });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return respond(503, { error: "GOOGLE_MAPS_API_KEY is not configured" });
  return respond(200, { key });
}
