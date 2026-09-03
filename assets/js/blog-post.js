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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupLongCodeBlocks);
  } else {
    setupLongCodeBlocks();
  }
})();
