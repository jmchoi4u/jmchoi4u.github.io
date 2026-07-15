#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'assets/js/blog-analytics.js'), 'utf8');

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function createViewElement(attributes = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    dataset: {},
    hidden: false,
    textContent: '—',
    getAttribute(name) { return values.has(name) ? values.get(name) : null; },
    setAttribute(name, value) { values.set(name, String(value)); },
    removeAttribute(name) { values.delete(name); },
    hasAttribute(name) { return values.has(name); },
  };
}

function createHarness(fetchImpl, options = {}) {
  const storage = createStorage();
  const sessionStorage = createStorage();
  const eventHandlers = new Map();
  const goatEvents = [];
  let viewElements = [];
  let currentFetch = fetchImpl;
  let backgroundTimerId = 10000;

  const document = {
    readyState: 'loading',
    title: options.title || 'Test page',
    currentScript: {
      getAttribute(name) {
        if (name === 'data-goatcounter-id') return 'jmchoi4u';
        if (name === 'data-view-counter-endpoint') {
          return 'https://jm-studio-auth.jmchoi4u.workers.dev/views';
        }
        if (name === 'data-content-category') return options.contentCategory || '';
        return null;
      },
    },
    documentElement: { getAttribute() { return null; } },
    addEventListener(type, handler) { eventHandlers.set(`document:${type}`, handler); },
    querySelector(selector) {
      if (selector === '[data-reading-content]' && options.readingContent) {
        return options.readingContent;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-view-count][data-view-path]' ? viewElements : [];
    },
  };

  const window = {
    addEventListener(type, handler) { eventHandlers.set(`window:${type}`, handler); },
    dataLayer: [],
    goatcounter: {
      count(payload) { goatEvents.push(payload); },
    },
    innerHeight: 100,
    clearTimeout(id) {
      if (id && typeof id === 'object') clearTimeout(id);
    },
    location: { pathname: options.pathname || '/' },
    removeEventListener(type, handler) {
      if (eventHandlers.get(`window:${type}`) === handler) {
        eventHandlers.delete(`window:${type}`);
      }
    },
    requestAnimationFrame(handler) {
      handler();
      return 1;
    },
    scrollY: 0,
    sessionStorage,
    setTimeout(handler, delay) {
      // Keep recovery timers from holding the test process open. Request
      // timeouts remain long enough for the immediate fake fetches to settle.
      if (delay >= 15000) return backgroundTimerId += 1;
      return setTimeout(handler, delay >= 6000 ? 100 : 0);
    },
  };

  const sandbox = {
    AbortController,
    Date,
    Intl,
    JSON,
    Map,
    Number,
    Promise,
    Response,
    URL,
    console,
    document,
    fetch(...args) { return currentFetch(...args); },
    localStorage: storage,
    sessionStorage,
    window,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    analytics: window.JMBlogAnalytics,
    document,
    eventHandlers,
    goatEvents,
    setFetch(nextFetch) { currentFetch = nextFetch; },
    setViewElements(elements) { viewElements = elements; },
    sessionStorage,
    storage,
    window,
  };
}

