const AUTOSAVE_KEY = "jm-blog-editor-autosave-v1";
const AUTOSAVE_DELAY_MS = 1500;

/* ── Toast Notification System ── */
function showToast(title, message = "", type = "info", duration = 4000) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const icons = { success: "\u2713", error: "\u2717", info: "\u2139" };
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ""}
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">\u00d7</button>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

const state = {
  rawKind: "config",
  uploadedMarkdown: "",
  panel: "editor",
  posts: [],
  searchQuery: "",
  filterCategory: "",
  filterTag: "",
  editorBaseline: "",
  autosaveTimer: null,
  slugManuallyEdited: false,
  sortBy: "newest",
  pmTab: "all"
};

const markdownEngine = window.marked;
markdownEngine.setOptions({
  gfm: true,
  breaks: true
});

const el = {
  pmList: document.querySelector("#pm-list"),
  siteSummary: document.querySelector("#site-summary"),
  previewSummary: document.querySelector("#preview-summary"),
  gitSummary: document.querySelector("#git-summary"),
  commandOutput: document.querySelector("#command-output"),
  previewLogOutput: document.querySelector("#preview-log-output"),
  title: document.querySelector("#post-title"),
  slug: document.querySelector("#post-slug"),
  date: document.querySelector("#post-date"),
  draft: document.querySelector("#post-draft"),
  heroTitle: document.querySelector("#post-hero-title"),
  summary: document.querySelector("#post-summary"),
  heroImagePosition: document.querySelector("#post-hero-image-position"),
  categoryMain: document.querySelector("#post-category-main"),
  categorySub: document.querySelector("#post-category-sub"),
  tags: document.querySelector("#post-tags"),
  description: document.querySelector("#post-description"),
  toc: document.querySelector("#post-toc"),
  comments: document.querySelector("#post-comments"),
  pin: document.querySelector("#post-pin"),
  hidden: document.querySelector("#post-hidden"),
  mermaid: document.querySelector("#post-mermaid"),
  math: document.querySelector("#post-math"),
  dateRefresh: document.querySelector("#post-date-refresh"),
  extra: document.querySelector("#post-extra"),
  body: document.querySelector("#post-body"),
  bodyPreview: document.querySelector("#post-body-preview"),
  originalPath: document.querySelector("#original-path"),
  deletePostButton: document.querySelector("#delete-post-btn"),
  autosaveStatus: document.querySelector("#autosave-status"),
  imageArea: document.querySelector("#image-area"),
  imageFolder: document.querySelector("#image-folder"),
  imageFile: document.querySelector("#image-file"),
  imageResult: document.querySelector("#image-result"),
  permalink: document.querySelector("#post-permalink"),
  publishMessage: document.querySelector("#publish-message"),
  postSearch: document.querySelector("#post-search"),
  rawEditor: document.querySelector("#raw-editor"),
  templateSelect: document.querySelector("#template-select"),
  templateName: document.querySelector("#template-name"),
  templateEditor: document.querySelector("#template-editor"),
  templatePreview: document.querySelector("#template-preview"),
  coverImageFile: document.querySelector("#cover-image-file"),
  coverImagePath: document.querySelector("#cover-image-path"),
  coverPreviewArea: document.querySelector("#cover-preview-area"),
  coverPreviewImg: document.querySelector("#cover-preview-img"),
  coverPathDisplay: document.querySelector("#cover-path-display")
};

function formatNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:00 +0900`;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeSlugInput(value) {
  return String(value || "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function formatPostFileName(value) {
  const stem = normalizeSlugInput(value);
  return stem ? `${stem}.md` : "";
}

function makeTimeSlug(dateText = "") {
  const source = String(dateText || formatNow());
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
  }

  const compact = formatNow().replace(/[-: ]/g, "").replace("+0900", "");
  return `${compact.slice(0, 8)}-${compact.slice(8, 14)}`;
}

function resolvePostSlug(slugValue, titleValue, dateText) {
  const slug = slugify(normalizeSlugInput(slugValue)) || slugify(titleValue);
  return slug || makeTimeSlug(dateText);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripFrontMatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return normalized;
  return normalized.slice(end + 5).replace(/^\n/, "");
}

function enhancePreview(target) {
  target.querySelectorAll("a").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener");
  });
}

function renderMarkdown(target, markdownText, options = {}) {
  if (!target) return;
  const source = options.stripFrontMatter ? stripFrontMatter(markdownText) : String(markdownText || "");
  const trimmed = source.trim();

  if (!trimmed) {
    target.innerHTML = "<p class='preview-empty'>아직 내용이 없습니다.</p>";
    return;
  }

  target.innerHTML = markdownEngine.parse(source);
  enhancePreview(target);
}

function updateBodyPreview() {
  const title = (el.heroTitle.value.trim() || el.title.value.trim());
  const desc = document.querySelector("#post-description").value.trim();
  const cover = el.coverImagePath.value.trim();
  const coverPosition = el.heroImagePosition.value.trim() || "50% 18%";
  let header = "";
  if (cover || title) {
    header += `<div class="preview-post-header" style="margin-bottom:1.2rem">`;
    if (cover) {
      header += `<div style="width:100%;height:220px;overflow:hidden;border-radius:8px;margin-bottom:.8rem"><img src="${cover}" alt="표지" style="width:100%;height:100%;object-fit:cover;object-position:${coverPosition}"></div>`;
    }
    if (title) {
      header += `<h1 style="margin:0 0 .3rem;font-size:1.6rem;font-weight:700;line-height:1.3">${title.replace(/</g,"&lt;").replace(/\r?\n/g, "<br>")}</h1>`;
    }
    if (desc) {
      header += `<p style="margin:0 0 .5rem;color:#888;font-size:.9rem">${desc.replace(/</g,"&lt;")}</p>`;
    }
    header += `<hr style="border:none;border-top:1px solid #e0e0e0;margin:.8rem 0">`;
    header += `</div>`;
  }
  el.bodyPreview.innerHTML = header;
  const bodyDiv = document.createElement("div");
  renderMarkdown(bodyDiv, el.body.value);
  el.bodyPreview.appendChild(bodyDiv);
}

function updateTemplatePreview() {
  renderMarkdown(el.templatePreview, el.templateEditor.value, { stripFrontMatter: true });
}

function renderHelpPreviews() {
  document.querySelectorAll("[data-md-source]").forEach((sourceBox) => {
    const preview = sourceBox.parentElement.querySelector("[data-md-preview]");
    renderMarkdown(preview, sourceBox.textContent);
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.stderr || "요청 실패");
  }
  return data;
}

function setOutput(title, text) {
  el.commandOutput.textContent = `${title}\n\n${text || "(출력 없음)"}`;
  // Auto-show toast for key results
  const isError = /실패|오류|error/i.test(title);
  const isSuccess = /완료|성공/i.test(title);
  if (isSuccess) showToast(title, (text || "").split("\n")[0], "success");
  else if (isError) showToast(title, (text || "").split("\n")[0], "error", 6000);
}

function setActivePanel(panelId) {
  const fallbackPanel = document.querySelector(".nav-tab.active")?.dataset.panel
    || document.querySelector(".nav-tab")?.dataset.panel
    || "editor";
  const nextPanel = document.getElementById(panelId) ? panelId : fallbackPanel;

  state.panel = nextPanel;
  try { localStorage.setItem("jm-editor-active-panel", nextPanel); } catch {}
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === nextPanel);
  });
  document.querySelectorAll(".screen").forEach((section) => {
    section.classList.toggle("active-screen", section.id === nextPanel);
  });

  return nextPanel;
}

function parseTags(value) {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseCategories() {
  return [el.categoryMain.value.trim(), el.categorySub.value.trim()].filter(Boolean);
}

function currentEditorData() {
  return {
    title: el.title.value.trim(),
    slug: el.slug.value.trim(),
    date: el.date.value.trim(),
    draft: el.draft.checked,
    heroTitle: el.heroTitle.value.trim(),
    summary: el.summary.value.trim(),
    heroImagePosition: el.heroImagePosition.value.trim(),
    categories: parseCategories(),
    tags: parseTags(el.tags.value),
    description: el.description.value.trim(),
    toc: el.toc.checked,
    comments: el.comments.checked,
    pin: el.pin.checked,
    hidden: el.hidden.checked,
    mermaid: el.mermaid.checked,
    math: el.math.checked,
    extra: el.extra.value,
    coverImage: el.coverImagePath.value.trim(),
    body: el.body.value,
    relativePath: el.originalPath.value || ""
  };
}

function updateDeleteButton() {
  if (!el.deletePostButton) return;
  el.deletePostButton.disabled = !el.originalPath.value;
}

function setAutosaveStatus(text) {
  if (el.autosaveStatus) {
    el.autosaveStatus.textContent = text;
  }
}

function setEditorBaseline() {
  state.editorBaseline = JSON.stringify(currentEditorData());
  updateDeleteButton();
}

function hasUnsavedChanges() {
  return JSON.stringify(currentEditorData()) !== state.editorBaseline;
}

function clearAutosaveTimer() {
  if (state.autosaveTimer) {
    window.clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
}

function saveAutosaveToBrowser(statusText = "") {
  if (!hasUnsavedChanges()) {
    return;
  }

  const payload = {
    savedAt: new Date().toISOString(),
    data: currentEditorData()
  };

  window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  const timeLabel = new Date(payload.savedAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  setAutosaveStatus(statusText || `브라우저 임시 저장됨 · ${timeLabel}`);
}

function scheduleAutosave() {
  clearAutosaveTimer();
  state.autosaveTimer = window.setTimeout(() => {
    saveAutosaveToBrowser();
  }, AUTOSAVE_DELAY_MS);
}

function clearAutosave(statusText = "자동 임시저장 없음") {
  clearAutosaveTimer();
  window.localStorage.removeItem(AUTOSAVE_KEY);
  setAutosaveStatus(statusText);
}

async function confirmReplaceEditor(actionLabel) {
  if (!hasUnsavedChanges()) {
    return true;
  }

  const ok = window.confirm(`작성 중인 내용이 있습니다.\n${actionLabel} 전에 현재 내용을 브라우저 임시저장에 남기고 이동할까요?`);
  if (!ok) {
    return false;
  }

  saveAutosaveToBrowser("작성 중인 내용 임시 저장됨");
  return true;
}

function restoreAutosaveIfNeeded() {
  const raw = window.localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) {
    setAutosaveStatus("자동 임시저장 없음");
    return;
  }

  try {
    const saved = JSON.parse(raw);
    if (!saved?.data) {
      clearAutosave();
      return;
    }

    const timeLabel = saved.savedAt
      ? new Date(saved.savedAt).toLocaleString("ko-KR")
      : "시간 정보 없음";

    if (!window.confirm(`임시 저장된 작성 중 글이 있습니다.\n불러올까요?\n\n저장 시각: ${timeLabel}`)) {
      clearAutosave("임시저장을 비웠습니다.");
      return;
    }

    fillEditor(saved.data);
    setEditorBaseline();
    setAutosaveStatus(`복원된 임시저장 · ${timeLabel}`);
    setOutput("임시저장 복원", "이전에 작성 중이던 내용을 다시 불러왔습니다.");
  } catch {
    clearAutosave();
  }
}

function resetEditor() {
  state.slugManuallyEdited = false;
  el.title.value = "";
  el.slug.value = "";
  el.date.value = el.dateRefresh.checked ? formatNow() : "";
  el.draft.checked = false;
  el.heroTitle.value = "";
  el.summary.value = "";
  el.heroImagePosition.value = "";
  el.categoryMain.value = "";
  el.categorySub.value = "";
  el.tags.value = "";
  el.description.value = "";
  el.toc.checked = true;
  el.comments.checked = true;
  el.pin.checked = false;
  el.hidden.checked = false;
  el.mermaid.checked = false;
  el.math.checked = false;
  el.extra.value = "";
  el.coverImagePath.value = "";
  el.coverImageFile.value = "";
  updateCoverPreview();
  el.body.value = "";
  el.originalPath.value = "";
  el.permalink.value = "";
  updateBodyPreview();
  setEditorBaseline();
  setAutosaveStatus("새 글 작성 대기 중");
}

function fillEditor(data) {
  el.title.value = data.title || "";
  el.slug.value = formatPostFileName(data.slug || slugify((data.fileName || "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/i, "")));
  el.date.value = data.date || formatNow();
  el.draft.checked = Boolean(data.draft);
  el.heroTitle.value = String(data.heroTitle || "").replace(/<br\s*\/?>/gi, "\n");
  el.summary.value = data.summary || "";
  el.heroImagePosition.value = data.heroImagePosition || "";
  el.categoryMain.value = data.categories?.[0] || "";
  el.categorySub.value = data.categories?.[1] || "";
  el.tags.value = (data.tags || []).join(", ");
  el.description.value = data.description || "";
  el.toc.checked = data.toc !== false;
  el.comments.checked = data.comments !== false;
  el.pin.checked = Boolean(data.pin);
  el.hidden.checked = Boolean(data.hidden);
  el.mermaid.checked = Boolean(data.mermaid);
  el.math.checked = Boolean(data.math);
  el.extra.value = data.extra || "";
  el.coverImagePath.value = data.coverImage || "";
  updateCoverPreview();
  el.body.value = data.body || "";
  el.originalPath.value = data.relativePath || "";
  el.permalink.value = data.permalink || "";
  updateBodyPreview();
  setEditorBaseline();
  setAutosaveStatus(data.draft ? "임시저장 글을 편집 중" : "발행 글을 편집 중");
}

function insertAtCursor(text) {
  const area = el.body;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  const needsLineBefore = before && !before.endsWith("\n") ? "\n" : "";
  const needsLineAfter = after && !after.startsWith("\n") ? "\n" : "";
  area.value = `${before}${needsLineBefore}${text}${needsLineAfter}${after}`;
  area.focus();
  updateBodyPreview();
}

function wrapSelection(before, after = before, placeholder = "텍스트") {
  const area = el.body;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selectedText = area.value.slice(start, end);
  const content = selectedText || placeholder;
  const replacement = `${before}${content}${after}`;

  area.value = `${area.value.slice(0, start)}${replacement}${area.value.slice(end)}`;
  area.focus();

  const selectionStart = start + before.length;
  const selectionEnd = selectionStart + content.length;
  area.setSelectionRange(selectionStart, selectionEnd);
  updateBodyPreview();
}

function applyTextColor(color) {
  wrapSelection(`<span style="color: ${color};">`, "</span>", "색상 글자");
}

function getPostStatus(post) {
  if (post.draft) return { label: "임시저장", cls: "pm-status-draft" };
  if (post.hidden) return { label: "숨김", cls: "pm-status-hidden" };
  if (post.pendingDeploy) return { label: "배포 대기", cls: "pm-status-pending" };
  return { label: "발행됨", cls: "pm-status-published" };
}

function renderPostCard(post) {
  const status = getPostStatus(post);
  const date = (post.date || "").replace(/\s.*/, "");
  const cats = (post.categories || []).map((c) => escapeHtml(c)).join(" / ");
  const tags = (post.tags || []).slice(0, 3).map((t) => `<span class="pm-card-tag">${escapeHtml(t)}</span>`).join(" ");
  const desc = post.description ? `<span>${escapeHtml(post.description).slice(0, 40)}</span>` : "";

  const postUrl = post.relativePath.replace(/^_posts\//, "/posts/").replace(/\.md$/, "/").replace(/^\d{4}-\d{2}-\d{2}-/, "");

  return `<div class="pm-card" data-path="${escapeHtml(post.relativePath)}">
    <span class="pm-card-status ${status.cls}" title="${status.label}"></span>
    <div class="pm-card-body">
      <div class="pm-card-title">${escapeHtml(post.title || "(제목 없음)")}</div>
      <div class="pm-card-meta">
        ${date ? `<span>📅 ${date}</span>` : ""}
        ${cats ? `<span>📁 ${cats}</span>` : ""}
        ${desc}
        <span class="pm-card-views" data-post-url="${escapeHtml(postUrl)}" style="display:none">👁 <span class="pm-views-num">-</span></span>
      </div>
      ${tags ? `<div class="pm-card-meta" style="margin-top:3px">${tags}</div>` : ""}
    </div>
    <div class="pm-card-actions">
      <button type="button" data-path="${escapeHtml(post.relativePath)}">수정</button>
      ${post.draft ? `<button type="button" class="primary" data-publish-path="${escapeHtml(post.relativePath)}">발행</button>` : ""}
      ${!post.draft ? `<button type="button" class="secondary" data-toggle-hidden-path="${escapeHtml(post.relativePath)}">${post.hidden ? "보이기" : "숨기기"}</button>` : ""}
      <button type="button" class="danger" data-delete-path="${escapeHtml(post.relativePath)}" data-title="${escapeHtml(post.title)}">삭제</button>
    </div>
  </div>`;
}

function sortPosts(posts, sortBy) {
  const sorted = [...posts];
  if (sortBy === "oldest") {
    sorted.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  } else if (sortBy === "title") {
    sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  } else {
    sorted.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }
  return sorted;
}

function renderPosts(posts) {
  const query = state.searchQuery.trim().toLowerCase();
  let filtered = query
    ? posts.filter((post) =>
        [post.title, post.relativePath, post.fileName, ...(post.categories || []), ...(post.tags || [])]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query))
      )
    : posts;

  if (state.filterCategory) {
    filtered = filtered.filter((post) =>
      (post.categories || []).some((c) => c === state.filterCategory)
    );
  }
  if (state.filterTag) {
    filtered = filtered.filter((post) =>
      (post.tags || []).some((t) => t === state.filterTag)
    );
  }

  const sorted = sortPosts(filtered, state.sortBy || "newest");

  const drafts = sorted.filter((post) => post.draft);
  const hidden = sorted.filter((post) => !post.draft && post.hidden);
  const pending = sorted.filter((post) => !post.draft && !post.hidden && post.pendingDeploy);
  const published = sorted.filter((post) => !post.draft && !post.hidden && !post.pendingDeploy);

  // Update counts
  const countAll = document.getElementById("pm-count-all");
  const countPublished = document.getElementById("pm-count-published");
  const countPending = document.getElementById("pm-count-pending");
  const countDrafts = document.getElementById("pm-count-drafts");
  const countHidden = document.getElementById("pm-count-hidden");
  if (countAll) countAll.textContent = sorted.length;
  if (countPublished) countPublished.textContent = published.length;
  if (countPending) countPending.textContent = pending.length;
  if (countDrafts) countDrafts.textContent = drafts.length;
  if (countHidden) countHidden.textContent = hidden.length;

  // Stats bar
  const statsEl = document.getElementById("pm-stats");
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="pm-stat"><span class="pm-stat-num">${posts.length}</span><span class="pm-stat-label">전체 글</span></div>
      <div class="pm-stat"><span class="pm-stat-num" style="color:#16a34a">${posts.filter(p => !p.draft && !p.hidden && !p.pendingDeploy).length}</span><span class="pm-stat-label">발행됨</span></div>
      <div class="pm-stat"><span class="pm-stat-num" style="color:#f59e0b">${posts.filter(p => !p.draft && !p.hidden && p.pendingDeploy).length}</span><span class="pm-stat-label">배포 대기</span></div>
      <div class="pm-stat"><span class="pm-stat-num" style="color:#8b5cf6">${posts.filter(p => p.draft).length}</span><span class="pm-stat-label">임시저장</span></div>
      <div class="pm-stat"><span class="pm-stat-num" style="color:#6b7280">${posts.filter(p => p.hidden).length}</span><span class="pm-stat-label">숨김</span></div>
    `;
  }

  // Filter by active tab
  const activeTab = state.pmTab || "all";
  let display;
  if (activeTab === "published") display = published;
  else if (activeTab === "pending") display = pending;
  else if (activeTab === "drafts") display = drafts;
  else if (activeTab === "hidden") display = hidden;
  else display = sorted;

  // Render list
  const listEl = document.getElementById("pm-list");
  if (listEl) {
    listEl.innerHTML = display.length
      ? display.map(renderPostCard).join("")
      : `<div class="pm-empty">표시할 글이 없습니다.</div>`;
  }

  // Load view counts from GoatCounter
  loadPostViewCounts();
}

