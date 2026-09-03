(function () {
  'use strict';

  function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase('ko-KR');
  }

  /*
   * The home feed opens on `writing` (essays) and keeps `dev` one tap away, so the
   * front page reads like a magazine rather than a mixed changelog. Every post is in
   * the HTML either way — `hidden` only affects rendering, not crawlability — so a
   * search result still lands a reader straight on a dev post.
   *
   * Two levels: the group row (writing / dev / 전체) and, under it, the sub-category
   * row for whichever group is active.
   */
  function initFilters() {
    var groupBar = document.querySelector('.home-filter');
    if (!groupBar) return;

    var subBar = document.querySelector('[data-home-subfilter]');
    var groupButtons = Array.prototype.slice.call(groupBar.querySelectorAll('[data-home-filter]'));
    var subButtons = subBar
      ? Array.prototype.slice.call(subBar.querySelectorAll('[data-home-sub-filter]'))
      : [];
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-home-post]'));
    var empty = document.querySelector('[data-home-filter-empty]');

    var list = document.getElementById('post-list');
    var sortBar = document.querySelector('.home-sort');
    var sortButtons = sortBar
      ? Array.prototype.slice.call(sortBar.querySelectorAll('[data-home-sort]'))
      : [];

    var activeGroup = 'writing';
    var activeSub = 'all';
    var activeSort = 'recent';

    function press(button, on) {
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function publishedAt(card) {
      return parseInt(card.getAttribute('data-home-date') || '0', 10) || 0;
    }

    /* blog-analytics.js stashes the resolved counter on the element as
       `data-view-value`; it is absent until the fetch lands, which is why
       reorder() is called again once fillViewCounts resolves. */
    function viewsOf(card) {
      var counter = card.querySelector('[data-view-count][data-view-path]');
      if (!counter) return -1;
      var raw = counter.dataset ? counter.dataset.viewValue : null;
      if (raw === null || typeof raw === 'undefined' || raw === '') return -1;
      var value = parseInt(raw, 10);
      return isNaN(value) ? -1 : value;
    }

    function reorder() {
      if (!list) return;
      var ordered = cards.slice();

      if (activeSort === 'popular') {
        ordered.sort(function (a, b) {
          var diff = viewsOf(b) - viewsOf(a);
          if (diff !== 0) return diff;
          return publishedAt(b) - publishedAt(a); // ties keep newest first
        });
      } else {
        ordered.sort(function (a, b) {
          // Pinned posts lead the chronological view, as they do on a fresh build.
          var pin = (b.getAttribute('data-home-pin') === '1') - (a.getAttribute('data-home-pin') === '1');
          if (pin !== 0) return pin;
          return publishedAt(b) - publishedAt(a);
        });
      }

      ordered.forEach(function (card) { list.appendChild(card); });
    }

    function apply() {
      groupButtons.forEach(function (button) {
        press(button, normalize(button.getAttribute('data-home-filter')) === activeGroup);
      });

      subButtons.forEach(function (button) {
        var parent = normalize(button.getAttribute('data-home-parent'));
        // "전체" belongs to every group; the rest only to their own.
        var belongs = parent === 'all' || parent === activeGroup;
        button.hidden = !belongs;
        press(button, belongs && normalize(button.getAttribute('data-home-sub-filter')) === activeSub);
      });

      // With no group selected there is nothing to narrow, so hide the second row.
      if (subBar) {
        var usable = subButtons.filter(function (button) {
          return !button.hidden && normalize(button.getAttribute('data-home-sub-filter')) !== 'all';
        });
        subBar.hidden = usable.length === 0;
      }

      var visible = 0;
      cards.forEach(function (card) {
        var group = normalize(card.getAttribute('data-home-group'));
        var sub = normalize(card.getAttribute('data-home-sub'));
        var show = (activeGroup === 'all' || group === activeGroup) &&
          (activeSub === 'all' || sub === activeSub);
        card.hidden = !show;
        if (show) visible += 1;
      });

      if (empty) empty.hidden = visible !== 0;
      reorder();
    }

    function track(name, label, value) {
      if (!window.JMBlogAnalytics) return;
      window.JMBlogAnalytics.trackEvent(name, {
        component: name,
        title: label,
        includePath: false,
        parameters: { filter_name: value },
      });
    }

    groupBar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-home-filter]');
      if (!button || !groupBar.contains(button)) return;
      activeGroup = normalize(button.getAttribute('data-home-filter'));
      activeSub = 'all'; // a new shelf starts unfiltered
      apply();
      track('home_filter', button.textContent.trim(), activeGroup);
    });

    if (subBar) {
      subBar.addEventListener('click', function (event) {
        var button = event.target.closest('[data-home-sub-filter]');
        if (!button || !subBar.contains(button)) return;
        activeSub = normalize(button.getAttribute('data-home-sub-filter'));
        apply();
        track('home_subfilter', button.textContent.trim(), activeSub);
      });
    }

    if (sortBar) {
      sortBar.addEventListener('click', function (event) {
        var button = event.target.closest('[data-home-sort]');
        if (!button || !sortBar.contains(button)) return;
        activeSort = normalize(button.getAttribute('data-home-sort'));
        sortButtons.forEach(function (candidate) { press(candidate, candidate === button); });
        apply();

        if (activeSort === 'popular' && window.JMBlogAnalytics) {
          // Counters may still be in flight; fillViewCounts is Promise-cached so
          // this reuses the requests already made rather than issuing new ones.
          window.JMBlogAnalytics.fillViewCounts(document).then(reorder).catch(function () {});
        }
        track('home_sort', button.textContent.trim(), activeSort);
      });
    }

    /* Deep links: /#dev, /#writing, or /#dev/개발환경 open the feed already filtered,
       so a nav link or an outside link can point straight at a shelf. */
    function applyHash() {
      var hash = decodeURIComponent(String(window.location.hash || '').replace(/^#/, ''));
      if (!hash) return;
      var parts = hash.split('/');
      var group = normalize(parts[0]);
      var known = groupButtons.some(function (button) {
        return normalize(button.getAttribute('data-home-filter')) === group;
      });
      if (!known) return;
      activeGroup = group;
      activeSub = parts[1] ? normalize(parts[1]) : 'all';
      apply();
    }

    apply();
    applyHash();
    window.addEventListener('hashchange', applyHash);
  }

  function initSearchShortcut() {
    var shortcut = document.querySelector('[data-home-search]');
    if (!shortcut) return;
    shortcut.addEventListener('click', function () {
      var trigger = document.getElementById('search-trigger');
      if (trigger) trigger.click();
    });
  }

  function init() {
    initFilters();
    initSearchShortcut();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
