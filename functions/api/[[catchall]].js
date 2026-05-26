// Cloudflare Pages Function — server-side proxy naar OCD-API op Railway.
//
// Doel:
//   1. Cloudflare-edge in het pad → DDoS-bescherming + WAF + edge-cache
//   2. OCD_API_KEY_PUBLIC blijft server-side (niet in HTML zichtbaar)
//   3. Same-origin requests vanuit de browser (geen CORS-config nodig)
//
// Whitelist: alleen ponsenkaart-endpoints + /health worden door-gerouteerd,
// zodat deze proxy niet misbruikt kan worden voor andere OCD-paden.

const UPSTREAM = 'https://ocd-api-production.up.railway.app';
const ALLOWED_PREFIXES = ['/v1/ponsenkaart/', '/health'];

export async function onRequest({ request, env, params }) {
  // params.catchall is array van path-segmenten (bv. ['v1','ponsenkaart','stats'])
  const segments = Array.isArray(params.catchall) ? params.catchall : [params.catchall];
  const upstreamPath = '/' + segments.join('/');

  const isAllowed = ALLOWED_PREFIXES.some(prefix =>
    prefix.endsWith('/') ? upstreamPath.startsWith(prefix) : upstreamPath === prefix
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

  // Cloudflare cachet automatisch op basis van Cache-Control headers
  // die de OCD-API meestuurt (s-maxage=86400 voor ponsenkaart-endpoints).
  return fetch(upstreamReq);
}