function loadPostViewCounts() {
  const gcId = "jmchoi4u";
  const badges = document.querySelectorAll(".pm-card-views");
  if (!badges.length) return;
  badges.forEach((badge) => {
    const url = badge.dataset.postUrl;
    if (!url) return;
    const uri = url.replace(/\/$/, "");
    fetch(`https://${gcId}.goatcounter.com/counter/${encodeURIComponent(uri)}.json`)
      .then((r) => r.json())
      .then((d) => {
        const views = parseInt((d.count || "0").replace(/\D/g, ""), 10) || 0;
        badge.querySelector(".pm-views-num").textContent = views + "회";
        badge.style.display = "inline";
      })
      .catch(() => {});
  });
}

function renderTemplates(templates) {
  el.templateSelect.innerHTML = templates
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  if (el.templatesList) {
    el.templatesList.innerHTML = templates
      .map(
        (name) => `
          <button type="button" class="list-item" data-template="${escapeHtml(name)}">
            <strong>${escapeHtml(name)}</strong>
            <span>클릭하면 편집기에 불러옵니다.</span>
          </button>
        `
      )
      .join("");
  }
}

function renderInfoList(target, rows) {
  target.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function parseTemplateText(text, fileName = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fileName, title: "", date: formatNow(), heroTitle: "", summary: "", heroImagePosition: "", categories: [], tags: [], description: "", toc: true, comments: true, pin: false, hidden: false, mermaid: false, math: false, extra: "", body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { fileName, title: "", date: formatNow(), heroTitle: "", summary: "", heroImagePosition: "", categories: [], tags: [], description: "", toc: true, comments: true, pin: false, hidden: false, mermaid: false, math: false, extra: "", body: normalized };
  }
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 5).replace(/^\n/, "");
  const pick = (regex) => {
    const match = head.match(regex);
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const pickBool = (key, fallback) => {
    const value = pick(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return value ? value === "true" : fallback;
  };
  const parseList = (value) =>
    String(value || "")
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  const extra = head
    .split("\n")
    .filter((line) => !/^(title|date|hero_title|summary|hero_image_position|categories|tags|description|toc|comments|pin|hidden|mermaid|math):/.test(line.trim()))
    .join("\n")
    .trim();
  return {
    fileName,
    title: pick(/^title:\s*(.+)$/m),
    date: pick(/^date:\s*(.+)$/m) || formatNow(),
    heroTitle: pick(/^hero_title:\s*(.+)$/m),
    summary: pick(/^summary:\s*(.+)$/m),
    heroImagePosition: pick(/^hero_image_position:\s*(.+)$/m),
    categories: parseList(pick(/^categories:\s*(.+)$/m)),
    tags: parseList(pick(/^tags:\s*(.+)$/m)),
    description: pick(/^description:\s*(.+)$/m),
    toc: pickBool("toc", true),
    comments: pickBool("comments", true),
    pin: pickBool("pin", false),
    hidden: pickBool("hidden", false),
    mermaid: pickBool("mermaid", false),
    math: pickBool("math", false),
    extra,
    body
  };
}

async function loadSummary() {
  const data = await api("/api/summary");
  renderInfoList(el.siteSummary, [
    ["제목", data.site.title],
    ["부제", data.site.tagline],
    ["URL", data.site.url],
    ["작성자", data.site.author],
    ["이메일", data.site.email],
    ["아바타", data.site.avatar]
  ]);
  renderInfoList(el.previewSummary, [
    ["상태", data.preview.running ? "실행 중" : "중지됨"],
    ["주소", data.preview.url]
  ]);
  el.gitSummary.textContent = [data.git.branch, "", data.git.status, "", data.git.remote, "", ...(data.logs || [])].join("\n");
  el.previewLogOutput.textContent = (data.preview.logs || []).join("\n") || "아직 로그가 없습니다.";
}

function updateFilterOptions(posts) {
  const catSet = new Set();
  const tagSet = new Set();
  for (const post of posts) {
    (post.categories || []).forEach((c) => catSet.add(c));
    (post.tags || []).forEach((t) => tagSet.add(t));
  }
  const catSelect = document.querySelector("#filter-category");
  const tagSelect = document.querySelector("#filter-tag");
  if (catSelect) {
    const prev = catSelect.value;
    catSelect.innerHTML = `<option value="">-- --</option>` + [...catSet].sort().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    catSelect.value = prev;
  }
  if (tagSelect) {
    const prev = tagSelect.value;
    tagSelect.innerHTML = `<option value="">-- --</option>` + [...tagSet].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    tagSelect.value = prev;
  }
}

async function loadPosts() {
  const data = await api("/api/posts");
  state.posts = data.posts || [];
  updateFilterOptions(state.posts);
  renderPosts(state.posts);
}

async function refreshPanelData(panelId = state.panel) {
  if (panelId === "posts-manager") {
    await loadPosts();
    return;
  }

  if (panelId === "overview") {
    await loadSummary();
    return;
  }

  if (panelId === "template-manager") {
    await loadTemplates();
    return;
  }

  if (panelId === "settings") {
    await loadRaw(state.rawKind);
  }
}

async function loadTemplates() {
  const data = await api("/api/templates");
  renderTemplates(data.templates || []);
}

async function loadRaw(kind = state.rawKind) {
  state.rawKind = kind;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === kind);
  });
  const data = await api(`/api/raw-file?kind=${encodeURIComponent(kind)}`);
  el.rawEditor.value = data.content || "";
  if (kind === "config") loadQuickSettings(data.content || "");
}

