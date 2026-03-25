
(function() {
  var recommendCard = document.getElementById('recommend-card');
  if (!recommendCard) return;

  var gcId = "jmchoi4u";
  var currentUrl = recommendCard.getAttribute('data-current-url');
  var titleEl = document.getElementById('recommend-card-title');
  var dateEl = document.getElementById('recommend-card-date');
  var relatedCard = document.querySelector('.post-bottom-card-right');
  var relatedHref = relatedCard ? relatedCard.getAttribute('href') : '';

  var allPosts = [
    
    { url: "/posts/5/", href: "/posts/5/", title: "나를 행동하게 만든《디지털 미니멀리즘》", date: "2026.03.25" },
    
    { url: "/posts/4/", href: "/posts/4/", title: "내가 인생을 바라보는 관점들", date: "2026.03.23" },
    
    { url: "/posts/3/", href: "/posts/3/", title: "AI 프롬프트 추천", date: "2026.03.17" },
    
    { url: "/posts/2/", href: "/posts/2/", title: "코딩을 위한 AI프롬프트를 다듬어 봤습니다. (윈도우 권장)", date: "2026.03.13" },
    
  ];

  function applyPick(post) {
    if (!post) return;
    recommendCard.href = post.href;
    if (titleEl) titleEl.textContent = post.title;
    if (dateEl) dateEl.textContent = post.date;
  }

  function chooseFallback(posts) {
    for (var i = 0; i < posts.length; i++) {
      var post = posts[i];
      if (post.url === currentUrl) continue;
      if (relatedHref && post.href === relatedHref) continue;
      return post;
    }
    return null;
  }

  if (!gcId) {
    applyPick(chooseFallback(allPosts));
    return;
  }

  var readGoatCounterCount = window.requestGoatCounterCount;
  if (typeof readGoatCounterCount !== 'function') {
    applyPick(chooseFallback(allPosts));
    return;
  }

  Promise.all(allPosts.map(function(post) {
    return new Promise(function(resolve) {
      readGoatCounterCount(post.url, function(views) {
        post.views = views || 0;
        resolve(post);
      });
    });
  })).then(function(posts) {
    posts.sort(function(a, b) { return b.views - a.views; });
    applyPick(chooseFallback(posts) || chooseFallback(allPosts));
  }).catch(function() {
    applyPick(chooseFallback(allPosts));
  });
})();

