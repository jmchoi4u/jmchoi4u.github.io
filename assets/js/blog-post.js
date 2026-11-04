(function () {
  'use strict';

  /*
   * Some posts are a single pasted prompt several thousand pixels tall, which
   * turns the article into a wall of code with the rest of the writing stranded
   * below it. Cap those blocks and give the reader a way to open them.
   * Short blocks are left completely alone.
   */
  var COLLAPSE_ABOVE_PX = 460;

  function labelFor(open) {
    return open ? '코드 접기' : '전체 코드 보기';
  }

  function setupLongCodeBlocks() {
    var blocks = document.querySelectorAll('.content .highlighter-rouge');

    Array.prototype.forEach.call(blocks, function (block) {
      var highlight = block.querySelector('.highlight');
      if (!highlight || highlight.scrollHeight <= COLLAPSE_ABOVE_PX) return;

      block.setAttribute('data-collapsible', 'closed');

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-expand';
      button.textContent = labelFor(false);
      button.setAttribute('aria-expanded', 'false');

      button.addEventListener('click', function () {
        var open = block.getAttribute('data-collapsible') !== 'open';
        block.setAttribute('data-collapsible', open ? 'open' : 'closed');
        button.textContent = labelFor(open);
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) block.scrollIntoView({ block: 'nearest' });
      });

      block.appendChild(button);
    });
  }

  /*
   * Photo slides. Writing several photos one per line, with no blank line
   * between them, puts them in one paragraph — and that paragraph becomes a
   * slide you swipe sideways on a phone (arrows appear on hover with a mouse).
   * A single photo, or photos with text in the same paragraph, stay as they are.
   *
   * Each photo keeps the lightbox link Chirpy wrapped it in, so a tap still
   * opens it full screen.
   */
  var SLIDE_RATIO_MIN = 0.8;
  var SLIDE_RATIO_MAX = 16 / 9;

  function photosOnly(paragraph) {
    var photos = [];
    var ok = Array.prototype.every.call(paragraph.childNodes, function (node) {
      if (node.nodeType === 3) return !node.textContent.trim();
      if (node.nodeType !== 1) return true;
      if (node.tagName === 'BR') return true;
      if (node.tagName === 'IMG' || (node.tagName === 'A' && node.querySelector('img') && !node.textContent.trim())) {
        photos.push(node);
        return true;
      }
      return false;
    });
    return ok ? photos : [];
  }

  function svgArrow(points) {
    return (
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + points + '"/></svg>'
    );
  }

  function buildSlide(paragraph, photos) {
    var total = photos.length;
    var slide = document.createElement('div');
    slide.className = 'jm-slide';
    slide.setAttribute('role', 'region');
    slide.setAttribute('aria-roledescription', '슬라이드');
    slide.setAttribute('aria-label', '사진 ' + total + '장');

    var track = document.createElement('div');
    track.className = 'jm-slide-track';
    track.tabIndex = 0;

    photos.forEach(function (photo, index) {
      var item = document.createElement('div');
      item.className = 'jm-slide-item';
      item.setAttribute('role', 'group');
      item.setAttribute('aria-label', index + 1 + ' / ' + total);
      item.appendChild(photo);
      track.appendChild(item);
    });

    var count = document.createElement('span');
    count.className = 'jm-slide-count';
    count.setAttribute('aria-hidden', 'true');

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'jm-slide-nav jm-slide-prev';
    prev.setAttribute('aria-label', '이전 사진');
    prev.innerHTML = svgArrow('M12.5 4.5 7 10l5.5 5.5');

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'jm-slide-nav jm-slide-next';
    next.setAttribute('aria-label', '다음 사진');
    next.innerHTML = svgArrow('M7.5 4.5 13 10l-5.5 5.5');

    var dots = document.createElement('div');
    dots.className = 'jm-slide-dots';
    var dotButtons = photos.map(function (_, index) {
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', index + 1 + '번째 사진');
      dot.addEventListener('click', function () { go(index); });
      dots.appendChild(dot);
      return dot;
    });

    slide.appendChild(track);
    slide.appendChild(count);
    slide.appendChild(prev);
    slide.appendChild(next);
    slide.appendChild(dots);
    paragraph.parentNode.replaceChild(slide, paragraph);

    var current = -1;

    function indexNow() {
      var width = track.clientWidth || 1;
      return Math.max(0, Math.min(total - 1, Math.round(track.scrollLeft / width)));
    }

    function show(index) {
      if (index === current) return;
      current = index;
      count.textContent = index + 1 + ' / ' + total;
      prev.disabled = index === 0;
      next.disabled = index === total - 1;
      dotButtons.forEach(function (dot, i) {
        dot.setAttribute('aria-current', i === index ? 'true' : 'false');
      });
    }

    function go(index) {
      var target = Math.max(0, Math.min(total - 1, index));
      track.scrollTo({ left: target * track.clientWidth, behavior: 'smooth' });
    }

    prev.addEventListener('click', function () { go(indexNow() - 1); });
    next.addEventListener('click', function () { go(indexNow() + 1); });
    track.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(indexNow() - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(indexNow() + 1);
      }
    });

    var ticking = false;
    track.addEventListener(
      'scroll',
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          ticking = false;
          show(indexNow());
        });
      },
      { passive: true }
    );

    /* The first photo sets the frame, clamped so a panorama or a very tall
       shot does not make the slide a sliver or a wall. */
    var first = track.querySelector('img');
    function fitRatio() {
      if (!first || !first.naturalWidth || !first.naturalHeight) return;
      var ratio = first.naturalWidth / first.naturalHeight;
      ratio = Math.max(SLIDE_RATIO_MIN, Math.min(SLIDE_RATIO_MAX, ratio));
      track.style.setProperty('--jm-slide-ratio', String(ratio));
    }
    if (first) {
      /* Lazy loading would hold the first photo back until it scrolls near;
         it decides the slide's height, so fetch it now. */
      first.loading = 'eager';
      if (first.complete) fitRatio();
      else first.addEventListener('load', fitRatio, { once: true });
    }

    show(0);
  }

  function setupPhotoSlides() {
    var paragraphs = document.querySelectorAll('.jm-post .content p');
    Array.prototype.forEach.call(paragraphs, function (paragraph) {
      var photos = photosOnly(paragraph);
      if (photos.length >= 2) buildSlide(paragraph, photos);
    });
  }

  /* Share sheet where the browser has one, otherwise copy the link. */
  function setupShare() {
    var toast = document.querySelector('[data-toast]');
    var timer = null;
    if (toast) document.body.appendChild(toast);

    function say(message) {
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('show');
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { toast.classList.remove('show'); }, 1600);
    }

    function track(name) {
      if (window.JMBlogAnalytics) {
        window.JMBlogAnalytics.trackEvent(name, { component: 'article_share', title: document.title });
      }
    }

    document.addEventListener('click', async function (event) {
      var button = event.target.closest('[data-share]');
      if (!button) return;
      var url = window.location.href.split('#')[0];

      if (navigator.share) {
        try {
          await navigator.share({
            title: button.getAttribute('data-share-title') || document.title,
            text: button.getAttribute('data-share-text') || '',
            url: url,
          });
          track('share_native');
          return;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        say('링크를 복사했어요');
        track('share_copy');
      } catch (_) {
        window.prompt('아래 링크를 복사해 주세요.', url);
      }
    });
  }

  function setupCommentJump() {
    document.addEventListener('click', function (event) {
      if (!event.target.closest('[data-goto-comments]')) return;
      /* Disqus inserts its thread late (and only once scrolled near), so the
         target is looked up on click rather than at load. */
      var target =
        document.getElementById('disqus_thread') ||
        document.getElementById('comments') ||
        document.querySelector('footer');
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function init() {
    setupPhotoSlides();
    setupLongCodeBlocks();
    setupShare();
    setupCommentJump();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