function loadQuickSettings(yaml) {
  const get = (key) => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)`, "m"));
    if (!m) return "";
    return m[1].replace(/\s*#.*$/, "").trim().replace(/^["']|["']$/g, "");
  };
  const desc = (() => {
    const m = yaml.match(/^description:\s*>-?\s*(?:#.*)?\n([\s\S]*?)(?=\n\S|\n*$)/m);
    return m ? m[1].trim() : get("description");
  })();
  document.querySelector("#qs-title").value = get("title");
  document.querySelector("#qs-tagline").value = get("tagline");
  document.querySelector("#qs-description").value = desc;
  document.querySelector("#qs-avatar").value = get("avatar");
  updateAvatarPreview();
}

function updateAvatarPreview() {
  const img = document.querySelector("#qs-avatar-preview");
  const val = document.querySelector("#qs-avatar").value.trim();
  if (val) { img.src = val; img.style.display = "block"; } else { img.style.display = "none"; }
}

async function saveQuickSettings() {
  const data = await api(`/api/raw-file?kind=config`);
  let yaml = data.content || "";
  const title = document.querySelector("#qs-title").value.trim();
  const tagline = document.querySelector("#qs-tagline").value.trim();
  const desc = document.querySelector("#qs-description").value.trim();
  const avatar = document.querySelector("#qs-avatar").value.trim();

  yaml = yaml.replace(/^(title:\s*)([^#\n]*)(.*)$/m, `$1${title} $3`);
  yaml = yaml.replace(/^(tagline:\s*)([^#\n]*)(.*)$/m, `$1${tagline} $3`);
  yaml = yaml.replace(/^(description:\s*>-?\s*\n)[\s\S]*?(?=\n\S)/m, `$1  ${desc}`);
  yaml = yaml.replace(/^(avatar:\s*).*$/m, `$1${avatar}`);
  yaml = yaml.replace(/^(social_preview_image:\s*).*$/m, `$1${avatar}`);

  await api("/api/save-raw-file", { method: "POST", body: JSON.stringify({ kind: "config", content: yaml }) });
  setOutput("빠른 설정 저장 완료", "블로그 이름/소개/설명/프로필 이미지가 저장되었습니다.");
  if (state.rawKind === "config") el.rawEditor.value = yaml;
  await loadSummary();
}

/* ── 표지 이미지 ── */
function updateCoverPreview() {
  const p = el.coverImagePath.value.trim();
  const coverPosition = el.heroImagePosition.value.trim() || "50% 18%";
  if (p) {
    el.coverPreviewImg.src = p;
    el.coverPreviewImg.style.objectPosition = coverPosition;
    el.coverPathDisplay.textContent = p;
    el.coverPreviewArea.style.display = "block";
  } else {
    el.coverPreviewArea.style.display = "none";
    el.coverPathDisplay.textContent = "";
  }
}

async function uploadCoverImage() {
  const file = el.coverImageFile.files[0];
  if (!file) throw new Error("표지 이미지 파일을 먼저 선택하세요.");
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const slug = el.slug.value.trim() || el.title.value.trim() || "cover";
  const folder = slug.replace(/[^a-zA-Z0-9가-힣_-]/g, "-").toLowerCase() || "cover";
  const data = await api("/api/upload-image", {
    method: "POST",
    body: JSON.stringify({ area: "posts", folderName: folder, fileName: file.name, dataUrl })
  });
  el.coverImagePath.value = data.sitePath;
  updateCoverPreview();
  updateBodyPreview();
  setOutput("표지 이미지 업로드 완료", `경로: ${data.sitePath}\n글을 자동 저장합니다...`);
  // 업로드 후 자동 저장
  await savePost();
}

function removeCoverImage() {
  el.coverImagePath.value = "";
  el.coverImageFile.value = "";
  updateCoverPreview();
  updateBodyPreview();
}

async function openPost(path) {
  if (!(await confirmReplaceEditor("다른 글을 열기"))) {
    return;
  }
  fillEditor(await api(`/api/post?path=${encodeURIComponent(path)}`));
  setActivePanel("editor");
}

async function applyTemplate(name) {
  if (!(await confirmReplaceEditor("템플릿을 적용하기"))) {
    return;
  }
  fillEditor(await api(`/api/template?name=${encodeURIComponent(name)}`));
  el.originalPath.value = "";
  setEditorBaseline();
  setActivePanel("editor");
}

async function loadTemplateText(name = el.templateSelect.value) {
  if (!name) return;
  const data = await api(`/api/template-raw?name=${encodeURIComponent(name)}`);
  el.templateName.value = data.name || name;
  el.templateEditor.value = data.content || "";
  updateTemplatePreview();
}

async function saveTemplateText() {
  const name = el.templateName.value.trim();
  if (!name) {
    throw new Error("템플릿 파일명을 먼저 입력하세요.");
  }
  await api("/api/save-template", {
    method: "POST",
    body: JSON.stringify({ name, content: el.templateEditor.value })
  });
  await loadTemplates();
  el.templateSelect.value = name;
  setOutput("템플릿 저장 완료", name);
  updateTemplatePreview();
}

function newTemplate() {
  el.templateName.value = "post-template-new.md";
  el.templateEditor.value = `---\ntitle: "새 템플릿 제목"\ndate: ${formatNow()}\ncategories: [개발]\ntags: [sample]\ndescription: "설명"\ntoc: true\ncomments: true\npin: false\nmermaid: false\nmath: false\n---\n\n## 소개\n\n내용을 작성하세요.\n`;
  updateTemplatePreview();
}

