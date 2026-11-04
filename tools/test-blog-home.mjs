#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/blog-home.js', import.meta.url), 'utf8');

function element(attributes = {}) {
  const handlers = new Map();
  const values = new Map(Object.entries(attributes));
  const classes = new Set();
  return {
    hidden: false,
    textContent: 'Test',
    dataset: {},
    getAttribute(name) { return values.get(name) ?? null; },
    setAttribute(name, value) { values.set(name, String(value)); },
    removeAttribute(name) { values.delete(name); },
    hasAttribute(name) { return values.has(name); },
    addEventListener(type, handler) { handlers.set(type, handler); },
    dispatch(type, event) { handlers.get(type)?.(event); },
    closest() { return this; },
    scrollIntoView() {},
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

function createHarness(hash = '') {
  /* The tabs above the list: 전체, the writing shelf's sub-categories, dev. */
  const links = [['all', 'all'], ['writing', 'essay'], ['dev', 'all']].map(([group, sub]) =>
    element({ 'data-cat-group': group, 'data-cat-sub': sub })
  );
  const sorts = ['recent', 'popular'].map((sort) => element({ 'data-home-sort': sort }));
  const cards = [
    ['essay-new', 'writing', 'essay', '200', '0', '10'],
    ['essay-pinned', 'writing', 'essay', '100', '1', '1'],
    ['dev-new', 'dev', '개발환경', '300', '0', '20'],
    ['dev-old', 'dev', '개발환경', '50', '0', '40'],
  ].map(([id, group, sub, date, pin, views]) => {
    const card = element({ 'data-home-group': group, 'data-home-sub': sub, 'data-home-date': date, 'data-home-pin': pin });
    card.id = id;
    card.counter = { dataset: { viewValue: views } };
    card.querySelector = () => card.counter;
    return card;
  });

  const sortBar = Object.assign(element(), {
    querySelectorAll() { return sorts; },
  });
  const tabs = Object.assign(element(), {
    querySelector(selector) {
      return selector === '.is-current' ? links.find((link) => link.classList.contains('is-current')) ?? null : null;
    },
  });
  const empty = element();
  const handlers = new Map();
  const list = {
    children: [...cards],
    querySelectorAll() { return cards; },
    appendChild(card) {
      this.children = this.children.filter((entry) => entry !== card);
      this.children.push(card);
    },
  };
  const window = {
    location: { hash },
    addEventListener(type, handler) { handlers.set(type, handler); },
    requestAnimationFrame(callback) { callback(); },
    JMBlogAnalytics: { trackEvent() {}, fillViewCounts() { return Promise.resolve(); } },
  };
  const document = {
    readyState: 'complete',
    body: element(),
    addEventListener(type, handler) { handlers.set('document:' + type, handler); },
    querySelector(selector) {
      return { '.jm-sort': sortBar, '[data-home-empty]': empty }[selector] ?? null;
    },
    querySelectorAll(selector) { return selector === '[data-cat-link]' ? links : []; },
    getElementById(id) {
      if (id === 'post-list') return list;
      if (id === 'post-list-head') return tabs;
      return null;
    },
  };
  vm.runInNewContext(source, { document, window, Date });
  return {
    cards, empty, links,
    visible() { return list.children.filter((card) => !card.hidden).map((card) => card.id); },
    current() { return links.filter((link) => link.classList.contains('is-current')).map((link) => link.getAttribute('data-cat-group') + '/' + link.getAttribute('data-cat-sub')); },
    sort(value) { sortBar.dispatch('click', { target: sorts.find((button) => button.getAttribute('data-home-sort') === value) }); },
    changeHash(value) { window.location.hash = value; handlers.get('hashchange')?.(); },
    emit(type) { handlers.get('document:' + type)?.(); },
  };
}

const normal = createHarness();
assert.deepEqual(normal.visible(), ['essay-pinned', 'dev-new', 'essay-new', 'dev-old'], 'the feed opens on every post, pinned first');
assert.deepEqual(normal.current(), ['all/all'], 'the 전체 tab starts selected');
normal.changeHash('#dev');
assert.deepEqual(normal.visible(), ['dev-new', 'dev-old']);
assert.deepEqual(normal.current(), ['dev/all']);
normal.changeHash('#writing/essay');
assert.deepEqual(normal.visible(), ['essay-pinned', 'essay-new']);
normal.changeHash('#all');
normal.sort('popular');
await Promise.resolve();
assert.deepEqual(normal.visible(), ['dev-old', 'dev-new', 'essay-new', 'essay-pinned']);
normal.cards.find((card) => card.id === 'essay-pinned').counter.dataset.viewValue = '60';
normal.emit('jm:view-counts-updated');
assert.deepEqual(normal.visible(), ['essay-pinned', 'dev-old', 'dev-new', 'essay-new'], 'popular sorting must follow recovered view counts');
normal.sort('recent');
assert.deepEqual(normal.visible(), ['essay-pinned', 'dev-new', 'essay-new', 'dev-old']);
normal.cards.find((card) => card.id === 'dev-old').counter.dataset.viewValue = '100';
normal.emit('jm:view-counts-updated');
assert.deepEqual(normal.visible(), ['essay-pinned', 'dev-new', 'essay-new', 'dev-old'], 'view updates must preserve recent sorting');

const deepLink = createHarness('#dev/' + encodeURIComponent('개발환경'));
assert.deepEqual(deepLink.visible(), ['dev-new', 'dev-old']);
deepLink.changeHash('#dev/no-longer-a-category');
assert.deepEqual(deepLink.visible(), ['dev-new', 'dev-old'], 'stale subcategory links should retain the valid group');
deepLink.changeHash('#dev/essay');
assert.deepEqual(deepLink.visible(), ['dev-new', 'dev-old'], 'a subcategory from another group must not empty the feed');
deepLink.changeHash('#nonsense');
assert.deepEqual(deepLink.visible(), ['essay-pinned', 'dev-new', 'essay-new', 'dev-old'], 'an unknown group falls back to every post');

const malformed = createHarness('#%E0%A4%A');
assert.deepEqual(malformed.visible(), ['essay-pinned', 'dev-new', 'essay-new', 'dev-old'], 'malformed deep links fall back to every post');
assert.doesNotThrow(() => malformed.changeHash('#%'));
assert.equal(malformed.empty.hidden, true, 'the empty note stays hidden while posts are shown');

console.log('Home filtering, sorting, and deep-link recovery checks passed.');
