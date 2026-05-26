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

export async function onRequest({ request, env, params, waitUntil }) {
  // params.catchall is array van path-segmenten (bv. ['v1','ponsenkaart','stats'])
  const segments = Array.isArray(params.catchall) ? params.catchall : [params.catchall];
  const upstreamPath = '/' + segments.join('/');

  const isAllowed = ALLOWED_PREFIXES.some(prefix =>
    prefix.endsWith('/') ? upstreamPath.startsWith(prefix) : upstreamPath === prefix
  );
  if (!isAllowed) {
    return new Response('Not Found', { status: 404 });
  }

  // Top-level edge-cache: bij hit slaat Cloudflare deze Function helemaal
  // over en serveert direct van edge. Beschermt de Function-invocation-
  // quota onder DDoS én ontlast Railway.
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  if (request.method === 'GET') {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('x-cache', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: h });
    }
  }

  const url = new URL(request.url);
  const upstreamUrl = UPSTREAM + upstreamPath + url.search;

  const upstreamReq = new Request(upstreamUrl, request);
  upstreamReq.headers.set('X-Api-Key', env.OCD_API_KEY_PUBLIC || '');
  upstreamReq.headers.delete('host');
  upstreamReq.headers.delete('cookie');

  // Subrequest-cache: zelfs bij Function-miss laat dit Cloudflare de
  // upstream-respons cachen, zodat Railway alleen bij echte cache-miss
  // wordt aangesproken.
  const response = await fetch(upstreamReq, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  });

  // Top-level cache vullen voor volgende GETs (alleen succes-responses).
  if (request.method === 'GET' && response.ok) {
    const respToCache = response.clone();
    waitUntil(cache.put(cacheKey, respToCache));
  }

  const h = new Headers(response.headers);
  h.set('x-cache', 'MISS');
  return new Response(response.body, { status: response.status, headers: h });
}