function applyTemplateEditorContent() {
  const parsed = parseTemplateText(el.templateEditor.value, el.templateName.value.trim());
  fillEditor(parsed);
  el.originalPath.value = "";
  setActivePanel("editor");
}

async function savePost() {
  const wasExisting = Boolean(el.originalPath.value);
  const data = await api("/api/save-post", {
    method: "POST",
    body: JSON.stringify({
      originalRelativePath: el.originalPath.value || "",
      title: el.title.value.trim(),
      slug: resolvePostSlug(el.slug.value.trim(), el.title.value.trim(), el.date.value.trim()),
      date: el.date.value.trim() || formatNow(),
      draft: el.draft.checked,
      heroTitle: el.heroTitle.value.trim(),
      summary: el.summary.value.trim(),
      heroImagePosition: el.heroImagePosition.value.trim(),
      categories: parseCategories(),
      tags: parseTags(el.tags.value),
      description: el.description.value.trim(),
      coverImage: el.coverImagePath.value.trim(),
      toc: el.toc.checked,
      comments: el.comments.checked,
      pin: el.pin.checked,
      hidden: el.hidden.checked,
      mermaid: el.mermaid.checked,
      math: el.math.checked,
      permalink: el.permalink.value || "",
      extra: el.extra.value,
      body: el.body.value
    })
  });

  if (wasExisting) {
    el.originalPath.value = data.relativePath;
    setEditorBaseline();
    clearAutosave(el.draft.checked ? "임시저장 글 저장 완료" : "발행 글 저장 완료");
    setOutput("글 저장 완료", el.draft.checked ? data.relativePath : `${data.relativePath}\n\n현재는 로컬 저장만 된 상태입니다.\n사이트 반영은 '전체 변경 GitHub 배포'를 해야 합니다.`);
  } else {
    clearAutosave("저장 완료 후 입력창을 비웠습니다.");
    resetEditor();
    setOutput("글 저장 완료", el.draft.checked
      ? `${data.relativePath}\n\n다음 글 작성을 위해 입력창을 비웠습니다.`
      : `${data.relativePath}\n\n현재는 로컬 저장만 된 상태입니다.\n사이트 반영은 '전체 변경 GitHub 배포'를 해야 합니다.\n\n다음 글 작성을 위해 입력창을 비웠습니다.`);
  }

  await Promise.all([loadPosts(), loadSummary()]);
  refreshPreviewIfRunning();
}

async function refreshPreviewIfRunning() {
  try {
    const status = await api("/api/preview-status");
    if (status.running) {
      const previewWin = window.open("", "jekyll-preview");
      if (previewWin && !previewWin.closed) {
        previewWin.location.reload();
      }
    }
  } catch {}
}

async function publishDraft(relativePath) {
  if (el.originalPath.value === relativePath && hasUnsavedChanges()) {
    showToast("저장 필요", "현재 열어 둔 임시저장 글에 저장되지 않은 변경이 있습니다.", "error");
    return;
  }

  if (!window.confirm("이 임시저장 글을 발행 글로 옮길까요? 발행 후에는 `_posts` 로 이동합니다.")) {
    return;
  }

  const result = await api("/api/publish-post", {
    method: "POST",
    body: JSON.stringify({ relativePath })
  });

  if (el.originalPath.value === relativePath) {
    fillEditor(await api(`/api/post?path=${encodeURIComponent(result.relativePath)}`));
    clearAutosave("발행 완료");
  }

  setOutput("임시저장 글 발행 완료", `${relativePath}\n→ ${result.relativePath}`);
  await Promise.all([loadPosts(), loadSummary()]);
}

