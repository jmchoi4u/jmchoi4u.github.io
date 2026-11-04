/*
 * New-post email subscription dialog (_includes/subscribe-modal.html).
 * Any element with [data-subscribe-open] opens it; focus is trapped while it
 * is open and handed back to the opener when it closes.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://jm-studio-auth.jmchoi4u.workers.dev/subscribe';

  var overlay = document.getElementById('subscribe-overlay');
  if (!overlay) return;

  var form = document.getElementById('subscribe-form');
  var email = document.getElementById('subscribe-email');
  var submit = document.getElementById('subscribe-submit');
  var error = document.getElementById('subscribe-error');
  var done = document.getElementById('subscribe-done');
  var returnFocus = null;

  function isOpen() {
    return overlay.classList.contains('open');
  }

  function open(trigger) {
    returnFocus = trigger || document.activeElement;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    error.textContent = '';
    done.hidden = true;
    form.hidden = false;
    window.setTimeout(function () { email.focus(); }, 60);
  }

  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-subscribe-open]');
    if (opener) {
      event.preventDefault();
      open(opener);
      return;
    }
    if (!isOpen()) return;
    if (event.target === overlay || event.target.closest('[data-subscribe-close]')) close();
  });

  document.addEventListener('keydown', function (event) {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    var focusable = Array.prototype.slice
      .call(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(function (node) { return node.offsetParent !== null; });
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var address = email.value.trim();
    error.textContent = '';
    if (!address || !email.checkValidity()) {
      error.textContent = '이메일 주소를 확인해 주세요.';
      email.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = '보내는 중…';
    try {
      var response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ email: address }),
      });
      var data = {};
      try {
        data = await response.json();
      } catch (_) {
        /* empty or non-JSON body: handled by the ok check below */
      }
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || '지금은 구독을 처리할 수 없어요. 잠시 후 다시 시도해 주세요.');
      }
      form.hidden = true;
      done.hidden = false;
      done.focus();
      email.value = '';
      if (window.JMBlogAnalytics) {
        window.JMBlogAnalytics.trackEvent('subscribe_success', {
          includePath: false,
          component: 'subscription',
          title: '새 글 알림 구독',
        });
      }
    } catch (fetchError) {
      error.textContent = fetchError.message || '구독 처리에 실패했어요. 네트워크 연결을 확인해 주세요.';
    } finally {
      submit.disabled = false;
      submit.textContent = '구독하기';
    }
  });
})();
