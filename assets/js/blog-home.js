(function () {
  'use strict';

  function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase('ko-KR');
  }

  function initFilters() {
    var toolbar = document.querySelector('.home-filter');
    if (!toolbar) return;

    var buttons = Array.from(toolbar.querySelectorAll('[data-home-filter]'));
    var cards = Array.from(document.querySelectorAll('[data-home-post]'));
    var empty = document.querySelector('[data-home-filter-empty]');

    toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-home-filter]');
      if (!button || !toolbar.contains(button)) return;

      var selected = normalize(button.getAttribute('data-home-filter'));
      var visible = 0;

      buttons.forEach(function (candidate) {
        var active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      cards.forEach(function (card) {
        var categories = String(card.getAttribute('data-home-categories') || '')
          .split('|')
          .map(normalize);
        var show = selected === 'all' || categories.indexOf(selected) !== -1;
        card.hidden = !show;
        if (show) visible += 1;
      });

      if (empty) empty.hidden = visible !== 0;
      if (window.JMBlogAnalytics) {
        window.JMBlogAnalytics.trackEvent('home_filter', {
          title: button.textContent.trim(),
          includePath: false,
        });
      }
    });
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
