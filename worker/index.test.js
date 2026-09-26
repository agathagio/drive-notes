// The Worker against a faked Google: no network. `npm run test:worker`, or as part of `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const env = { GOOGLE_CLIENT_ID: 'id-123', GOOGLE_CLIENT_SECRET: 'shh' };
const APP = 'https://agathagio.github.io';

/** One request through the Worker. Google is faked behind global fetch: it answers `answer` with `status`
    and every call is recorded with the form it received. */
async function call({ method = 'POST', origin = APP, body, answer = { access_token: 'tok', expires_in: 3600 }, status = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(opts.body)) });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const request = new Request('https://drive-notes-auth.example.workers.dev/', {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const response = await worker.fetch(request, env);
  return { response, calls };
}

test('preflight from the app origin answers the CORS headers and never reaches Google', async () => {
  const { response, calls } = await call({ method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal(calls.length, 0);
});

test('another origin is refused', async () => {
  const { response, calls } = await call({ origin: 'https://evil.example', body: { grant_type: 'refresh_token', refresh_token: 'r' } });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('a grant type that is not ours is refused', async () => {
  const { response, calls } = await call({ body: { grant_type: 'password', username: 'x' } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'unsupported_grant_type');
  assert.equal(calls.length, 0);
});

test('a body that is not JSON is refused', async () => {
  const { response, calls } = await call({ body: 'not json' });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('a code becomes a token request with the secret and redirect_uri=postmessage', async () => {
  const { response, calls } = await call({
    body: { grant_type: 'authorization_code', code: 'c1' },
    answer: { access_token: 'tok', expires_in: 3600, refresh_token: 'r1' },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(calls[0].form, {
    client_id: 'id-123', client_secret: 'shh', grant_type: 'authorization_code', code: 'c1', redirect_uri: 'postmessage',
  });
  assert.equal((await response.json()).refresh_token, 'r1');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP);
});

test('a refresh token becomes a refresh request, and Google\'s error passes through with its status', async () => {
  const { response, calls } = await call({
    body: { grant_type: 'refresh_token', refresh_token: 'r1' },
    answer: { error: 'invalid_grant' },
    status: 400,
  });
  assert.deepEqual(calls[0].form, { client_id: 'id-123', client_secret: 'shh', grant_type: 'refresh_token', refresh_token: 'r1' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_grant');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP);
});

test('a code without the code, or a refresh without the token, is refused before Google', async () => {
  const a = await call({ body: { grant_type: 'authorization_code' } });
  const b = await call({ body: { grant_type: 'refresh_token' } });
  assert.equal(a.response.status, 400);
  assert.equal(b.response.status, 400);
  assert.equal(a.calls.length + b.calls.length, 0);
});
