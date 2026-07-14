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

function createHarness(fetchImpl) {
  const storage = createStorage();
  const eventHandlers = new Map();
  let viewElements = [];
  let currentFetch = fetchImpl;
  let backgroundTimerId = 10000;

  const document = {
    readyState: 'loading',
    currentScript: {
      getAttribute(name) { return name === 'data-goatcounter-id' ? 'jmchoi4u' : null; },
    },
    documentElement: { getAttribute() { return null; } },
    addEventListener(type, handler) { eventHandlers.set(`document:${type}`, handler); },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '[data-view-count][data-view-path]' ? viewElements : [];
    },
  };

  const window = {
    addEventListener(type, handler) { eventHandlers.set(`window:${type}`, handler); },
    clearTimeout(id) {
      if (id && typeof id === 'object') clearTimeout(id);
    },
    location: { pathname: '/' },
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
    window,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    analytics: window.JMBlogAnalytics,
    document,
    eventHandlers,
    setFetch(nextFetch) { currentFetch = nextFetch; },
    setViewElements(elements) { viewElements = elements; },
    storage,
  };
}

let retryCalls = 0;
const retryHarness = createHarness(async () => {
  retryCalls += 1;
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

console.log('Blog analytics recovery checks passed.');
