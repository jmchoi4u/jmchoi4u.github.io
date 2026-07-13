#!/usr/bin/env node

import assert from 'node:assert/strict';
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
assert.equal(appSandbox.isValidPostDate('2026-07-13 18:30:00 +0900'), true);
assert.equal(appSandbox.isValidPostDate('2026/07/13'), false);
assert.equal(appSandbox.isValidPostDate('2026-02-30 18:30:00 +0900'), false);
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
assert.doesNotMatch(worker, /searchParams\.get\(['"]email['"]\)/, 'unsubscribe links must not expose raw email addresses');
assert.doesNotMatch(worker, /path === ['"]\/unsubscribe['"]/, 'email-only unsubscribe must not return');
assert.match(worker, /path === ['"]\/confirm['"]/, 'subscriptions must require an email confirmation route');
assert.match(worker, /X-Notify-Secret/, 'automated notifications must use a dedicated secret');
assert.match(workflow, /node tools\/test-jm-studio\.mjs/, 'Studio checks must run in CI');
assert.match(workflow, /cron:\s*["']0 0 \* \* \*["']/, 'daily scheduled publishing must use the main Pages workflow');
assert.match(notifyWorkflow, /--fail-with-body/, 'notification HTTP failures must fail CI');
assert.match(notifyWorkflow, /X-Notify-Secret/, 'notification workflow must use the dedicated Worker secret');
assert.match(notifyWorkflow, /schedule:[\s\S]*?cron:\s*["']30 1 \* \* \*['"]/, 'scheduled posts must be checked after the daily Pages build');
assert.match(notifyWorkflow, /window_start[\s\S]*?Path\("_posts"\)\.glob/, 'all recently published posts must be considered');
assert.match(notifyWorkflow, /git["], ["]diff["], ["]--name-status[\s\S]*?status\.startswith\(\(["]A["], ["]R["], ["]C["]\)\)/, 'pushes must include newly published or renamed posts regardless of their draft date');
assert.match(notifyWorkflow, /was_unhidden/, 'revealed posts must be eligible for notification');
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
assert.doesNotMatch(postLayout, /requestGoatCounterCount/, 'post layout must use the shared counter implementation');
assert.match(postLayout, /if\(!response\.ok\|\|data\.ok!==true\)/, 'subscribe UI must reject HTTP and application failures');
assert.match(postLayout, /post-floating-topbar[^>]*inert/, 'hidden floating controls must not receive keyboard focus');
assert.match(postLayout, /post-fab[^>]*inert/, 'hidden floating action buttons must not receive keyboard focus');
assert.match(postLayout, /comments\.focus\(\{ preventScroll: true \}\)/, 'comment navigation must move keyboard focus');
new Function(blogAnalytics);
for (const icon of manifest.icons) {
  const bytes = readFileSync(resolve(root, 'jm-studio', icon.src));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${icon.src} must be a real PNG`);
  const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number);
  assert.equal(bytes.readUInt32BE(16), expectedWidth, `${icon.src} width mismatch`);
  assert.equal(bytes.readUInt32BE(20), expectedHeight, `${icon.src} height mismatch`);
}

console.log(`JM Studio checks passed (${ids.length} unique IDs, ${manifest.icons.length} PWA icon).`);