async function deletePostByPath(relativePath, title = "") {
  const label = title ? `\"${title}\"` : relativePath;
  const ok = window.confirm(`${label} 글을 삭제하시겠습니까?\n\n삭제된 글은 GitHub에 바로 반영되지 않고 로컬 휴지통 폴더로 이동합니다.`);
  if (!ok) {
    return;
  }

  const result = await api("/api/delete-post", {
    method: "POST",
    body: JSON.stringify({ relativePath })
  });

  if (el.originalPath.value === relativePath) {
    clearAutosave("삭제 후 입력창을 비웠습니다.");
    resetEditor();
  }

  setOutput("글 삭제 완료", `${result.relativePath}\n\n로컬 휴지통 위치:\n${result.trashPath}`);
  await Promise.all([loadPosts(), loadSummary()]);
}

async function deleteCurrentPost() {
  if (!el.originalPath.value) {
    showToast("삭제 불가", "삭제할 글을 먼저 열어 주세요.", "error");
    return;
  }
  await deletePostByPath(el.originalPath.value, el.title.value.trim());
}

async function beginNewPost() {
  if (!(await confirmReplaceEditor("새 글 작성 화면으로 바꾸기"))) {
    return;
  }
  resetEditor();
  setActivePanel("editor");
}

async function saveRaw() {
  await api("/api/save-raw-file", {
    method: "POST",
    body: JSON.stringify({ kind: state.rawKind, content: el.rawEditor.value })
  });
  setOutput("설정 파일 저장 완료", `${state.rawKind} 저장 완료`);
  await loadSummary();
}

async function buildSite() {
  const data = await api("/api/build", { method: "POST", body: "{}" });
  setOutput(data.code === 0 ? "정적 빌드 성공" : "정적 빌드 실패", `${data.stdout || ""}\n${data.stderr || ""}`.trim());
  await loadSummary();
}

async function startPreview() {
  await api("/api/start-preview", { method: "POST", body: "{}" });
  setOutput("미리보기 시작", "Jekyll 미리보기 서버 시작 요청을 보냈습니다.");
  setTimeout(loadSummary, 1200);
}

async function stopPreview() {
  await api("/api/stop-preview", { method: "POST", body: "{}" });
  setOutput("미리보기 중지", "중지 요청을 보냈습니다.");
  setTimeout(loadSummary, 600);
}

async function publishSite() {
  const data = await api("/api/publish", {
    method: "POST",
    body: JSON.stringify({ message: el.publishMessage.value.trim() })
  });
  setOutput("GitHub 발행 결과", `${data.stdout || ""}\n${data.stderr || ""}`.trim());
  await Promise.all([loadSummary(), loadPosts()]);
}

async function shutdownApp() {
  const shouldClose = window.confirm("웹앱과 연결된 미리보기/터미널을 같이 종료할까요?");
  if (!shouldClose) return;

  await api("/api/shutdown", { method: "POST", body: "{}" });
  document.body.innerHTML = `
    <div style="padding: 48px; font-family: 'Segoe UI', 'Malgun Gothic', sans-serif; color: #1f2937;">
      <h1 style="margin-top: 0;">웹앱을 종료했습니다.</h1>
      <p>관련 서버와 미리보기 종료 요청을 보냈습니다. 열려 있던 터미널 창도 곧 닫힙니다.</p>
      <p>다시 열려면 <strong>app/start-editor.bat</strong> 또는 <strong>app/start.bat</strong> 을 실행하세요.</p>
    </div>
  `;
  setTimeout(() => window.close(), 400);
}

async function uploadImage() {
  const file = el.imageFile.files?.[0];
  if (!file) {
    showToast("파일 없음", "먼저 이미지 파일을 선택하세요.", "error");
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("이미지 읽기에 실패했습니다."));
    reader.readAsDataURL(file);
  });
  const data = await api("/api/upload-image", {
    method: "POST",
    body: JSON.stringify({
      area: el.imageArea.value,
      folderName: el.imageFolder.value.trim(),
      fileName: file.name,
      dataUrl
    })
  });
  state.uploadedMarkdown = data.markdown;
  el.imageResult.value = `${data.sitePath}\n\n${data.markdown}`;
  setOutput("이미지 저장 완료", data.sitePath);
}

function setupAutocomplete(inputEl, getOptions, isMulti = false) {
  if (!inputEl) return;
  const wrap = document.createElement("div");
  wrap.className = "autocomplete-wrap";
  inputEl.parentNode.insertBefore(wrap, inputEl);
  wrap.appendChild(inputEl);

  const list = document.createElement("div");
  list.className = "autocomplete-list";
  wrap.appendChild(list);

  let selectedIdx = -1;

  function getCurrentToken() {
    if (!isMulti) return inputEl.value.trim();
    const parts = inputEl.value.split(",");
    return (parts[parts.length - 1] || "").trim();
  }

  function setCurrentToken(value) {
    if (!isMulti) {
      inputEl.value = value;
    } else {
      const parts = inputEl.value.split(",").map((s) => s.trim());
      parts[parts.length - 1] = value;
      inputEl.value = parts.join(", ");
    }
  }

  function render(query) {
    const options = getOptions();
    const q = query.toLowerCase();
    const filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    if (filtered.length === 0 || (filtered.length === 1 && filtered[0].toLowerCase() === q)) {
      list.classList.remove("show");
      return;
    }
    selectedIdx = -1;
    list.innerHTML = filtered.slice(0, 8).map((o, i) =>
      `<div class="autocomplete-item" data-idx="${i}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</div>`
    ).join("");
    list.classList.add("show");
  }

  inputEl.addEventListener("input", () => render(getCurrentToken()));
  inputEl.addEventListener("focus", () => render(getCurrentToken()));

  inputEl.addEventListener("keydown", (e) => {
    if (!list.classList.contains("show")) return;
    const items = list.querySelectorAll(".autocomplete-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
    } else if (e.key === "Enter" && selectedIdx >= 0) {
      e.preventDefault();
      setCurrentToken(items[selectedIdx].dataset.value);
      list.classList.remove("show");
    } else if (e.key === "Escape") {
      list.classList.remove("show");
    }
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".autocomplete-item");
    if (item) {
      setCurrentToken(item.dataset.value);
      list.classList.remove("show");
      inputEl.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) list.classList.remove("show");
  });
}

