// Public browser configuration for Google Maps JavaScript API.
// The key is stored as a Netlify environment variable and must be restricted
// in Google Cloud to the app's HTTP referrers and required APIs.
export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return { statusCode: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "GOOGLE_MAPS_API_KEY is not configured" }) };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ key })
  };
}
