// Cloudflare Worker for Multi-Tenant Subdomain Routing and Supabase Functions Proxy
// This worker:
// - Proxies app traffic to your ORIGIN (e.g., Vercel deployment)
// - Proxies Supabase Edge Functions via same-origin paths (/functions/v1/*) so cookies can be set/read on *.truepulse.io
//   This fixes cross-domain cookie issues when authenticating via Supabase functions.

const ORIGIN = 'https://:truepulse-mbgriy4wc-poms-projects-b348c3fa.vercel.app'; // Vercel deployment URL
//const ORIGIN = 'https://truepulse-amber.vercel.app'; // Vercel deployment URL
const SUPABASE_FUNCTIONS_BASE = 'https://sqfkemrgfhwdplpqdqhz.supabase.co'; // Supabase project base

// Helper: clone headers but drop hop-by-hop/unsafe ones
function cloneRequestHeaders(request) {
  const incoming = new Headers(request.headers);
  const headers = new Headers();

  // Pass through most headers safely
  for (const [k, v] of incoming.entries()) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length') continue;
    headers.set(k, v);
  }

  return headers;
}

function buildProxyInit(request, extraHeaders = {}) {
  const headers = cloneRequestHeaders(request);

  // Forward original host context for upstream awareness
  const url = new URL(request.url);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

  for (const [k, v] of Object.entries(extraHeaders)) {
    headers.set(k, v);
  }

  const init = {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  };

  return init;
}

async function proxySupabaseFunction(request) {
  const url = new URL(request.url);
  // Preserve the exact function path and query
  const targetUrl = new URL(url.pathname + url.search, SUPABASE_FUNCTIONS_BASE);

  // Build proxied request init
  const init = buildProxyInit(request);

  // Execute upstream call to Supabase function
  const upstream = await fetch(targetUrl.toString(), init);

  // Create a fresh Response, preserving status and body
  const resHeaders = new Headers(upstream.headers);

  // Because this response is same-origin to the browser (*.truepulse.io), any Set-Cookie coming back from Supabase
  // (e.g. "truepulse-auth=...; Domain=.truepulse.io; ...") will now be accepted by the browser.
  // We simply forward headers as-is. If multiple Set-Cookie headers exist, Cloudflare will preserve them.
  // Optionally, we can enforce same-origin CORS (unnecessary for same-origin calls).
  resHeaders.delete('content-length'); // avoid mismatched length after streaming

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders
  });
}

async function proxyOrigin(request) {
  const url = new URL(request.url);
  const originUrl = new URL(url.pathname + url.search, ORIGIN);

  const init = buildProxyInit(request);
  // Cache static assets aggressively
  const cache = caches.default;
  const isStatic = request.method === 'GET' && (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.svg')
  );

  if (isStatic) {
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const resp = await fetch(originUrl.toString(), init);
    const resWithCache = new Response(resp.body, resp);
    resWithCache.headers.set('Cache-Control', 'public, max-age=86400, immutable');
    await cache.put(cacheKey, resWithCache.clone());
    return resWithCache;
  }

  // Non-static proxy
  try {
    return await fetch(originUrl.toString(), init);
  } catch (error) {
    console.error('Upstream fetch failed:', error);
    return new Response('Service Unavailable', { status: 503 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Same-origin proxy for Supabase Edge Functions:
    //    Any request to /functions/v1/* will be proxied to Supabase Functions.
    //    This ensures Set-Cookie from the function will be accepted by the browser as it now originates from *.truepulse.io
    if (url.pathname.startsWith('/functions/v1/')) {
      return proxySupabaseFunction(request);
    }

    // 2) Default: Proxy app traffic to ORIGIN (Vercel deployment)
    return proxyOrigin(request);
  },
};

/*
USAGE AND INTEGRATION NOTES:

- Frontend should call same-origin endpoints instead of Supabase domain directly:
  Replace:
    fetch('https://sqfkemrgfhwdplpqdqhz.supabase.co/functions/v1/generate-auth-jwt', ...)
    fetch('https://sqfkemrgfhwdplpqdqhz.supabase.co/functions/v1/api-me', ...)
    fetch('https://sqfkemrgfhwdplpqdqhz.supabase.co/functions/v1/revoke-session', ...)
  With:
    fetch('/functions/v1/generate-auth-jwt', { credentials: 'include', ... })
    fetch('/functions/v1/api-me', { credentials: 'include', ... })
    fetch('/functions/v1/revoke-session', { credentials: 'include', ... })

- Why this works:
  The browser will accept Set-Cookie on *.truepulse.io only if the response comes from *.truepulse.io.
  By proxying through this Worker (which runs on *.truepulse.io), the Supabase function's Set-Cookie header now
  originates from the correct domain, so your JWT cookie is stored successfully and sent on subsequent same-origin requests.

- Next step after deploying this worker:
  Update the frontend fetch URLs to use the same-origin paths as shown above.

- Cloudflare Routing:
  - Point *.truepulse.io/* to this Worker
  - Ensure your apex/subdomains resolve through Cloudflare to the Worker
*/