function bind() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => run(async () => {
      const nextPanel = setActivePanel(button.dataset.panel);
      await refreshPanelData(nextPanel);
    }));
  });

  document.querySelector("#refresh-summary-btn").addEventListener("click", () => run(loadSummary));
  document.querySelector("#refresh-posts-btn").addEventListener("click", () => run(loadPosts));
  document.querySelector("#new-post-btn").addEventListener("click", () => run(beginNewPost));
  document.querySelector("#save-post-btn").addEventListener("click", () => run(savePost));
  document.querySelector("#save-draft-btn")?.addEventListener("click", () => {
    el.draft.checked = true;
    run(savePost);
  });
  document.querySelector("#delete-post-btn").addEventListener("click", () => run(deleteCurrentPost));
  document.querySelector("#reset-editor-btn").addEventListener("click", () => run(beginNewPost));
  document.querySelector("#upload-image-btn").addEventListener("click", () => run(uploadImage));
  document.querySelector("#insert-image-btn").addEventListener("click", () => {
    if (!state.uploadedMarkdown) { showToast("이미지 없음", "먼저 이미지를 저장하세요.", "error"); return; }
    insertAtCursor(state.uploadedMarkdown);
  });
  document.querySelector("#build-btn").addEventListener("click", () => run(buildSite));
  document.querySelector("#start-preview-btn").addEventListener("click", () => run(startPreview));
  document.querySelector("#stop-preview-btn").addEventListener("click", () => run(stopPreview));
  document.querySelector("#open-preview-btn").addEventListener("click", () => window.open("http://127.0.0.1:4000/", "jekyll-preview"));
  document.querySelector("#publish-btn").addEventListener("click", () => run(publishSite));
  document.querySelector("#shutdown-app-btn").addEventListener("click", () => run(shutdownApp));
  document.querySelector("#save-raw-btn").addEventListener("click", () => run(saveRaw));
  document.querySelector("#qs-save-btn").addEventListener("click", () => run(saveQuickSettings));
  document.querySelector("#qs-avatar").addEventListener("input", updateAvatarPreview);
  document.querySelector("#upload-cover-btn").addEventListener("click", () => run(uploadCoverImage));
  document.querySelector("#remove-cover-btn").addEventListener("click", removeCoverImage);
  el.coverImageFile.addEventListener("change", () => { if (el.coverImageFile.files[0]) run(uploadCoverImage); });
  document.querySelector("#load-template-btn").addEventListener("click", () => run(loadTemplateText));
  document.querySelector("#new-template-btn").addEventListener("click", newTemplate);
  document.querySelector("#save-template-btn").addEventListener("click", () => run(saveTemplateText));
  document.querySelector("#apply-template-btn").addEventListener("click", applyTemplateEditorContent);

  document.querySelectorAll(".word-toolbar [data-insert]").forEach((button) => {
    button.addEventListener("click", () => insertAtCursor(button.dataset.insert.replaceAll("&#10;", "\n")));
  });

  document.querySelectorAll(".word-toolbar [data-wrap-before]").forEach((button) => {
    button.addEventListener("click", () => {
      wrapSelection(
        button.dataset.wrapBefore || "",
        button.dataset.wrapAfter || "",
        button.dataset.wrapPlaceholder || "텍스트"
      );
    });
  });

  // Color swatches
  document.querySelectorAll(".word-toolbar .tb-swatch:not(.tb-swatch-custom)").forEach((button) => {
    button.addEventListener("click", () => {
      applyTextColor(button.dataset.textColor || "#111827");
    });
  });

  // Custom color picker
  const customSwatch = document.querySelector(".tb-swatch-custom");
  if (customSwatch) {
    const colorInput = customSwatch.querySelector(".tb-color-input");
    colorInput.addEventListener("input", (e) => {
      applyTextColor(e.target.value);
    });
  }

  // Alignment buttons
  document.querySelectorAll(".word-toolbar [data-align]").forEach((button) => {
    button.addEventListener("click", () => {
      const align = button.dataset.align;
      if (align === "left") {
        // Remove alignment wrapper if selected text has one
        wrapSelection("", "", "텍스트");
      } else {
        wrapSelection(`<div style="text-align: ${align};">`, "</div>", "정렬할 텍스트");
      }
    });
  });

  // Slug is now auto-generated (numeric), no manual editing needed

  [
    el.title,
    el.slug,
    el.date,
    el.heroTitle,
    el.summary,
    el.heroImagePosition,
    el.categoryMain,
    el.categorySub,
    el.tags,
    el.description,
    el.extra
  ].forEach((field) => {
    field?.addEventListener("input", scheduleAutosave);
  });

  [
    el.draft,
    el.toc,
    el.comments,
    el.pin,
    el.hidden,
    el.mermaid,
    el.math,
    el.dateRefresh
  ].forEach((field) => {
    field?.addEventListener("change", scheduleAutosave);
  });

  // 제목·설명 변경 시 미리보기 헤더도 업데이트
  el.title.addEventListener("input", updateBodyPreview);
  el.heroTitle.addEventListener("input", updateBodyPreview);
  el.heroImagePosition.addEventListener("input", () => { updateBodyPreview(); updateCoverPreview(); });
  el.description.addEventListener("input", updateBodyPreview);

  el.postSearch?.addEventListener("input", (event) => {
    state.searchQuery = event.target.value || "";
    renderPosts(state.posts);
  });

  el.body.addEventListener("input", () => {
    updateBodyPreview();
    scheduleAutosave();
  });
  el.templateEditor.addEventListener("input", updateTemplatePreview);

  // Posts manager list events
  el.pmList?.addEventListener("click", (event) => {
    const publishButton = event.target.closest("[data-publish-path]");
    if (publishButton) {
      run(() => publishDraft(publishButton.dataset.publishPath));
      return;
    }

    const deleteButton = event.target.closest("[data-delete-path]");
    if (deleteButton) {
      run(() => deletePostByPath(deleteButton.dataset.deletePath, deleteButton.dataset.title));
      return;
    }

    const toggleHiddenButton = event.target.closest("[data-toggle-hidden-path]");
    if (toggleHiddenButton) {
      event.stopPropagation();
      run(async () => {
        const relativePath = toggleHiddenButton.dataset.toggleHiddenPath;
        const result = await api("/api/toggle-hidden", { method: "POST", body: JSON.stringify({ relativePath }) });
        if (result.ok) {
          showToast(result.hidden ? "글 숨김" : "글 보이기", result.hidden ? "글이 숨겨졌습니다." : "글이 다시 보입니다.", "success");
          await loadPosts();
        }
      });
      return;
    }

    const openButton = event.target.closest("[data-path]");
    if (openButton) {
      run(() => openPost(openButton.dataset.path));
    }
  });

  // PM tab switching
  document.querySelectorAll(".pm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.pmTab = tab.dataset.pmTab || "all";
      document.querySelectorAll(".pm-tab").forEach((t) => t.classList.toggle("active", t === tab));
      renderPosts(state.posts);
    });
  });

  // PM sort
  const sortSelect = document.getElementById("pm-sort");
  sortSelect?.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    renderPosts(state.posts);
  });

  el.templatesList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template]");
    if (button) run(() => applyTemplate(button.dataset.template));
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => run(() => loadRaw(button.dataset.kind)));
  });

  el.templateSelect.addEventListener("change", () => run(loadTemplateText));

  // --- Keyboard Shortcuts ---
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;

    // Ctrl+S: save
    if (mod && event.key === "s") {
      event.preventDefault();
      if (state.panel === "editor") run(savePost);
      return;
    }
    // Ctrl+N: new post
    if (mod && event.key === "n") {
      event.preventDefault();
      run(beginNewPost);
      return;
    }

    // Shortcuts only when body textarea is focused
    if (document.activeElement !== el.body) return;

    // Ctrl+B: bold
    if (mod && event.key === "b") {
      event.preventDefault();
      wrapSelection("**", "**", "굵게");
      showShortcutHint("굵게 (Ctrl+B)");
      return;
    }
    // Ctrl+I: italic
    if (mod && event.key === "i") {
      event.preventDefault();
      wrapSelection("*", "*", "기울임");
      showShortcutHint("기울임 (Ctrl+I)");
      return;
    }
    // Ctrl+U: underline
    if (mod && event.key === "u") {
      event.preventDefault();
      wrapSelection("<u>", "</u>", "밑줄");
      showShortcutHint("밑줄 (Ctrl+U)");
      return;
    }
    // Ctrl+K: link
    if (mod && event.key === "k") {
      event.preventDefault();
      wrapSelection("[", "](https://)", "링크 텍스트");
      showShortcutHint("링크 (Ctrl+K)");
      return;
    }
    // Ctrl+Shift+C: inline code
    if (mod && event.shiftKey && event.key === "C") {
      event.preventDefault();
      wrapSelection("`", "`", "코드");
      showShortcutHint("인라인 코드 (Ctrl+Shift+C)");
      return;
    }
    // Ctrl+Shift+K: code block
    if (mod && event.shiftKey && event.key === "K") {
      event.preventDefault();
      insertAtCursor("```\n\n```");
      showShortcutHint("코드 블록 (Ctrl+Shift+K)");
      return;
    }
    // Escape: exit fullscreen
    if (event.key === "Escape" && state.fullscreen) {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
  });

  // --- Shortcut Hint Toast ---
  function showShortcutHint(text) {
    let hint = document.querySelector(".shortcut-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "shortcut-hint";
      document.body.appendChild(hint);
    }
    hint.textContent = text;
    hint.classList.add("show");
    clearTimeout(hint._timer);
    hint._timer = setTimeout(() => hint.classList.remove("show"), 1200);
  }

  // --- Word Counter ---
  function updateWordCounter() {
    const text = el.body.value;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const minutes = Math.max(1, Math.round(words / 200));
    const counter = document.getElementById("word-counter");
    if (counter) {
      counter.textContent = `${chars}자 · ${words}단어 · 약 ${minutes}분`;
    }
  }
  el.body.addEventListener("input", updateWordCounter);
  updateWordCounter();

  // --- Fullscreen / Focus Mode ---
  state.fullscreen = false;
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  function toggleFullscreen() {
    const block = document.getElementById("body-block");
    if (!block) return;
    state.fullscreen = !state.fullscreen;
    block.classList.toggle("fullscreen-mode", state.fullscreen);
    fullscreenBtn.textContent = state.fullscreen ? "나가기" : "집중모드";
    if (state.fullscreen) el.body.focus();
  }
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", toggleFullscreen);
  }

  // --- Tag/Category Autocomplete ---
  setupAutocomplete(el.tags, () => {
    const tagSet = new Set();
    for (const post of state.posts) {
      (post.tags || []).forEach((t) => tagSet.add(t));
    }
    return [...tagSet].sort();
  }, true);

  setupAutocomplete(el.categoryMain, () => {
    const catSet = new Set();
    for (const post of state.posts) {
      (post.categories || []).forEach((c) => catSet.add(c));
    }
    return [...catSet].sort();
  });

  setupAutocomplete(el.categorySub, () => {
    const catSet = new Set();
    for (const post of state.posts) {
      (post.categories || []).forEach((c) => catSet.add(c));
    }
    return [...catSet].sort();
  });

  // Image drag & drop on body textarea
  el.body.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.body.classList.add("drag-over");
  });
  el.body.addEventListener("dragleave", () => {
    el.body.classList.remove("drag-over");
  });
  el.body.addEventListener("drop", (event) => {
    event.preventDefault();
    el.body.classList.remove("drag-over");
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    run(async () => {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("image read failed"));
        reader.readAsDataURL(file);
      });
      const folderName = el.slug.value.trim().replace(/\.md$/i, "") || el.title.value.trim() || "dropped";
      const data = await api("/api/upload-image", {
        method: "POST",
        body: JSON.stringify({
          area: "posts",
          folderName,
          fileName: file.name,
          dataUrl
        })
      });
      insertAtCursor(data.markdown);
      setOutput("image drop upload", data.sitePath);
    });
  });

  // Image paste (Ctrl+V) on body textarea
  el.body.addEventListener("paste", (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    let imageItem = null;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        imageItem = item;
        break;
      }
    }
    if (!imageItem) return;
    event.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    run(async () => {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("image read failed"));
        reader.readAsDataURL(file);
      });
      const folderName = el.slug.value.trim().replace(/\.md$/i, "") || el.title.value.trim() || "pasted";
      const data = await api("/api/upload-image", {
        method: "POST",
        body: JSON.stringify({
          area: "posts",
          folderName,
          fileName: file.name || "pasted-image.png",
          dataUrl
        })
      });
      insertAtCursor(data.markdown);
      setOutput("image paste upload", data.sitePath);
    });
  });

  // Category / Tag filters
  const catFilter = document.querySelector("#filter-category");
  const tagFilter = document.querySelector("#filter-tag");
  catFilter?.addEventListener("change", (event) => {
    state.filterCategory = event.target.value;
    renderPosts(state.posts);
  });
  tagFilter?.addEventListener("change", (event) => {
    state.filterTag = event.target.value;
    renderPosts(state.posts);
  });
}

async function run(task) {
  document.body.classList.add("loading");
  try {
    await task();
  } catch (error) {
    setOutput("오류", error.message || "알 수 없는 오류");
    showToast("오류", error.message || "알 수 없는 오류", "error", 6000);
  } finally {
    document.body.classList.remove("loading");
  }
}

async function init() {
  resetEditor();
  bind();
  const savedPanel = (() => { try { return localStorage.getItem("jm-editor-active-panel"); } catch { return null; } })();
  setActivePanel(savedPanel || state.panel);
  try {
    await Promise.all([loadSummary(), loadPosts(), loadTemplates(), loadRaw("config")]);
  } catch (error) {
    setOutput("초기화 오류", `서버 연결에 실패했습니다.\n${error.message}\n\nstart.bat 으로 서버가 실행 중인지 확인하세요.`);
  }
  restoreAutosaveIfNeeded();
  try {
    if (el.templateSelect.value) {
      await loadTemplateText(el.templateSelect.value);
    }
  } catch {}
  renderHelpPreviews();
  updateBodyPreview();
  updateTemplatePreview();
}

init();
