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
    addEventListener(type, handler) { handlers.set(type, handler); },
    click(target = this) { handlers.get('click')?.({ target }); },
    closest() { return this; },
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
  };
}

function createHarness(hash = '') {
  const groups = ['writing', 'dev', 'all'].map((group) => element({ 'data-home-filter': group }));
  const subs = [['all', 'all'], ['writing', 'essay'], ['dev', '개발환경']].map(([parent, sub]) =>
    element({ 'data-home-parent': parent, 'data-home-sub-filter': sub })
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
  function bar(buttons) {
    return Object.assign(element(), {
      querySelectorAll() { return buttons; },
      contains(button) { return buttons.includes(button); },
    });
  }
  const groupBar = bar(groups);
  const subBar = bar(subs);
  const sortBar = bar(sorts);
  const empty = element();
  const shortcut = element();
  let searches = 0;
  const handlers = new Map();
  const list = {
    children: [...cards],
    appendChild(card) {
      this.children = this.children.filter((entry) => entry !== card);
      this.children.push(card);
    },
  };
  const window = {
    location: { hash },
    addEventListener(type, handler) { handlers.set(type, handler); },
    JMBlogAnalytics: { trackEvent() {}, fillViewCounts() { return Promise.resolve(); } },
  };
  const document = {
    readyState: 'complete',
    addEventListener(type, handler) { handlers.set('document:' + type, handler); },
    querySelector(selector) {
      return {
        '.home-filter': groupBar,
        '[data-home-subfilter]': subBar,
        '.home-sort': sortBar,
        '[data-home-filter-empty]': empty,
        '[data-home-search]': shortcut,
      }[selector] ?? null;
    },
    querySelectorAll() { return cards; },
    getElementById(id) {
      if (id === 'post-list') return list;
      if (id === 'search-trigger') return { click() { searches += 1; } };
      return null;
    },
  };
  vm.runInNewContext(source, { document, window });
  return {
    cards, empty, shortcut, window,
    get searches() { return searches; },
    visible() { return list.children.filter((card) => !card.hidden).map((card) => card.id); },
    group(value) { groupBar.click(groups.find((button) => button.getAttribute('data-home-filter') === value)); },
    sort(value) { sortBar.click(sorts.find((button) => button.getAttribute('data-home-sort') === value)); },
    changeHash(value) { window.location.hash = value; handlers.get('hashchange')?.(); },
    emit(type) { handlers.get('document:' + type)?.(); },
  };
}

const normal = createHarness();
assert.deepEqual(normal.visible(), ['essay-pinned', 'essay-new']);
normal.group('dev');
assert.deepEqual(normal.visible(), ['dev-new', 'dev-old']);
normal.group('all');
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

const malformed = createHarness('#%E0%A4%A');
assert.deepEqual(malformed.visible(), ['essay-pinned', 'essay-new']);
malformed.shortcut.click();
assert.equal(malformed.searches, 1, 'malformed deep links must not prevent search initialization');
assert.doesNotThrow(() => malformed.changeHash('#%'));

console.log('Home filtering, sorting, deep-link recovery, and search initialization checks passed.');
