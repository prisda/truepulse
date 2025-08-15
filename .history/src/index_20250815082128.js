export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const originalHost = incomingUrl.host; // e.g., foo.truepulse.io

    // Always send to your Netlify site
    const targetUrl = new URL(request.url);
    targetUrl.hostname = 'truepulse.netlify.app';

    // Forward request
    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      redirect: 'manual'
    };
    // Remove Host so fetch sets it to truepulse.netlify.app
    init.headers.delete('host');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    const resp = await fetch(new Request(targetUrl.toString(), init));

    // Rewrite Location headers on redirects so browser stays on the original subdomain
    const newHeaders = new Headers(resp.headers);
    const location = newHeaders.get('location');
    if (location) {
      const locUrl = new URL(location, targetUrl);
      if (locUrl.hostname === 'truepulse.netlify.app') {
        locUrl.hostname = originalHost; // keep user on foo.truepulse.io
        newHeaders.set('location', locUrl.toString());
      }
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: newHeaders
    });
  }
};
