// src/index.js
const ORIGIN = 'www.truepulse.io'; // or your Lovable origin

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originUrl = new URL(url.pathname + url.search, ORIGIN);

    const headers = new Headers(request.headers);
    // Preserve original host for SSR or logging
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

    const init = {
      method: request.method,
      headers,
      body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    };

    // Cache typical Next/Vite assets
    const cache = caches.default;
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
      const key = new Request(url.toString(), { method: 'GET' });
      const hit = await cache.match(key);
      if (hit) return hit;
      const resp = await fetch(originUrl, init);
      const res = new Response(resp.body, resp);
      res.headers.set('Cache-Control', 'public, max-age=86400, immutable');
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    return fetch(originUrl, init);
  },
};
