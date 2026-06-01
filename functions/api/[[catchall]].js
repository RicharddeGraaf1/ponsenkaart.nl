// Cloudflare Pages Function — server-side proxy naar OCD-API op Railway.
//
// Doel:
//   1. Cloudflare-edge in het pad → DDoS-bescherming + WAF
//   2. OCD_API_KEY_PUBLIC blijft server-side (niet in HTML zichtbaar)
//   3. Same-origin requests vanuit de browser (geen CORS-config nodig)
//
// Whitelist: alleen ponsenkaart-endpoints + /health worden door-gerouteerd,
// zodat deze proxy niet misbruikt kan worden voor andere OCD-paden.
//
// Caching: via `Cache-Control` response-headers (zie eind van deze handler).
// Bewust géén `caches.default.put` en géén `cf: { cacheTtl }` op de
// upstream-fetch — die twee cache-lagen zijn NIET via zone-Purge-Everything
// te raken (geleerd 2026-06-01 op omgevingsvergunningenregister.nl: foute
// responses bleven uren hangen). Cloudflare's CDN-cache respecteert wel
// `Cache-Control: s-maxage=...` en die IS via zone-dashboard purgebaar.
// Bij data-ververs → Purge Everything en de cache is leeg, eerste user
// vult 'm vers.

const UPSTREAM = 'https://ocd-api-production.up.railway.app';
const ALLOWED_PREFIXES = ['/v1/ponsenkaart', '/health'];

export async function onRequest({ request, env, params }) {
  // params.catchall is array van path-segmenten (bv. ['v1','ponsenkaart','stats'])
  const segments = Array.isArray(params.catchall) ? params.catchall : [params.catchall];
  const upstreamPath = '/' + segments.join('/');

  // Match: exacte gelijkheid (path zelf) of prefix met / erachter (subpath).
  const isAllowed = ALLOWED_PREFIXES.some(prefix =>
    upstreamPath === prefix || upstreamPath.startsWith(prefix + '/')
  );
  if (!isAllowed) {
    return new Response('Not Found', { status: 404 });
  }

  const url = new URL(request.url);
  const upstreamUrl = UPSTREAM + upstreamPath + url.search;

  const upstreamReq = new Request(upstreamUrl, request);
  upstreamReq.headers.set('X-Api-Key', env.OCD_API_KEY_PUBLIC || '');
  upstreamReq.headers.delete('host');
  upstreamReq.headers.delete('cookie');

  const response = await fetch(upstreamReq);

  // Alleen succes-responses GET-cachen. Errors mogen niet maandenlang hangen
  // (al zijn ze nu wel purgebaar — beter is voorkomen).
  if (request.method === 'GET' && response.ok) {
    const headers = new Headers(response.headers);
    // browser: 5 min — refresh-knop voelt snel zonder veel server-druk
    // CDN (CF): 24 h — wekelijkse matview-refresh van OCD ruim binnen dat venster
    // → bij data-update doe je Purge Everything en alle users zien direct vers.
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=86400');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}
