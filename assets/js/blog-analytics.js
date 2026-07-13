/*
 * Shared, privacy-friendly analytics helpers for the public blog.
 *
 * Expected markup:
 *   <script defer src="/assets/js/blog-analytics.js" data-goatcounter-id="SITE_ID"></script>
 *   <span data-view-count data-view-path="/posts/2/" data-view-suffix="회"></span>
 *   <span data-view-count data-view-path="TOTAL" data-view-range="week"></span>
 *
 * GoatCounter's public counter is cached upstream for up to four hours. This
 * module adds a per-page Promise cache so the same path is never requested
 * twice by the home list, sidebar, and summary widgets.
 */
(function () {
  'use strict';

  if (window.JMBlogAnalytics) return;

  var loaderScript = document.currentScript;
  var configuredSiteId = sanitizeSiteId(
    loaderScript && loaderScript.getAttribute('data-goatcounter-id')
  );
  var counterCache = new Map();
  var numberFormatter = new Intl.NumberFormat('ko-KR');
  var compactFormatter = new Intl.NumberFormat('ko-KR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  var pendingEvents = [];
  var eventRetryTimer = null;
  var eventRetryCount = 0;
  var initialized = false;

  function sanitizeSiteId(value) {
    var candidate = String(value || '').trim();
    return /^[a-z0-9][a-z0-9-]*$/i.test(candidate) ? candidate : '';
  }

  function resolveSiteId() {
    if (configuredSiteId) return configuredSiteId;

    var rootId = sanitizeSiteId(document.documentElement.getAttribute('data-goatcounter-id'));
    if (rootId) {
      configuredSiteId = rootId;
      return configuredSiteId;
    }

    var meta = document.querySelector('meta[name="goatcounter-id"]');
    var metaId = sanitizeSiteId(meta && meta.getAttribute('content'));
    if (metaId) {
      configuredSiteId = metaId;
      return configuredSiteId;
    }

    var tracker = document.querySelector('script[data-goatcounter]');
    var endpoint = tracker && tracker.getAttribute('data-goatcounter');
    var match = String(endpoint || '').match(
      /^https:\/\/([a-z0-9][a-z0-9-]*)\.goatcounter\.com\/count(?:$|[/?#])/i
    );
    if (match) configuredSiteId = sanitizeSiteId(match[1]);

    return configuredSiteId;
  }

  function setSiteId(value) {
    configuredSiteId = sanitizeSiteId(value);
    counterCache.clear();
    return configuredSiteId;
  }

  function normalizePath(value) {
    var raw = String(value || '/').trim();
    if (raw.toUpperCase() === 'TOTAL') return 'TOTAL';

    try {
      if (/^https?:\/\//i.test(raw)) raw = new URL(raw).pathname;
    } catch (_) {
      raw = '/';
    }

    raw = raw.split('#')[0].split('?')[0] || '/';
    try {
      raw = decodeURIComponent(raw);
    } catch (_) {
      // Keep a malformed-but-safe path as text; encodeURIComponent below will
      // still prevent it from changing the counter endpoint structure.
    }

    if (raw.charAt(0) !== '/') raw = '/' + raw;
    raw = raw.replace(/\/{2,}/g, '/');
    if (raw.length > 1) raw = raw.replace(/\/+$/, '');
    return raw || '/';
  }

  function normalizeCounterOptions(value) {
    var input = typeof value === 'string' ? { start: value } : value || {};
    var start = String(input.start || input.range || '').trim().toLowerCase();
    var end = String(input.end || '').trim().toLowerCase();

    if (start === 'all' || start === 'lifetime' || start === 'total') start = '';

    var relativePeriod = /^(week|month|year)$/;
    var isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (start && !relativePeriod.test(start) && !isoDate.test(start)) start = '';
    if (end && !isoDate.test(end)) end = '';

    return { start: start, end: end };
  }

  function counterCacheKey(siteId, path, options) {
    return [siteId, path, options.start, options.end].join('|');
  }

  function buildCounterUrl(siteId, path, options) {
    var url = new URL(
      'https://' + siteId + '.goatcounter.com/counter/' + encodeURIComponent(path) + '.json'
    );
    if (options.start) url.searchParams.set('start', options.start);
    if (options.end) url.searchParams.set('end', options.end);
    return url.toString();
  }

  function parseCount(value) {
    if (typeof value === 'number') return Math.max(0, Math.floor(value));
    var digits = String(value || '').replace(/[^0-9]/g, '');
    return digits ? Math.max(0, parseInt(digits, 10) || 0) : 0;
  }

  function fetchCountMeta(pathValue, optionValue) {
    var siteId = resolveSiteId();
    var path = normalizePath(pathValue);
    var options = normalizeCounterOptions(optionValue);

    if (!siteId) {
      return Promise.resolve({ count: 0, ok: false, status: 0, path: path });
    }

    var key = counterCacheKey(siteId, path, options);
    if (counterCache.has(key)) return counterCache.get(key);

    var requestPromise = (async function () {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutId = controller
        ? window.setTimeout(function () {
            controller.abort();
          }, 8000)
        : null;

      try {
        var response = await fetch(buildCounterUrl(siteId, path, options), {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'default',
          signal: controller ? controller.signal : undefined,
        });

        // GoatCounter intentionally returns 404 for a path that has never been
        // recorded. That is a valid zero, not a service failure.
        if (response.status === 404) {
          return { count: 0, ok: true, status: 404, path: path };
        }
        if (!response.ok) {
          return { count: 0, ok: false, status: response.status, path: path };
        }

        var payload = await response.json();
        return {
          count: parseCount(payload && payload.count),
          ok: true,
          status: response.status,
          path: path,
        };
      } catch (_) {
        return { count: 0, ok: false, status: 0, path: path };
      } finally {
        if (timeoutId) window.clearTimeout(timeoutId);
      }
    })();

    counterCache.set(key, requestPromise);
    requestPromise.then(function (result) {
      // Share a transient failure between concurrent consumers, then permit a
      // later refresh to recover without requiring a full page reload.
      if (!result.ok) {
        window.setTimeout(function () {
          if (counterCache.get(key) === requestPromise) counterCache.delete(key);
        }, 30000);
      }
    });

    return requestPromise;
  }

  function fetchCount(pathValue, optionValue) {
    return fetchCountMeta(pathValue, optionValue).then(function (result) {
      return result.count;
    });
  }

  function fetchTotals() {
    return Promise.all([
      fetchCount('TOTAL'),
      fetchCount('TOTAL', 'week'),
      fetchCount('TOTAL', 'month'),
    ]).then(function (counts) {
      return { lifetime: counts[0], week: counts[1], month: counts[2] };
    });
  }

  function formatCount(count, format) {
    return format === 'compact' ? compactFormatter.format(count) : numberFormatter.format(count);
  }

  function viewOptionsFor(element) {
    return {
      start: element.getAttribute('data-view-range') || element.getAttribute('data-view-start'),
      end: element.getAttribute('data-view-end'),
    };
  }

  function renderViewCount(element, result) {
    if (!element) return;

    if (!result.ok) {
      element.dataset.viewState = 'error';
      element.textContent = element.getAttribute('data-view-error-text') || '—';
      element.setAttribute('aria-label', '조회수를 불러오지 못했습니다');
      return;
    }

    var prefix = element.getAttribute('data-view-prefix') || '';
    var suffix = element.getAttribute('data-view-suffix') || '';
    var formatted = formatCount(result.count, element.getAttribute('data-view-format'));
    element.textContent = prefix + formatted + suffix;
    element.dataset.viewState = 'loaded';
    element.dataset.viewValue = String(result.count);

    var accessibleLabel = element.getAttribute('data-view-label');
    if (accessibleLabel) {
      element.setAttribute(
        'aria-label',
        accessibleLabel.replace(/\{count\}/g, numberFormatter.format(result.count))
      );
    } else {
      element.setAttribute('aria-label', numberFormatter.format(result.count) + '회 조회');
    }

    if (element.hasAttribute('data-view-hide-zero')) element.hidden = result.count === 0;
  }

  function fillViewCounts(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var elements = Array.from(
      scope.querySelectorAll('[data-view-count][data-view-path]')
    );

    return Promise.all(
      elements.map(function (element) {
        element.dataset.viewState = 'loading';
        return fetchCountMeta(element.getAttribute('data-view-path'), viewOptionsFor(element)).then(
          function (result) {
            renderViewCount(element, result);
            return result;
          }
        );
      })
    );
  }

  function publishedTimestamp(element) {
    var parsed = Date.parse(element.getAttribute('data-published') || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function updatePopularRank(item, rank) {
    var badge = item.querySelector('[data-popular-rank]');
    if (!badge) return;
    badge.textContent = String(rank);
    badge.classList.remove('rank-1', 'rank-2', 'rank-3');
    if (rank <= 3) badge.classList.add('rank-' + rank);
  }

  function setPopularHeading(root, useViews) {
    var heading = root.querySelector('[data-popular-heading]');
    if (heading) heading.textContent = useViews ? '인기 글' : '최근 글';

    var icon = root.querySelector('[data-popular-icon]');
    if (icon) {
      icon.classList.toggle('fa-trophy', useViews);
      icon.classList.toggle('fa-clock', !useViews);
    }
  }

  async function sortPopularRoot(root) {
    var list = root.querySelector('[data-popular-list]');
    var items = Array.from(root.querySelectorAll('[data-popular-item][data-view-path]'));
    if (!list || !items.length) return [];

    root.setAttribute('aria-busy', 'true');
    var rows = await Promise.all(
      items.map(async function (item, index) {
        var result = await fetchCountMeta(item.getAttribute('data-view-path'));
        var countElement = item.querySelector('[data-view-count][data-view-path]');
        if (countElement) renderViewCount(countElement, result);
        return {
          item: item,
          index: index,
          published: publishedTimestamp(item),
          result: result,
        };
      })
    );

    var hasPositiveCount = rows.some(function (row) {
      return row.result.ok && row.result.count > 0;
    });

    rows.sort(function (left, right) {
      if (hasPositiveCount && right.result.count !== left.result.count) {
        return right.result.count - left.result.count;
      }
      if (right.published !== left.published) return right.published - left.published;
      return left.index - right.index;
    });

    var requestedLimit = parseInt(root.getAttribute('data-popular-limit') || '3', 10);
    var limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 3;

    rows.forEach(function (row, index) {
      list.appendChild(row.item);
      row.item.hidden = index >= limit;
      updatePopularRank(row.item, index + 1);

      var countElement = row.item.querySelector('[data-view-count]');
      if (countElement) countElement.hidden = !hasPositiveCount;
    });

    setPopularHeading(root, hasPositiveCount);
    root.dataset.popularState = hasPositiveCount ? 'popular' : 'recent';
    root.setAttribute('aria-busy', 'false');
    return rows;
  }

  function sortPopular(root) {
    var scope = root && root.querySelectorAll ? root : document;
    return Promise.all(
      Array.from(scope.querySelectorAll('[data-popular-root]')).map(sortPopularRoot)
    );
  }

  function boolFromData(value) {
    if (value === null || typeof value === 'undefined') return false;
    return value !== '0' && value !== 'false' && value !== 'off';
  }

  function eventPath(name, options) {
    var cleanName = String(name || '')
      .trim()
      .replace(/^\/+/, '')
      .slice(0, 120);
    if (!cleanName) return '';

    if (options && options.eventPath) {
      return String(options.eventPath).replace(/^\/+/, '').slice(0, 200);
    }

    if (options && options.includePath === false) return cleanName;
    var contextPath = normalizePath((options && options.contextPath) || window.location.pathname);
    return (cleanName + ':' + contextPath).slice(0, 200);
  }

  function dispatchEvent(payload) {
    if (
      window.goatcounter &&
      typeof window.goatcounter.count === 'function'
    ) {
      try {
        window.goatcounter.count(payload);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function flushEventQueue() {
    eventRetryTimer = null;
    if (!pendingEvents.length) return;

    if (window.goatcounter && typeof window.goatcounter.count === 'function') {
      pendingEvents.splice(0).forEach(dispatchEvent);
      eventRetryCount = 0;
      return;
    }

    eventRetryCount += 1;
    if (eventRetryCount >= 32) {
      pendingEvents.length = 0;
      eventRetryCount = 0;
      return;
    }
    eventRetryTimer = window.setTimeout(flushEventQueue, 250);
  }

  function trackEvent(name, options) {
    var resolvedOptions = options || {};
    var path = eventPath(name, resolvedOptions);
    if (!path) return false;

    var payload = {
      path: path,
      title: String(resolvedOptions.title || document.title || name).slice(0, 200),
      event: true,
      no_session: Boolean(resolvedOptions.noSession),
    };

    if (dispatchEvent(payload)) return true;
    if (pendingEvents.length < 20) pendingEvents.push(payload);
    if (!eventRetryTimer) eventRetryTimer = window.setTimeout(flushEventQueue, 0);
    return false;
  }

  function bindDataEvents() {
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-analytics-event], [data-analytics-click]')
        : null;
      if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;

      var name =
        target.getAttribute('data-analytics-event') ||
        target.getAttribute('data-analytics-click');
      var scope = target.getAttribute('data-analytics-scope');

      trackEvent(name, {
        contextPath: target.getAttribute('data-analytics-path') || window.location.pathname,
        includePath: scope !== 'global',
        title: target.getAttribute('data-analytics-title') || target.textContent.trim(),
        noSession: boolFromData(target.getAttribute('data-analytics-no-session')),
      });
    });

    document.addEventListener('jm:analytics', function (event) {
      var detail = event.detail || {};
      trackEvent(detail.name, detail.options || {});
    });
  }

  function safeSessionGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeSessionSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (_) {
      // Analytics must never interfere with reading when storage is blocked.
    }
  }

  function setupReadingDepth() {
    var explicitContent = document.querySelector('[data-reading-content]');
    var content =
      explicitContent ||
      document.querySelector('body.post-page article .content') ||
      document.querySelector('article .content');
    if (!content) return;

    var isPost = /^\/posts\//.test(window.location.pathname);
    if (!explicitContent && !isPost) return;

    var normalizedPath = normalizePath(window.location.pathname);
    var storageKey = 'jm-read-90:' + normalizedPath;
    if (safeSessionGet(storageKey) === '1') return;

    var fired = false;
    var scheduled = false;

    function cleanup() {
      window.removeEventListener('scroll', scheduleCheck);
      window.removeEventListener('resize', scheduleCheck);
    }

    function checkDepth() {
      scheduled = false;
      if (fired || !content.isConnected) return;

      var rect = content.getBoundingClientRect();
      if (rect.height <= 0) return;

      var contentTop = rect.top + window.scrollY;
      var viewportBottom = window.scrollY + window.innerHeight;
      var ninetyPercent = contentTop + rect.height * 0.9;
      if (viewportBottom < ninetyPercent) return;

      fired = true;
      safeSessionSet(storageKey, '1');
      cleanup();
      trackEvent(content.getAttribute('data-reading-event') || 'read-90', {
        contextPath: normalizedPath,
        title: '90% 읽음 · ' + document.title,
      });
    }

    function scheduleCheck() {
      if (scheduled) return;
      scheduled = true;
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(checkDepth);
      } else {
        window.setTimeout(checkDepth, 16);
      }
    }

    window.addEventListener('scroll', scheduleCheck, { passive: true });
    window.addEventListener('resize', scheduleCheck, { passive: true });
    scheduleCheck();
  }

  function readingText(target) {
    var clone = target.cloneNode(true);
    clone
      .querySelectorAll('script, style, noscript, svg, pre, code, [aria-hidden="true"]')
      .forEach(function (node) {
        node.remove();
      });
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function calculateReadingTime(text) {
    var koreanMatches = String(text || '').match(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g);
    var englishMatches = String(text || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
    var koreanCharacters = koreanMatches ? koreanMatches.length : 0;
    var englishWords = englishMatches ? englishMatches.length : 0;
    var minutes = Math.max(1, Math.ceil(koreanCharacters / 500 + englishWords / 220));

    return {
      minutes: minutes,
      koreanCharacters: koreanCharacters,
      englishWords: englishWords,
    };
  }

  function resolveReadingTarget(marker) {
    var selector = marker.getAttribute('data-reading-target');
    if (selector) {
      try {
        var selected = document.querySelector(selector);
        if (selected) return selected;
      } catch (_) {
        // Fall through to the structural selectors for an invalid selector.
      }
    }

    var article = marker.closest('article');
    return (
      (article && article.querySelector('.content')) ||
      document.querySelector('[data-reading-content]') ||
      document.querySelector('article .content')
    );
  }

  function hydrateReadingTimes(root) {
    var scope = root && root.querySelectorAll ? root : document;
    Array.from(scope.querySelectorAll('[data-reading-time]')).forEach(function (marker) {
      var target = resolveReadingTarget(marker);
      if (!target) return;

      var result = calculateReadingTime(readingText(target));
      var value = marker.querySelector('[data-reading-time-value]') || marker;
      value.textContent = result.minutes + '분 읽기';
      marker.dataset.readingMinutes = String(result.minutes);
      marker.dataset.readingKoreanChars = String(result.koreanCharacters);
      marker.dataset.readingEnglishWords = String(result.englishWords);
      marker.setAttribute('aria-label', '예상 읽기 시간 ' + result.minutes + '분');
    });
  }

  function refresh(root) {
    hydrateReadingTimes(root);
    return Promise.all([fillViewCounts(root), sortPopular(root)]);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    bindDataEvents();
    hydrateReadingTimes(document);
    setupReadingDepth();
    fillViewCounts(document);
    sortPopular(document);
  }

  window.JMBlogAnalytics = {
    version: '1.0.0',
    init: init,
    refresh: refresh,
    setSiteId: setSiteId,
    normalizePath: normalizePath,
    fetchCount: fetchCount,
    fetchCountMeta: fetchCountMeta,
    fetchTotals: fetchTotals,
    fillViewCounts: fillViewCounts,
    sortPopular: sortPopular,
    trackEvent: trackEvent,
    calculateReadingTime: calculateReadingTime,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
