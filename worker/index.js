// Drive Notes: the one server piece. It holds the Google client secret so that the app, a static site,
// can use the authorization code flow: the code from the login popup becomes an access token (an hour)
// and a refresh token (until revoked), and the refresh token renews the access token with no window.
// Stateless: nothing is stored, nothing is logged. Deploy by hand: `npx wrangler deploy` in this folder
// (see SETUP.md). The secret lives in Cloudflare (`wrangler secret put GOOGLE_CLIENT_SECRET`), never here.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Only the app may call: the published one, and a local copy for development
const ORIGINS = ['https://agathagio.github.io', 'http://localhost:8000'];
const GRANTS = ['authorization_code', 'refresh_token'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: 'invalid_request' }, 400, origin);
    }
    if (!body || !GRANTS.includes(body.grant_type)) return reply({ error: 'unsupported_grant_type' }, 400, origin);

    const form = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: body.grant_type,
    });
    if (body.grant_type === 'authorization_code') {
      if (typeof body.code !== 'string' || !body.code) return reply({ error: 'invalid_request' }, 400, origin);
      form.set('code', body.code);
      form.set('redirect_uri', 'postmessage'); // what the Google Identity Services popup uses
    } else {
      if (typeof body.refresh_token !== 'string' || !body.refresh_token) return reply({ error: 'invalid_request' }, 400, origin);
      form.set('refresh_token', body.refresh_token);
    }

    const google = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    // Google's answer as it came, status included: the app reads invalid_grant from it
    return new Response(await google.text(), {
      status: google.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  },
};
