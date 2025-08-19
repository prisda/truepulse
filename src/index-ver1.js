// src/index.js
const ORIGIN = 'https://truepulse-amber.vercel.app'; // MUST include https://

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const originBase = new URL(ORIGIN); // validate early
      const originUrl = new URL(url.pathname + url.search, originBase);

      const headers = new Headers(request.headers);
      // Don't forward the original Host; Vercel expects its own
      headers.delete('host');
      // Pass through context for your app if needed
      headers.set('X-Forwarded-Host', url.host);
      headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

      const init = {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
      };

      // Static asset caching (Next/Vite)
      const isStatic =
        request.method === 'GET' &&
        (url.pathname.startsWith('/_next/') ||
         url.pathname.startsWith('/assets/') ||
         url.pathname.endsWith('.css') ||
         url.pathname.endsWith('.js') ||
         url.pathname.endsWith('.ico') ||
         url.pathname.endsWith('.png') ||
         url.pathname.endsWith('.jpg') ||
         url.pathname.endsWith('.webp') ||
         url.pathname.endsWith('.svg'));

      if (isStatic) {
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) return cached;

        const resp = await fetch(originUrl, init);
        const res = new Response(resp.body, resp);
        res.headers.set('Cache-Control', 'public, max-age=86400, immutable');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }

      // Proxy everything else
      return await fetch(originUrl, init);
    } catch (err) {
      // Log to Worker logs for debugging
      console.error('Worker error:', err?.stack || err);
      return new Response('Upstream proxy error', { status: 502 });
    }
  },
};