let retryCalls = 0;
const retryUrls = [];
const retryHarness = createHarness(async (url) => {
  retryCalls += 1;
  retryUrls.push(String(url));
  if (retryCalls < 3) throw new TypeError('simulated transient network failure');
  return new Response(JSON.stringify({ count: '42' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
const recovered = await retryHarness.analytics.fetchCountMeta('/posts/retry/');
assert.equal(retryCalls, 3, 'transient counter failures must be retried twice');
assert.equal(recovered.ok, true);
assert.equal(recovered.stale, false);
assert.equal(recovered.count, 42);
assert.equal(recovered.attempts, 3);
assert.ok(
  retryUrls.every((url) => url.startsWith('https://jm-studio-auth.jmchoi4u.workers.dev/views?')),
  'view counts must use the first-party Worker proxy'
);
assert.ok(retryUrls.every((url) => !url.includes('goatcounter.com')));
assert.equal(new URL(retryUrls[0]).searchParams.get('path'), '/posts/retry');

let sharedCalls = 0;
retryHarness.analytics.setSiteId('jmchoi4u');
retryHarness.setFetch(async () => {
  sharedCalls += 1;
  return new Response(JSON.stringify({ count: 7 }), { status: 200 });
});
const [sharedLeft, sharedRight] = await Promise.all([
  retryHarness.analytics.fetchCountMeta('/posts/shared/'),
  retryHarness.analytics.fetchCountMeta('/posts/shared/'),
]);
assert.equal(sharedCalls, 1, 'concurrent consumers must share one counter request');
assert.equal(sharedLeft.count, 7);
assert.equal(sharedRight.count, 7);

retryHarness.analytics.setSiteId('jmchoi4u');
retryHarness.setFetch(async () => new Response(JSON.stringify({ count: 9 }), { status: 200 }));
const cachedSeed = await retryHarness.analytics.fetchCountMeta('/posts/cached/');
assert.equal(cachedSeed.count, 9);

let failedCacheCalls = 0;
retryHarness.analytics.setSiteId('jmchoi4u');
retryHarness.setFetch(async () => {
  failedCacheCalls += 1;
  throw new TypeError('simulated offline state');
});
const cachedFallback = await retryHarness.analytics.fetchCountMeta('/posts/cached/');
assert.equal(failedCacheCalls, 3);
assert.equal(cachedFallback.ok, true);
assert.equal(cachedFallback.stale, true);
assert.equal(cachedFallback.count, 9, 'the most recent successful value must survive a transient outage');

const cachedElement = createViewElement({
  'data-view-count': '',
  'data-view-path': '/posts/cached/',
  'data-view-suffix': '회',
  'data-view-error-text': '—',
});
retryHarness.setViewElements([cachedElement]);
retryHarness.analytics.setSiteId('jmchoi4u');
await retryHarness.analytics.fillViewCounts(retryHarness.document);
assert.equal(cachedElement.textContent, '9회');
assert.equal(cachedElement.dataset.viewState, 'stale');
assert.match(cachedElement.getAttribute('aria-label'), /최근 저장된 값/);

let notFoundCalls = 0;
const notFoundHarness = createHarness(async () => {
  notFoundCalls += 1;
  return new Response(JSON.stringify({ count: 0 }), { status: 404 });
});
const notFound = await notFoundHarness.analytics.fetchCountMeta('/posts/new/');
assert.equal(notFoundCalls, 1, 'a never-recorded path must not be retried');
assert.equal(notFound.ok, true);
assert.equal(notFound.count, 0);
assert.equal(notFound.status, 404);

let permanentFailureCalls = 0;
const failedHarness = createHarness(async () => {
  permanentFailureCalls += 1;
  throw new TypeError('simulated blocked request');
});
const failed = await failedHarness.analytics.fetchCountMeta('TOTAL');
assert.equal(permanentFailureCalls, 3);
assert.equal(failed.ok, false);
assert.equal(failed.count, 0);
assert.equal(failed.attempts, 3);

const googleHarness = createHarness(async () => new Response('{}', { status: 200 }), {
  contentCategory: '개발환경',
});
googleHarness.analytics.trackEvent('open_post', {
  component: 'home_feed',
  contextPath: '/posts/7/',
  parameters: {
    content_category: '개발환경',
    search_term: 'reader@example.com',
  },
  title: '맥북 Homebrew부터 Node.js까지',
});
let googleCommand = Array.from(googleHarness.window.dataLayer.at(-1));
assert.equal(googleCommand[0], 'event');
assert.equal(googleCommand[1], 'select_content');
assert.equal(googleCommand[2].content_type, 'article');
assert.equal(googleCommand[2].content_id, '/posts/7');
assert.equal(googleCommand[2].content_category, '개발환경');
assert.equal(googleCommand[2].source_component, 'home_feed');
assert.equal('search_term' in googleCommand[2], false, 'free-form user input must not reach GA4');
assert.equal(googleHarness.goatEvents.length, 1, 'GoatCounter success must not prevent GA4 delivery');

googleHarness.analytics.trackEvent('share_copy', {
  contextPath: '/posts/7/',
  title: '맥북 Homebrew부터 Node.js까지',
});
googleCommand = Array.from(googleHarness.window.dataLayer.at(-1));
assert.equal(googleCommand[1], 'share');
assert.equal(googleCommand[2].method, 'copy');
assert.equal(googleCommand[2].item_id, '/posts/7');

googleHarness.analytics.trackEvent('subscribe_success', {
  contextPath: '/posts/7/',
  title: '새 글 알림 구독',
});
googleCommand = Array.from(googleHarness.window.dataLayer.at(-1));
assert.equal(googleCommand[1], 'sign_up');
assert.equal(googleCommand[2].method, 'email');

let readingScroll = 0;
const readingContent = {
  isConnected: true,
  getBoundingClientRect() {
    return { height: 1000, top: -readingScroll };
  },
};
const readingHarness = createHarness(async () => new Response('{}', { status: 200 }), {
  contentCategory: '독후감',
  pathname: '/posts/6/',
  readingContent,
  title: '뭐, 어쩔 수가 없죠 | Jaemin Choi',
});
readingHarness.analytics.init();
const readingScrollHandler = readingHarness.eventHandlers.get('window:scroll');
assert.equal(typeof readingScrollHandler, 'function');
[200, 500, 700, 900].forEach((position) => {
  readingScroll = position;
  readingHarness.window.scrollY = position;
  readingScrollHandler();
});
const readingCommands = readingHarness.window.dataLayer
  .map((entry) => Array.from(entry))
  .filter((entry) => entry[0] === 'event' && entry[1] === 'read_progress');
assert.deepEqual(
  readingCommands.map((entry) => entry[2].read_percent),
  [25, 50, 75, 90],
  'article engagement must be recorded at all four reading thresholds'
);
assert.ok(readingCommands.every((entry) => entry[2].content_category === '독후감'));
assert.equal(readingHarness.goatEvents.length, 0, 'reading milestones must not inflate public views');

console.log('Blog analytics recovery and GA4 event checks passed.');
