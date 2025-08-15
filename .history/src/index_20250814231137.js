const ORIGIN = 'https://app.truepulse.io'; // Replace with your Lovable origin domain

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Proxy to origin with original path and query
    const originUrl = new URL(url.pathname + url.search, ORIGIN);

    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      body: ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await request.arrayBuffer(),
    };
    init.headers.delete('host');

    // Cache static assets
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    if (
      request.method === 'GET' &&
      (url.pathname.startsWith('/assets/') ||
        url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.js'))
    ) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const resp = await fetch(originUrl.toString(), init);
      const resWithCache = new Response(resp.body, resp);
      resWithCache.headers.set('Cache-Control', 'public, max-age=86400, immutable');
      ctx.waitUntil(cache.put(cacheKey, resWithCache.clone()));
      return resWithCache;
    }

    return fetch(originUrl.toString(), init);
  },
};
