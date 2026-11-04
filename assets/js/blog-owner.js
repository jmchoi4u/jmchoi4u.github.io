/*
 * Writer's shortcuts on the public blog: "새 글 쓰기" in the profile and
 * "수정" on every post. They appear only on a device where Blog Studio has
 * been signed in — Studio sets `jm-blog-owner` in localStorage on sign-in and
 * removes it on sign-out (same origin, so the blog can read it).
 *
 * This only decides what is shown. The links lead to Studio, which still asks
 * for GitHub sign-in before anything can be changed.
 */
(function () {
  'use strict';

  var owner = false;
  try {
    owner = localStorage.getItem('jm-blog-owner') === '1';
  } catch (_) {
    /* storage blocked: stay a reader */
  }
  if (owner) document.documentElement.classList.add('jm-owner');
})();
