// Middleware op alle requests: forceer canonical hostname (bare apex).
// Vervangt een Cloudflare Single-Redirect-rule die we niet via API
// konden zetten (token mist Zone Config Rules:Edit scope).
//
// www.ponsenkaart.nl/<path> -> 301 -> https://ponsenkaart.nl/<path>

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === 'www.ponsenkaart.nl') {
    url.hostname = 'ponsenkaart.nl';
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
