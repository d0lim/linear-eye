import type { Env } from '../env';

export async function handleAssets(request: Request, env: Env): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/app') {
    return Response.redirect(new URL('/app/', url).href, 308);
  }
  if (!env.ASSETS) return new Response('Dashboard assets are unavailable', { status: 503 });
  url.pathname = url.pathname.slice('/app'.length);
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const response = new Response(asset.body, asset);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  if (response.headers.get('Content-Type')?.includes('text/html')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  return response;
}
