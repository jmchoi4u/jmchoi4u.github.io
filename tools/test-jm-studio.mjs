#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const html = read('jm-studio/index.html');
const serviceWorker = read('jm-studio/sw.js');
const worker = read('tools/oauth-worker.js');
const manifest = JSON.parse(read('jm-studio/manifest.json'));
const workflow = read('.github/workflows/pages-deploy.yml');
const notifyWorkflow = read('.github/workflows/notify-subscribers.yml');
const blogHead = read('_includes/head.html');
const blogAnalytics = read('assets/js/blog-analytics.js');
const postLayout = read('_layouts/post.html');
const postScript = read('assets/js/blog-post.js');
const subscribeScript = read('assets/js/blog-subscribe.js');
const subscribeModal = read('_includes/subscribe-modal.html');

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
assert.equal(inlineScripts.length, 1, 'expected one inline application script');
new Function(inlineScripts[0]);
new Function(serviceWorker);
new Function(worker.replace(/^export\s+default\s+/m, 'const oauthWorker = '));

const workerModule = await import(`data:text/javascript;base64,${Buffer.from(worker).toString('base64')}`);
const originalFetch = globalThis.fetch;
async function exchangeWithScope(scope) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', scope }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('api.github.com/user')) {
      return new Response(JSON.stringify({ login: 'jmchoi4u' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const request = new Request('https://worker.example/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io' },
    body: JSON.stringify({ code: 'code', redirect_uri: 'https://jmchoi4u.github.io/jm-studio/', code_verifier: 'A'.repeat(43) }),
  });
  return workerModule.default.fetch(request, { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' });
}
try {
  assert.equal((await exchangeWithScope('repo')).status, 403, 'over-broad OAuth scope must be rejected');
  const narrowResponse = await exchangeWithScope('public_repo');
  assert.equal(narrowResponse.status, 200);
  assert.equal((await narrowResponse.json()).scope, 'public_repo');

  let upstreamViewUrl = '';
  globalThis.fetch = async (url) => {
    upstreamViewUrl = String(url);
    return new Response(JSON.stringify({ count: '312', count_unique: '271' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const viewResponse = await workerModule.default.fetch(new Request(
    'https://worker.example/views?path=TOTAL&start=week',
    { headers: { Origin: 'https://jmchoi4u.github.io' } },
  ), {});
  assert.equal(viewResponse.status, 200);
  assert.equal((await viewResponse.json()).count, '312');
  assert.equal(viewResponse.headers.get('Access-Control-Allow-Origin'), 'https://jmchoi4u.github.io');
  assert.match(viewResponse.headers.get('Cache-Control'), /max-age=60/);
  assert.equal(
    upstreamViewUrl,
    'https://jmchoi4u.goatcounter.com/counter/TOTAL.json?start=week',
    'the Worker must be the only component that talks to GoatCounter counters'
  );

  const postViewResponse = await workerModule.default.fetch(new Request(
    'https://worker.example/views?path=%2Fposts%2F6%2F',
    { headers: { Origin: 'https://jmchoi4u.github.io' } },
  ), {});
  assert.equal(postViewResponse.status, 200);
  assert.equal(
    upstreamViewUrl,
    'https://jmchoi4u.goatcounter.com/counter/%2Fposts%2F6.json',
    'post paths must be normalized without losing their leading slash'
  );

  let invalidCounterFetches = 0;
  globalThis.fetch = async () => { invalidCounterFetches += 1; return new Response('{}'); };
  const invalidCounterResponse = await workerModule.default.fetch(new Request(
    'https://worker.example/views?path=https%3A%2F%2Fevil.example',
    { headers: { Origin: 'https://jmchoi4u.github.io' } },
  ), {});
  assert.equal(invalidCounterResponse.status, 400);
  assert.equal(invalidCounterFetches, 0, 'invalid paths must not reach the upstream counter');

  let invalidVerifierFetches = 0;
  globalThis.fetch = async () => { invalidVerifierFetches += 1; return new Response('{}'); };
  const invalidVerifierResponse = await workerModule.default.fetch(new Request('https://worker.example/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io' },
    body: JSON.stringify({ code: 'code', redirect_uri: 'https://jmchoi4u.github.io/jm-studio/', code_verifier: '1234' }),
  }), { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' });
  assert.equal(invalidVerifierResponse.status, 400, 'short PKCE verifier must be rejected');
  assert.equal(invalidVerifierFetches, 0, 'invalid PKCE input must not reach GitHub');

  const unavailableSubscribe = await workerModule.default.fetch(new Request('https://worker.example/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io' },
    body: JSON.stringify({ email: 'reader@example.com' }),
  }), {});
  assert.equal(unavailableSubscribe.status, 503, 'missing subscriber storage must not report success');

  const unsubscribeToken = 'u'.repeat(43);
  const kvData = new Map([
    [`unsub:${unsubscribeToken}`, 'reader@example.com'],
    ['reader@example.com', JSON.stringify({ email: 'reader@example.com', unsubscribeToken })],
  ]);
  const fakeKv = {
    get: async (key) => kvData.get(key) ?? null,
    put: async (key, value) => kvData.set(key, value),
    delete: async (key) => kvData.delete(key),
    list: async () => ({ keys: [...kvData.keys()].map((name) => ({ name })) }),
  };
  const unsubscribeResponse = await workerModule.default.fetch(
    new Request(`https://worker.example/unsub?token=${unsubscribeToken}`),
    { SUBSCRIBERS: fakeKv },
  );
  assert.equal(unsubscribeResponse.status, 200, 'email links must unsubscribe without an Origin header');
  assert.equal(kvData.has('reader@example.com'), false);
  assert.equal(kvData.has(`unsub:${unsubscribeToken}`), false);

  globalThis.fetch = async (url) => {
    if (String(url).includes('api.resend.com/emails')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const subscribeResponse = await workerModule.default.fetch(new Request('https://worker.example/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://jmchoi4u.github.io',
      'CF-Connecting-IP': '203.0.113.4',
    },
    body: JSON.stringify({ email: 'reader@example.com' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>' });
  assert.equal(subscribeResponse.status, 200);
  assert.equal((await subscribeResponse.json()).pending, true, 'new subscriptions must wait for email confirmation');
  const confirmKey = [...kvData.keys()].find((key) => key.startsWith('confirm:'));
  assert.ok(confirmKey, 'a one-time confirmation token must be stored');
  assert.equal(JSON.parse(kvData.get('reader@example.com')).active, false);

  const confirmResponse = await workerModule.default.fetch(
    new Request(`https://worker.example/confirm?token=${confirmKey.slice('confirm:'.length)}`),
    { SUBSCRIBERS: fakeKv },
  );
  assert.equal(confirmResponse.status, 200, 'email confirmation links must work without an Origin header');
  assert.equal(JSON.parse(kvData.get('reader@example.com')).active, true);
  assert.equal(kvData.has(confirmKey), false, 'confirmation tokens must be one-time use');

  const directEmailUnsubscribe = await workerModule.default.fetch(new Request('https://worker.example/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io' },
    body: JSON.stringify({ email: 'reader@example.com' }),
  }), { SUBSCRIBERS: fakeKv });
  assert.equal(directEmailUnsubscribe.status, 404, 'email-only unsubscribe must not be available');

  const unauthorizedNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'wrong' },
    body: JSON.stringify({ title: 'Test', url: 'https://jmchoi4u.github.io/posts/test/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(unauthorizedNotify.status, 401, 'server notifications require a dedicated secret');

  const notifyResponse = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Test', url: 'https://jmchoi4u.github.io/posts/test/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(notifyResponse.status, 200, 'server notifications must work without a browser Origin header');
  assert.equal((await notifyResponse.json()).sent, 1);

  const duplicateNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Test', url: 'https://jmchoi4u.github.io/posts/test/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(duplicateNotify.status, 200);
  assert.equal((await duplicateNotify.json()).duplicate, true, 'the same post must never notify twice');

  globalThis.fetch = async (url) => {
    if (String(url).includes('api.resend.com/emails')) return new Response('{}', { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const failedNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Failure', url: 'https://jmchoi4u.github.io/posts/failure/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(failedNotify.status, 502, 'email provider failures must fail the notification job');

  const secondToken = 'v'.repeat(43);
  kvData.set('second@example.com', JSON.stringify({ email: 'second@example.com', active: true, unsubscribeToken: secondToken }));
  kvData.set(`unsub:${secondToken}`, 'second@example.com');
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.resend.com/emails')) throw new Error(`unexpected fetch: ${url}`);
    const recipient = JSON.parse(options.body).to[0];
    return new Response('{}', { status: recipient === 'second@example.com' ? 500 : 200 });
  };
  const partialNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Partial', url: 'https://jmchoi4u.github.io/posts/partial/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(partialNotify.status, 502);
  assert.equal((await partialNotify.json()).sent, 1);

  const retryRecipients = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.resend.com/emails')) throw new Error(`unexpected fetch: ${url}`);
    retryRecipients.push(JSON.parse(options.body).to[0]);
    return new Response('{}', { status: 200 });
  };
  const retryNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Partial', url: 'https://jmchoi4u.github.io/posts/partial/' }),
  }), { SUBSCRIBERS: fakeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(retryNotify.status, 200);
  assert.deepEqual(retryRecipients, ['second@example.com'], 'retries must skip recipients that already received the post');

  const largeKvData = new Map();
  for (let index = 0; index < 1001; index += 1) largeKvData.set(`delivered:seed-${index}`, '{}');
  const lateToken = 'w'.repeat(43);
  largeKvData.set('late@example.com', JSON.stringify({ email: 'late@example.com', active: true, unsubscribeToken: lateToken }));
  largeKvData.set(`unsub:${lateToken}`, 'late@example.com');
  const largeKv = {
    get: async (key) => largeKvData.get(key) ?? null,
    put: async (key, value) => largeKvData.set(key, value),
    delete: async (key) => largeKvData.delete(key),
    list: async (options = {}) => {
      const names = [...largeKvData.keys()];
      const start = Number(options.cursor || 0);
      const end = Math.min(start + 1000, names.length);
      return {
        keys: names.slice(start, end).map((name) => ({ name })),
        list_complete: end >= names.length,
        cursor: end < names.length ? String(end) : undefined,
      };
    },
  };
  const largeRecipients = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.resend.com/emails')) throw new Error(`unexpected fetch: ${url}`);
    largeRecipients.push(JSON.parse(options.body).to[0]);
    return new Response('{}', { status: 200 });
  };
  const paginatedNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Pagination', url: 'https://jmchoi4u.github.io/posts/pagination/' }),
  }), { SUBSCRIBERS: largeKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(paginatedNotify.status, 200);
  assert.deepEqual(largeRecipients, ['late@example.com'], 'KV pagination must not hide subscribers after 1,000 internal keys');

  /* 공감 */
  const likeData = new Map();
  const likeKv = {
    get: async (key) => likeData.get(key) ?? null,
    put: async (key, value) => likeData.set(key, value),
    delete: async (key) => likeData.delete(key),
    list: async () => ({ keys: [...likeData.keys()].map((name) => ({ name })) }),
  };
  const reader = 'r'.repeat(22);
  const other = 'o'.repeat(22);
  const likeRequest = (method, query, body) => workerModule.default.fetch(new Request(`https://worker.example/likes${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io', 'CF-Connecting-IP': '198.51.100.7' },
    body: body ? JSON.stringify(body) : undefined,
  }), { SUBSCRIBERS: likeKv });
  assert.deepEqual(await (await likeRequest('GET', `?path=%2Fposts%2F8%2F&visitor=${reader}`)).json(), { count: 0, liked: false });
  assert.deepEqual(await (await likeRequest('POST', '', { path: '/posts/8/', like: true, visitor: reader })).json(), { count: 1, liked: true });
  assert.deepEqual(await (await likeRequest('POST', '', { path: '/posts/8/', like: true, visitor: reader })).json(), { count: 1, liked: true }, 'pressing twice must count once');
  assert.deepEqual(await (await likeRequest('GET', `?path=/posts/8&visitor=${other}`)).json(), { count: 1, liked: false }, 'readers sharing an address must not share a press');
  assert.deepEqual(await (await likeRequest('POST', '', { path: '/posts/8', like: false, visitor: reader })).json(), { count: 0, liked: false });
  assert.equal((await likeRequest('POST', '', { path: '/about/', like: true, visitor: reader })).status, 400, 'only posts can be liked');
  assert.equal((await likeRequest('POST', '', { path: '/posts/8/', like: true })).status, 400, 'a press needs the browser ID');
  assert.equal((await likeRequest('GET', '?path=TOTAL')).status, 400);

  /* 글감 메모함 */
  const memoData = new Map();
  const memoKv = {
    get: async (key) => memoData.get(key) ?? null,
    put: async (key, value) => memoData.set(key, value),
    delete: async (key) => memoData.delete(key),
    list: async () => ({ keys: [...memoData.keys()].map((name) => ({ name })) }),
  };
  let githubUserCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).includes('api.github.com/user')) throw new Error(`unexpected fetch: ${url}`);
    githubUserCalls += 1;
    const login = String(options.headers?.Authorization || '').endsWith('owner-token') ? 'jmchoi4u' : 'someone-else';
    return new Response(JSON.stringify({ login }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const memoRequest = (token, body) => workerModule.default.fetch(new Request('https://worker.example/memos', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Origin: 'https://jmchoi4u.github.io', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), { SUBSCRIBERS: memoKv });
  assert.equal((await memoRequest('', null)).status, 401, 'memos need a GitHub token');
  assert.equal((await memoRequest('other-token', null)).status, 401, 'only the blog owner reads the memos');
  const added = await (await memoRequest('owner-token', { action: 'add', id: 'memo-0001', text: '  글감 하나  ' })).json();
  assert.equal(added.memos.length, 1);
  assert.equal(added.memos[0].text, '글감 하나');
  const again = await (await memoRequest('owner-token', { action: 'add', id: 'memo-0001', text: '글감 하나' })).json();
  assert.equal(again.memos.length, 1, 'a change sent twice from the offline queue must apply once');
  await memoRequest('owner-token', { action: 'add', id: 'memo-0002', text: '둘째' });
  const afterDelete = await (await memoRequest('owner-token', { action: 'delete', id: 'memo-0001' })).json();
  assert.deepEqual(afterDelete.memos.map((memo) => memo.id), ['memo-0002']);
  assert.equal((await memoRequest('owner-token', { action: 'add', text: '   ' })).status, 400);
  assert.equal(githubUserCalls, 2, 'a checked owner token must be trusted for a while instead of asking GitHub each time');

  /* Likes and memos share the subscriber store; neither may look like a subscriber. */
  const sharedToken = 'z'.repeat(43);
  memoData.set('only@example.com', JSON.stringify({ email: 'only@example.com', active: true, unsubscribeToken: sharedToken }));
  memoData.set(`unsub:${sharedToken}`, 'only@example.com');
  for (const [key, value] of likeData) memoData.set(key, value);
  memoData.set('likes:/posts/9', '3');
  const sharedRecipients = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.resend.com/emails')) throw new Error(`unexpected fetch: ${url}`);
    sharedRecipients.push(JSON.parse(options.body).to[0]);
    assert.match(JSON.parse(options.body).html, /#2F5D8A/, 'the new post e-mail must use the blog palette');
    return new Response('{}', { status: 200 });
  };
  const sharedNotify = await workerModule.default.fetch(new Request('https://worker.example/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'correct-secret' },
    body: JSON.stringify({ title: 'Shared store', url: 'https://jmchoi4u.github.io/posts/shared/' }),
  }), { SUBSCRIBERS: memoKv, RESEND_API_KEY: 'resend-test', EMAIL_FROM: 'Blog <blog@example.com>', NOTIFY_SECRET: 'correct-secret' });
  assert.equal(sharedNotify.status, 200);
  assert.deepEqual(sharedRecipients, ['only@example.com'], 'like and memo records must never be mailed');
  assert.ok(memoData.has('memos:owner'), 'sending must leave the memos alone');

  /* 예약 발행: the Worker's clock wakes the due check only once it has a token. */
  const dispatches = [];
  globalThis.fetch = async (url, options) => { dispatches.push({ url: String(url), body: JSON.parse(options.body) }); return new Response(null, { status: 204 }); };
  const waits = [];
  await workerModule.default.scheduled({}, {}, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(dispatches.length, 0, 'without GH_DISPATCH_TOKEN the schedule must do nothing');
  await workerModule.default.scheduled({}, { GH_DISPATCH_TOKEN: 'dispatch' }, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(dispatches[0].url, 'https://api.github.com/repos/jmchoi4u/jmchoi4u.github.io/actions/workflows/pages-deploy.yml/dispatches');
  assert.deepEqual(dispatches[0].body, { ref: 'main', inputs: { due_check: 'true' } });
} finally {
  globalThis.fetch = originalFetch;
}

const storage = new Map();
const fakeStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
const appSandbox = {
  AbortController,
  Date,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  Uint8Array,
  atob,
  btoa,
  clearInterval,
  clearTimeout,
  console,
  crypto: globalThis.crypto,
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
  },
  fetch,
  localStorage: fakeStorage,
  navigator: {},
  sessionStorage: fakeStorage,
  setInterval,
  setTimeout,
  window: {
    addEventListener() {},
    history: {},
    location: { origin: 'https://jmchoi4u.github.io', pathname: '/jm-studio/index.html' },
  },
};
vm.createContext(appSandbox);
vm.runInContext(inlineScripts[0], appSandbox);

assert.equal(appSandbox.studioRedirectUri(), 'https://jmchoi4u.github.io/jm-studio/');
assert.equal(appSandbox.yamlValue('나의 실패 일기장, 나는 부끄러워져도'), '나의 실패 일기장, 나는 부끄러워져도', 'ordinary settings must stay plain YAML');
assert.equal(appSandbox.yamlValue('새 블로그: 시작'), '"새 블로그: 시작"', 'a ": " in a setting must be quoted');
assert.equal(
  appSandbox.setYamlKey('title: Old # the main title\ntagline_en: x\n', 'title', 'A $1 title'),
  'title: A $1 title # the main title\ntagline_en: x\n',
  'settings must keep trailing comments and take $ literally'
);
assert.equal(appSandbox.setYamlKey('tagline_en: keep\ntagline: old\n', 'tagline', 'new'), 'tagline_en: keep\ntagline: new\n', 'a longer key sharing the prefix must be left alone');
assert.equal(appSandbox.setYamlKey('avatar: /a.png\n', 'cover_image', '/c.jpg'), null, 'a missing key must be reported, not written in place');
assert.match(html, /function captureStudioIntent[\s\S]*?_\(posts\|drafts\)/, 'blog shortcuts may only open post files');
assert.match(html, /if \(S\.postsLoaded\) consumeStudioIntent\(\)/, 'shortcuts must wait for the post list');
assert.match(html, /setBlogOwnerFlag\(false\);\s*await clearTrustedSession\(\)/, 'signing out must hide the blog shortcuts');
assert.equal(appSandbox.isValidPostDate('2026-07-13 18:30:00 +0900'), true);
assert.equal(appSandbox.isValidPostDate('2026/07/13'), false);
assert.equal(appSandbox.isValidPostDate('2026-02-30 18:30:00 +0900'), false);

/* 예약 발행: a post is scheduled while its date (Korean time) is still ahead. */
const scheduleNow = Date.UTC(2026, 10, 5, 12, 0, 0);
assert.equal(appSandbox.formatPostDate(scheduleNow), '2026-11-05 21:00:00 +0900', 'post dates must be Korean time on any device');
assert.equal(appSandbox.isFuturePostDate('2026-11-05 21:00:01 +0900', scheduleNow), true);
assert.equal(appSandbox.isFuturePostDate('2026-11-05 21:00:00 +0900', scheduleNow), false, 'a post due this second is out, not scheduled');
assert.equal(appSandbox.isFuturePostDate('2026-11-06', scheduleNow), true, 'a date without a time is midnight Korean time');
assert.equal(appSandbox.isFuturePostDate('not a date', scheduleNow), false);
assert.equal(appSandbox.friendlyPostTime('2026-11-07 20:00:00 +0900'), '11월 7일 (토) 오후 8시');
assert.equal(appSandbox.friendlyPostTime('2026-11-08 00:30:00 +0900'), '11월 8일 (일) 밤 12시 30분');
assert.equal(
  appSandbox.setFrontMatterDate('---\ntitle: x\ndate: 2026-11-07 20:00:00 +0900\n---\n\ndate: in the body\n', '2026-11-05 21:00:00 +0900'),
  '---\ntitle: x\ndate: 2026-11-05 21:00:00 +0900\n---\n\ndate: in the body\n',
  '지금 올리기 must change only the front matter date'
);
assert.equal(appSandbox.setFrontMatterDate('no front matter', '2026-11-05 21:00:00 +0900'), null);
assert.match(
  appSandbox.buildFileContent({ title: 't', date: '2026-11-07 20:00:00 +0900', categories: [], tags: [], toc: true, comments: true, notify: false }, ''),
  /^notify: false$/m,
  'turning the subscriber e-mail off must reach the front matter'
);
assert.equal(appSandbox.parseFrontMatter('---\ntitle: t\nnotify: false\n---\n').notify, false);
assert.equal(appSandbox.parseFrontMatter('---\ntitle: t\nnotify: false\n---\n')._extra, '', 'notify must not be duplicated as an unknown key');
assert.deepEqual({ ...appSandbox.takeExtraLine('a: 1\nnotify: false\nb: 2', 'notify') }, { value: 'false', extra: 'a: 1\nb: 2' });
assert.deepEqual({ ...appSandbox.takeExtraLine('series: "회고"\nnotify_me: x', 'series') }, { value: '회고', extra: 'notify_me: x' });

/* 시리즈: one name per post, kept through a save and read back. */
const seriesFile = appSandbox.buildFileContent({ title: 't', date: '2026-11-07 20:00:00 +0900', categories: [], tags: ['a'], series: '회고: 2026', toc: true, comments: true }, '');
assert.match(seriesFile, /^series: "회고: 2026"$/m, 'a series name must be quoted YAML');
assert.equal(appSandbox.parseFrontMatter(seriesFile).series, '회고: 2026');
assert.equal(appSandbox.parseFrontMatter(seriesFile)._extra, '', 'series must not be duplicated as an unknown key');

const dueCheck = JSON.parse(execFileSync('python3', ['-c', [
  'import importlib.util, json, pathlib',
  'spec = importlib.util.spec_from_file_location("due", "tools/due-posts.py")',
  'due = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(due)',
  'post = pathlib.Path("_posts/2026-11-07-12.md")',
  'now = due.post_time("2026-11-07 21:00:00 +0900")',
  'print(json.dumps([due.post_time("2026-11-07 20:00:00 +0900").isoformat(), due.post_time("2026-11-07").isoformat(), due.post_url(post, {}), due.post_url(post, {"permalink": "/posts/12/"}),',
  '  due.is_due({"date": "2026-11-07 20:00:00 +0900"}, now), due.is_due({"date": "2026-11-07 20:00:00 +0900", "hidden": "true"}, now),',
  '  due.is_due({"date": "2026-11-07 22:00:00 +0900"}, now), due.is_due({"date": "2026-11-01 20:00:00 +0900"}, now)]))',
].join('\n')], { cwd: root, encoding: 'utf8' }));
assert.deepEqual(dueCheck, [
  '2026-11-07T20:00:00+09:00',
  '2026-11-07T00:00:00+09:00',
  'https://jmchoi4u.github.io/posts/12/',
  'https://jmchoi4u.github.io/posts/12/',
  true,
  false,
  false,
  false,
], 'the hourly due check must read dates and addresses as Jekyll does, and never wait for a hidden post');
const studioPostOrder = [...appSandbox.sortPostsForDisplay([
  { name: '2026-07-28-new.md', date: '2026-07-28', pin: false },
  { name: '2026-03-17-pinned.md', date: '2026-03-17', pin: true },
  { name: '2026-05-27-normal.md', date: '2026-05-27', pin: false },
  { name: '2026-03-25-newer-pinned.md', date: '2026-03-25', pin: true },
])];
assert.deepEqual(
  studioPostOrder.map((post) => post.name),
  [
    '2026-03-25-newer-pinned.md',
    '2026-03-17-pinned.md',
    '2026-07-28-new.md',
    '2026-05-27-normal.md',
  ],
  'Studio must match the public home order: pinned posts first, then newest to oldest',
);
assert.match(html, /filtered = sortPostsForDisplay\(filtered\)/, 'filtered Studio lists must preserve pinned placement');
assert.match(html, /class="card-pin"[^>]*>[^<]*고정/, 'pinned Studio cards must identify their placement');
const blockFrontMatter = appSandbox.parseFrontMatter('---\ntitle: "block"\ndate: 2026-07-13 18:30:00 +0900\ncategories:\n  - "개발환경"\n  - mobile\ntags:\n  - pwa\nimage:\n  path: /assets/cover.png\n  alt: "cover"\ncustom_key: keep-me\n---\n\nbody');
assert.deepEqual([...blockFrontMatter.categories], ['개발환경', 'mobile']);
assert.deepEqual([...blockFrontMatter.tags], ['pwa']);
assert.equal(blockFrontMatter.image.path, '/assets/cover.png');
assert.match(blockFrontMatter._imageExtra, /alt:/);
assert.equal(appSandbox.extractImageAlt(blockFrontMatter._imageExtra), 'cover');
assert.match(appSandbox.mergeImageAlt(blockFrontMatter._imageExtra, '새 표지 설명'), /alt: "새 표지 설명"/);
assert.equal((appSandbox.mergeImageAlt(blockFrontMatter._imageExtra, '새 표지 설명').match(/\balt:/g) || []).length, 1);
assert.match(blockFrontMatter._extra, /custom_key: keep-me/);
assert.doesNotMatch(html, /카테고리를 지정한 뒤 발행해 주세요/, 'publishing must not force editorial metadata');
assert.doesNotMatch(html, /표지 이미지 설명을 입력한 뒤 발행해 주세요/, 'publishing must not force editorial metadata');

for (const fileName of readdirSync(resolve(root, '_posts')).filter((name) => name.endsWith('.md'))) {
  const source = read(`_posts/${fileName}`);
  const parsed = appSandbox.parseFrontMatter(source);
  const rebuilt = appSandbox.buildFileContent({
    ...parsed,
    description: parsed.description || '',
    categories: parsed.categories || [],
    tags: parsed.tags || [],
    toc: parsed.toc !== false,
    comments: parsed.comments !== false,
    pin: Boolean(parsed.pin),
    hidden: Boolean(parsed.hidden),
    mermaid: Boolean(parsed.mermaid),
    math: Boolean(parsed.math),
    hero_title: parsed.hero_title || '',
    summary: parsed.summary || '',
    permalink: parsed.permalink || '',
    hero_image_position: parsed.hero_image_position || '',
    extra_front_matter: parsed._extra || '',
    image_extra: parsed._imageExtra || '',
    cover: parsed.image?.path || (typeof parsed.image === 'string' ? parsed.image : ''),
  }, appSandbox.extractBody(source));
  const reparsed = appSandbox.parseFrontMatter(rebuilt);
  assert.deepEqual([...(reparsed.categories || [])], [...(parsed.categories || [])], `${fileName} categories must survive a save`);
  assert.equal(appSandbox.extractBody(rebuilt), appSandbox.extractBody(source), `${fileName} body must survive a save`);
}

const swListeners = {};
let swPutCalls = 0;
const swCache = {
  add: async () => undefined,
  put: async () => { swPutCalls += 1; throw new Error('simulated cache quota error'); },
};
const swCaches = {
  open: async () => swCache,
  keys: async () => [],
  delete: async () => true,
  match: async () => null,
};
const swSelf = {
  location: { origin: 'https://jmchoi4u.github.io' },
  clients: { claim: async () => undefined },
  skipWaiting: async () => undefined,
  addEventListener: (type, handler) => { swListeners[type] = handler; },
};
new Function('self', 'caches', 'fetch', 'Request', 'Response', serviceWorker)(
  swSelf,
  swCaches,
  async () => new Response('online', { status: 200 }),
  Request,
  Response,
);

async function runNavigation(url) {
  let responsePromise;
  const waitPromises = [];
  swListeners.fetch({
    request: { method: 'GET', mode: 'navigate', url },
    respondWith: (promise) => { responsePromise = Promise.resolve(promise); },
    waitUntil: (promise) => { waitPromises.push(Promise.resolve(promise)); },
  });
  const response = await responsePromise;
  await Promise.all(waitPromises);
  return response;
}

const onlineResponse = await runNavigation('https://jmchoi4u.github.io/jm-studio/');
assert.equal(await onlineResponse.text(), 'online', 'cache failure must not poison a successful network response');
const writesBeforeCallback = swPutCalls;
await runNavigation('https://jmchoi4u.github.io/jm-studio/?code=secret&state=random');
assert.equal(swPutCalls, writesBeforeCallback, 'OAuth callback responses must never be cached');

/* 갤러리에서 바로 글쓰기: a shared photo waits in its own cache, then Studio opens. */
const shareCacheEntries = new Map();
const shareCaches = {
  open: async () => ({ put: async (key, response) => shareCacheEntries.set(key, response) }),
  delete: async () => { shareCacheEntries.clear(); return true; },
  keys: async () => [],
  match: async () => null,
};
const shareListeners = {};
new Function('self', 'caches', 'fetch', 'Request', 'Response', serviceWorker)(
  {
    location: { origin: 'https://jmchoi4u.github.io', href: 'https://jmchoi4u.github.io/jm-studio/sw.js' },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (type, handler) => { shareListeners[type] = handler; },
  },
  shareCaches,
  async () => { throw new Error('a share must not reach the network'); },
  Request,
  Response,
);
const sharedForm = new FormData();
sharedForm.append('title', '오늘 사진');
sharedForm.append('photos', new File([new Uint8Array([1, 2, 3])], '바다.jpg', { type: 'image/jpeg' }));
let shareResponse;
shareListeners.fetch({
  request: new Request('https://jmchoi4u.github.io/jm-studio/share-target', { method: 'POST', body: sharedForm }),
  respondWith: (promise) => { shareResponse = Promise.resolve(promise); },
  waitUntil: () => undefined,
});
shareResponse = await shareResponse;
assert.equal(shareResponse.status, 303);
assert.equal(shareResponse.headers.get('Location'), 'https://jmchoi4u.github.io/jm-studio/?share=1', 'a share must open Studio');
assert.deepEqual([...shareCacheEntries.keys()].sort(), ['shared/0', 'shared/meta']);
assert.equal(shareCacheEntries.get('shared/0').headers.get('X-File-Name'), encodeURIComponent('바다.jpg'));
assert.deepEqual(JSON.parse(await shareCacheEntries.get('shared/meta').text()), { title: '오늘 사진', text: '', url: '', count: 1 });
assert.equal(manifest.share_target.method, 'POST');
assert.equal(manifest.share_target.action, './share-target');
assert.deepEqual(manifest.share_target.params.files, [{ name: 'photos', accept: ['image/*'] }]);
assert.match(html, /params\.get\('share'\) === '1'/, 'Studio must pick a share up after signing in');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicateIds)], [], 'HTML IDs must be unique');

assert.match(html, /TRUSTED_SESSION_TTL\s*=\s*30\s*\*\s*24/, '30-day trusted session is required');
assert.match(html, /scope=public_repo/, 'OAuth must request only the public repository scope');
assert.match(html, /code_challenge_method=S256/, 'OAuth PKCE support is required');
assert.match(html, /requireSecureWorker/, 'OAuth must fail closed when the secure worker is unavailable');
assert.doesNotMatch(html, /id="view-password-setup"/, 'new users must not be asked to create a password');
assert.match(html, /saveTrustedSession\(data\.access_token\)[\s\S]*?onLoginSuccess/, 'OAuth must enter a trusted passwordless session immediately');
assert.match(html, /window\.visualViewport/, 'mobile keyboard viewport handling is required');
assert.match(html, /if \(S\.saving \|\| S\.loadingPost\) \{[\s\S]*?\['s', 'p', 'b', 'i', 'k'\]/, 'editor shortcuts must be blocked while a write is in flight');
assert.match(html, /postsLoaded:\s*false/, 'new post numbering must wait for the repository index');
assert.match(html, /if \(!S\.postsLoaded \|\| S\.loadingPosts\) return toast\('글 목록을 모두 불러온 뒤/, 'new post creation must be blocked before the repository index loads');
assert.match(html, /\(!S\.editing \|\| S\.editing\.isNew\) && \(!S\.postsLoaded \|\| S\.loadingPosts\)/, 'new post saves must not derive a slug from an unloaded repository index');
assert.match(html, /viewport-fit=cover/, 'safe-area viewport support is required');
assert.match(html, /Content-Security-Policy/, 'CSP is required');
assert.match(html, /integrity="sha384-/, 'third-party script integrity is required');

assert.doesNotMatch(html, /scope=repo(?:&|')/, 'broad private repository scope must not return');
assert.doesNotMatch(html, /sessionStorage\.setItem\([^\n]*token/i, 'GitHub tokens must not be stored plaintext in sessionStorage');
assert.doesNotMatch(html, /maximum-scale|user-scalable\s*=\s*no/, 'mobile zoom must remain available');
assert.doesNotMatch(serviceWorker, /jm-studio-v1/, 'stale service-worker cache version must not return');
assert.match(serviceWorker, /\.startsWith\('jm-studio-'\)/, 'cache cleanup must not delete unrelated site caches');
assert.match(serviceWorker, /APP_SHELL/, 'PWA app shell must be pre-cached');
assert.match(serviceWorker, /isOAuthCallback/, 'OAuth callback responses must not be cached');
assert.match(worker, /grantedScopes/, 'OAuth worker must validate the granted scope');
assert.match(worker, /PKCE_VERIFIER_PATTERN/, 'OAuth worker must validate PKCE verifier syntax');
assert.match(worker, /OWNER_LOGIN/, 'OAuth worker must verify the GitHub owner before returning a token');
assert.match(worker, /path === ['"]\/views['"]/, 'view counts must have an allowed-origin Worker proxy');
assert.doesNotMatch(worker, /searchParams\.get\(['"]email['"]\)/, 'unsubscribe links must not expose raw email addresses');
assert.doesNotMatch(worker, /path === ['"]\/unsubscribe['"]/, 'email-only unsubscribe must not return');
assert.match(worker, /path === ['"]\/confirm['"]/, 'subscriptions must require an email confirmation route');
assert.match(worker, /X-Notify-Secret/, 'automated notifications must use a dedicated secret');
assert.match(workflow, /node tools\/test-jm-studio\.mjs/, 'Studio checks must run in CI');
assert.match(workflow, /cron:\s*["']17 \* \* \* \*["']/, 'scheduled posts must be checked every hour, away from the top of the hour');
assert.match(workflow, /due_check:[\s\S]*?type: boolean/, 'the Worker must be able to ask for the due check alone');
assert.match(workflow, /github\.event_name == 'schedule' \|\| inputs\.due_check/, 'a due-check dispatch must run the due job');
assert.match(workflow, /python3 tools\/make-share-cards\.py --font/, 'the build must draw share cards');
assert.match(workflow, /name: Draw share cards\s+continue-on-error: true/, 'a failed card must not stop a deploy');
assert.match(workflow, /python3 tools\/due-posts\.py >> "\$GITHUB_OUTPUT"/, 'the hourly run must build only when a scheduled post is due');
assert.match(workflow, /needs\.due\.outputs\.build == 'true'/, 'a quiet hour must skip the build');
assert.match(workflow, /if: \$\{\{ !cancelled\(\) && needs\.build\.result == 'success' \}\}/, 'a push must still deploy although the due job is skipped');
assert.match(workflow, /needs\.deploy\.result == 'success'/, 'notifications must follow a deploy that went through');
assert.doesNotMatch(workflow, /^concurrency:/m, 'the hourly check must not cancel a deploy that is running');
assert.match(workflow, /gh workflow run notify-subscribers\.yml/, 'a scheduled post that goes up must e-mail the subscribers');
assert.match(notifyWorkflow, /--fail-with-body/, 'notification HTTP failures must fail CI');
assert.match(notifyWorkflow, /X-Notify-Secret/, 'notification workflow must use the dedicated Worker secret');
assert.match(notifyWorkflow, /schedule:[\s\S]*?cron:\s*["']30 1 \* \* \*['"]/, 'scheduled posts must be checked after the daily Pages build');
assert.match(notifyWorkflow, /window_start[\s\S]*?Path\("_posts"\)\.glob/, 'all recently published posts must be considered');
assert.match(notifyWorkflow, /git["], ["]diff["], ["]--name-status[\s\S]*?status\.startswith\(\(["]A["], ["]R["], ["]C["]\)\)/, 'pushes must include newly published or renamed posts regardless of their draft date');
assert.match(notifyWorkflow, /was_unhidden/, 'revealed posts must be eligible for notification');
assert.match(notifyWorkflow, /was_scheduled\(path, before_sha\)/, 'a scheduled post brought forward must be eligible for notification');
assert.match(notifyWorkflow, /get\("notify", "true"\)\.lower\(\) == "false"/, 'a post with the e-mail turned off must not be sent');
assert.match(worker, /NOTIFIED_KEY_PREFIX/, 'post notifications must be idempotent');
assert.match(worker, /DELIVERED_KEY_PREFIX/, 'partial retries must be idempotent per recipient');
assert.match(worker, /async function listAllKeys[\s\S]*?list_complete/, 'subscriber scans must follow Cloudflare KV cursors');

assert.equal(manifest.id, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.lang, 'ko-KR');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
assert.match(blogHead, /width=device-width, initial-scale=1, viewport-fit=cover/, 'public pages must allow pinch zoom');
assert.match(blogHead, /count\.v5\.js/, 'production GoatCounter recorder must be present');
assert.match(blogHead, /blog-analytics\.js/, 'shared blog analytics helper must be loaded');
assert.match(blogHead, /blog-analytics\.js[^\n]*\?v=/, 'analytics fixes must bypass stale browser caches');
assert.match(blogHead, /data-view-counter-endpoint=/, 'public view counts must declare the Worker proxy');
assert.match(html, /WORKER_URL \+ ['"]\/views\?path=/, 'Studio view counts must use the Worker proxy');
assert.doesNotMatch(html, /goatcounter\.com\/counter\//, 'Studio must not request tracker-domain counters directly');
assert.doesNotMatch(postLayout, /requestGoatCounterCount/, 'post layout must use the shared counter implementation');
assert.match(subscribeScript, /if \(!response\.ok \|\| data\.ok !== true\)/, 'subscribe UI must reject HTTP and application failures');
assert.match(subscribeModal, /blog-subscribe\.js/, 'the subscribe dialog must load its script');
assert.match(postLayout, /blog-post\.js/, 'the post layout must load its script');
assert.match(postLayout, /\?edit=\{\{ page\.path \| url_encode \}\}"[^>]*data-owner-only/, 'a post must link straight to its editor, for the owner only');
assert.doesNotMatch(postLayout, /post-floating-topbar|post-fab/, 'the hidden floating post controls were removed; any that return must be inert while hidden');
assert.match(postScript, /target\.focus\(\{ preventScroll: true \}\)/, 'comment navigation must move keyboard focus');
assert.match(postLayout, /data-like data-like-path="\{\{ page\.url \}\}"[^>]*hidden/, 'the like button must stay hidden until the Worker answers');
assert.match(postLayout, /include post-series\.html/, 'a post must show its series');
assert.match(postScript, /function setupLikes/, 'the post script must wire the like button');
assert.match(blogHead, /\/assets\/img\/og\//, 'posts must share their own card');
assert.match(blogHead, /site\.static_files \| where: 'path', share_card_path/, 'a card is used only when the build drew it');
assert.match(postScript, /aria-label', '이전 사진'[\s\S]*aria-label', '다음 사진'/, 'photo slide arrows must be labelled buttons');
assert.match(html, /function prepareImageForUpload[\s\S]*?PHOTO_MAX_WIDTH/, 'Studio must shrink photos before uploading them');
assert.match(html, /inp\.multiple = true/, 'Studio must accept several photos at once for a slide');
new Function(blogAnalytics);
new Function(postScript);
new Function(subscribeScript);
for (const icon of manifest.icons) {
  const bytes = readFileSync(new URL(icon.src, new URL('../jm-studio/', import.meta.url)));
  assert.ok(serviceWorker.includes(icon.src), `${icon.src} must be included in the offline app shell`);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${icon.src} must be a real PNG`);
  const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number);
  assert.equal(bytes.readUInt32BE(16), expectedWidth, `${icon.src} width mismatch`);
  assert.equal(bytes.readUInt32BE(20), expectedHeight, `${icon.src} height mismatch`);
}

console.log(`JM Studio checks passed (${ids.length} unique IDs, ${manifest.icons.length} PWA icon).`);
