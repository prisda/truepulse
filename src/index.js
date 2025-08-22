// Cloudflare Worker for Multi-Tenant Subdomain Routing and Supabase Functions Proxy
// This worker:
// - Detects tenant subdomains server-side before proxying
// - Validates tenants against Supabase and injects headers for client-side use
// - Proxies app traffic to your ORIGIN (e.g., Vercel deployment)
// - Proxies Supabase Edge Functions via same-origin paths (/functions/v1/*) so cookies can be set/read on *.truepulse.io
//   This fixes cross-domain cookie issues when authenticating via Supabase functions.

const ORIGIN = 'https://truepulse-amber.vercel.app'; // Vercel deployment URL
const SUPABASE_FUNCTIONS_BASE = 'https://sqfkemrgfhwdplpqdqhz.supabase.co'; // Supabase project base
const SUPABASE_URL = 'https://sqfkemrgfhwdplpqdqhz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZmtlbXJnZmh3ZHBscHFkcWh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQ0NDM1NjIsImV4cCI6MjA1MDAxOTU2Mn0.HDcyeDZKnLxtv4LFo8IXpRUcpwbLs1QfCJ3x6KG2J0Y'; // Public anon key

// Reserved/apex domains that should route to main app
const APEX_DOMAINS = ['www', 'truepulse', 'app', 'admin', 'api'];

// Tenant validation cache (in-memory, expires every 5 minutes)
const TENANT_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Extract tenant from hostname
function extractTenant(hostname) {
  const parts = hostname.toLowerCase().split('.');
  
  // Skip localhost and development domains
  if (hostname.includes('localhost') || hostname.includes('127.0.0.1') || hostname.includes('192.168.')) {
    return { subdomain: null, isApex: true };
  }
  
  // Get subdomain (first part)
  const subdomain = parts[0];
  
  // Check if apex domain - www.truepulse.io is treated as apex for authentication
  const isApex = subdomain === 'truepulse' || 
                subdomain === 'www' ||
                APEX_DOMAINS.includes(subdomain) || 
                parts.length < 3;
  
  // Valid tenant needs at least 3 characters and not be reserved
  const validTenant = !isApex && subdomain && subdomain.length >= 3 && !APEX_DOMAINS.includes(subdomain);
  
  return {
    subdomain: validTenant ? subdomain : null,
    isApex,
    raw: subdomain
  };
}

// Validate tenant against Supabase with caching
async function validateTenant(subdomain) {
  if (!subdomain) return { isValid: false, orgName: null, orgId: null };
  
  // Check cache first
  const cacheKey = `tenant_${subdomain}`;
  const cached = TENANT_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  try {
    // Check domain alias first
    const aliasResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_domain_alias`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ _alias_domain: subdomain })
    });
    
    let targetSlug = subdomain;
    if (aliasResponse.ok) {
      const aliasData = await aliasResponse.text();
      if (aliasData && aliasData !== 'null') {
        targetSlug = aliasData.replace(/"/g, ''); // Remove quotes
      }
    }
    
    // Validate org exists with public boards
    const orgResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_org_by_slug`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ _slug: targetSlug })
    });
    
    if (orgResponse.ok) {
      const orgData = await orgResponse.json();
      const result = {
        isValid: orgData && orgData.length > 0,
        orgName: orgData && orgData.length > 0 ? orgData[0].org_name : null,
        orgId: orgData && orgData.length > 0 ? orgData[0].org_id : null,
        resolvedSlug: targetSlug
      };
      
      // Cache result
      TENANT_CACHE.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });
      
      return result;
    }
  } catch (error) {
    console.error('Tenant validation error:', error);
  }
  
  // Default to invalid
  const result = { isValid: false, orgName: null, orgId: null };
  TENANT_CACHE.set(cacheKey, {
    data: result,
    timestamp: Date.now()
  });
  
  return result;
}

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

// Add tenant context headers to response
function addTenantHeaders(response, tenantInfo) {
  const newResponse = new Response(response.body, response);
  
  if (tenantInfo.subdomain) {
    newResponse.headers.set('X-Tenant-Slug', tenantInfo.subdomain);
    newResponse.headers.set('X-Tenant-Valid', tenantInfo.isValid ? 'true' : 'false');
    
    if (tenantInfo.isValid) {
      newResponse.headers.set('X-Tenant-Name', tenantInfo.orgName || '');
      newResponse.headers.set('X-Tenant-ID', tenantInfo.orgId || '');
      if (tenantInfo.resolvedSlug && tenantInfo.resolvedSlug !== tenantInfo.subdomain) {
        newResponse.headers.set('X-Tenant-Resolved-Slug', tenantInfo.resolvedSlug);
      }
    }
  } else {
    newResponse.headers.set('X-Tenant-Apex', 'true');
  }
  
  return newResponse;
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
    const hostname = url.hostname;

    // Extract tenant information from hostname
    const tenantInfo = extractTenant(hostname);
    
    // Validate tenant if subdomain exists
    let validationResult = { isValid: false, orgName: null, orgId: null };
    if (tenantInfo.subdomain) {
      validationResult = await validateTenant(tenantInfo.subdomain);
    }

    // Combine tenant info with validation
    const fullTenantInfo = {
      ...tenantInfo,
      ...validationResult
    };

    // 1) Same-origin proxy for Supabase Edge Functions:
    //    Any request to /functions/v1/* will be proxied to Supabase Functions.
    //    This ensures Set-Cookie from the function will be accepted by the browser as it now originates from *.truepulse.io
    if (url.pathname.startsWith('/functions/v1/')) {
      const response = await proxySupabaseFunction(request);
      return addTenantHeaders(response, fullTenantInfo);
    }

    // 2) Handle invalid tenants - redirect to main site
    if (tenantInfo.subdomain && !validationResult.isValid) {
      console.log(`❌ Invalid tenant detected: ${tenantInfo.subdomain}, redirecting to main site`);
      return Response.redirect('https://www.truepulse.io/', 302);
    }

    // 3) Default: Proxy app traffic to ORIGIN (Vercel deployment) with tenant headers
    const response = await proxyOrigin(request);
    return addTenantHeaders(response, fullTenantInfo);
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
