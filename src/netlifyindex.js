export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const originalHost = incoming.host;              // e.g., foo.truepulse.io
    const sub = originalHost.split('.')[0];          // foo (if you need it later)

    // Forward everything to your single Netlify site
    const target = new URL(request.url);
    target.hostname = 'truepulse.netlify.app';

    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      redirect: 'manual'
    };
    // Ensure origin Host is set by fetch, not the incoming host
    init.headers.delete('host');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    const resp = await fetch(new Request(target.toString(), init));

    // Keep user on the same subdomain for redirects
    const headers = new Headers(resp.headers);
    const loc = headers.get('location');
    if (loc) {
      const u = new URL(loc, target);
      if (u.hostname === 'truepulse.netlify.app') {
        u.hostname = originalHost;
        headers.set('location', u.toString());
      }
    }

    return new Response(resp.body, { status: resp.status, headers });
  }
};
