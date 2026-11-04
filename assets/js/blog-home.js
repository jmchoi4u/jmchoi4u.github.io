(function () {
  'use strict';

  /*
   * Home feed: category filter and sort.
   *
   * The category lives in the URL hash — #all, #writing/에세이, #dev — and every
   * category link on the site (the tabs above the list, the sidebar, /browse/)
   * points at /#group/sub. On the home page that is a plain hash change,
   * applied here in place; from any other page it is a navigation that lands
   * on the filtered list.
   */
  function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase('ko-KR');
  }

  function init() {
    var list = document.getElementById('post-list');
    if (!list) return;

    var items = Array.prototype.slice.call(list.querySelectorAll('[data-home-post]'));
    var empty = document.querySelector('[data-home-empty]');
    var tabs = document.getElementById('post-list-head');
    var sortBar = document.querySelector('.jm-sort');
    var sortButtons = sortBar
      ? Array.prototype.slice.call(sortBar.querySelectorAll('[data-home-sort]'))
      : [];

    var activeGroup = 'all';
    var activeSub = 'all';
    var activeSort = 'recent';

    function publishedAt(item) {
      return parseInt(item.getAttribute('data-home-date') || '0', 10) || 0;
    }

    /* blog-analytics.js stores the resolved counter on the element as
       `data-view-value`; it is absent until the fetch lands, which is why
       reorder() runs again on jm:view-counts-updated. */
    function viewsOf(item) {
      var counter = item.querySelector('[data-view-count][data-view-path]');
      var value = parseInt(counter && counter.dataset ? counter.dataset.viewValue : '', 10);
      return isNaN(value) ? -1 : value;
    }

    function reorder() {
      var ordered = items.slice();
      if (activeSort === 'popular') {
        ordered.sort(function (a, b) {
          return viewsOf(b) - viewsOf(a) || publishedAt(b) - publishedAt(a);
        });
      } else {
        ordered.sort(function (a, b) {
          var pin = (b.getAttribute('data-home-pin') === '1') - (a.getAttribute('data-home-pin') === '1');
          return pin || publishedAt(b) - publishedAt(a);
        });
      }
      ordered.forEach(function (item) { list.appendChild(item); });
    }

    function apply() {
      var visible = 0;
      items.forEach(function (item) {
        var show =
          (activeGroup === 'all' || normalize(item.getAttribute('data-home-group')) === activeGroup) &&
          (activeSub === 'all' || normalize(item.getAttribute('data-home-sub')) === activeSub);
        item.hidden = !show;
        if (show) visible += 1;
      });
      if (empty) empty.hidden = visible !== 0;

      Array.prototype.forEach.call(document.querySelectorAll('[data-cat-link]'), function (link) {
        var on =
          normalize(link.getAttribute('data-cat-group')) === activeGroup &&
          normalize(link.getAttribute('data-cat-sub')) === activeSub;
        link.classList.toggle('is-current', on);
        if (on) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });

      /* Keep the chosen tab in view when the row scrolls sideways on a phone. */
      var current = tabs && tabs.querySelector('.is-current');
      if (current && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      reorder();
    }

    function readHash() {
      var hash = String(window.location.hash || '').replace(/^#/, '');
      var parts = hash.split('/');
      var group;
      var sub;
      try {
        group = normalize(decodeURIComponent(parts[0])) || 'all';
        sub = parts.length > 1 ? normalize(decodeURIComponent(parts.slice(1).join('/'))) : 'all';
      } catch (_) {
        return { group: 'all', sub: 'all' };
      }
      if (group !== 'all' && group !== 'writing' && group !== 'dev') return { group: 'all', sub: 'all' };
      if (group === 'all') return { group: 'all', sub: 'all' };
      /* A renamed or removed sub-category, or one from the other shelf, keeps
         the shelf rather than emptying the feed. */
      var known = items.some(function (item) {
        return normalize(item.getAttribute('data-home-group')) === group &&
          normalize(item.getAttribute('data-home-sub')) === sub;
      });
      return { group: group, sub: sub && known ? sub : 'all' };
    }

    function closeDrawer() {
      /* Chirpy's drawer toggles on a click of #mask; there is no close API. */
      if (!document.body.hasAttribute('sidebar-display')) return;
      var mask = document.getElementById('mask');
      if (mask) mask.click();
    }

    function onHash(scroll) {
      var state = readHash();
      activeGroup = state.group;
      activeSub = state.sub;
      apply();
      closeDrawer();
      if (scroll && tabs) tabs.scrollIntoView({ block: 'start' });
    }

    if (sortBar) {
      sortBar.addEventListener('click', function (event) {
        var button = event.target.closest('[data-home-sort]');
        if (!button) return;
        activeSort = normalize(button.getAttribute('data-home-sort'));
        sortButtons.forEach(function (candidate) {
          var on = candidate === button;
          candidate.classList.toggle('active', on);
          candidate.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        reorder();
        if (activeSort === 'popular' && window.JMBlogAnalytics) {
          /* Promise-cached: reuses the requests already in flight. */
          window.JMBlogAnalytics.fillViewCounts(list).then(reorder).catch(function () {});
        }
        if (window.JMBlogAnalytics) {
          window.JMBlogAnalytics.trackEvent('home_sort', {
            component: 'home_sort',
            title: button.textContent.trim(),
            includePath: false,
            parameters: { filter_name: activeSort },
          });
        }
      });
    }

    document.addEventListener('jm:view-counts-updated', function () {
      if (activeSort === 'popular') reorder();
    });

    /* Picking the category already in the hash fires no hashchange, so the
       drawer is closed on the click itself. */
    document.addEventListener('click', function (event) {
      if (event.target.closest('#sidebar [data-cat-link]')) closeDrawer();
    });

    /* Arriving with a category in the hash (from another page, or from the
       sidebar) jumps to the list; a tab tapped right here leaves the page where
       it is. Safari does not focus a tapped link, so the tap is timed instead. */
    var lastTabTap = 0;
    if (tabs) {
      tabs.addEventListener('click', function (event) {
        if (event.target.closest('[data-cat-link]')) lastTabTap = Date.now();
      });
    }
    onHash(Boolean(window.location.hash && window.location.hash !== '#all'));
    window.addEventListener('hashchange', function () {
      onHash(Date.now() - lastTabTap > 1000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
