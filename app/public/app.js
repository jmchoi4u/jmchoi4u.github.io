const AUTOSAVE_KEY = "jm-blog-editor-autosave-v1";
const AUTOSAVE_DELAY_MS = 1500;

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
  slugManuallyEdited: false
};

const markdownEngine = window.marked;
markdownEngine.setOptions({
  gfm: true,
  breaks: true
});

const el = {
  draftsList: document.querySelector("#drafts-list"),
  pendingPublishedList: document.querySelector("#pending-published-list"),
  publishedPostsList: document.querySelector("#published-posts-list"),
  siteSummary: document.querySelector("#site-summary"),
  previewSummary: document.querySelector("#preview-summary"),
  gitSummary: document.querySelector("#git-summary"),
  commandOutput: document.querySelector("#command-output"),
  previewLogOutput: document.querySelector("#preview-log-output"),
  title: document.querySelector("#post-title"),
  slug: document.querySelector("#post-slug"),
  date: document.querySelector("#post-date"),
  draft: document.querySelector("#post-draft"),
  categoryMain: document.querySelector("#post-category-main"),
  categorySub: document.querySelector("#post-category-sub"),
  tags: document.querySelector("#post-tags"),
  description: document.querySelector("#post-description"),
  toc: document.querySelector("#post-toc"),
  comments: document.querySelector("#post-comments"),
  pin: document.querySelector("#post-pin"),
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
  templatePreview: document.querySelector("#template-preview")
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
  renderMarkdown(el.bodyPreview, el.body.value);
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
}

function setActivePanel(panelId) {
  const fallbackPanel = document.querySelector(".nav-tab.active")?.dataset.panel
    || document.querySelector(".nav-tab")?.dataset.panel
    || "editor";
  const nextPanel = document.getElementById(panelId) ? panelId : fallbackPanel;

  state.panel = nextPanel;
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
    categories: parseCategories(),
    tags: parseTags(el.tags.value),
    description: el.description.value.trim(),
    toc: el.toc.checked,
    comments: el.comments.checked,
    pin: el.pin.checked,
    mermaid: el.mermaid.checked,
    math: el.math.checked,
    extra: el.extra.value,
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
  el.categoryMain.value = "";
  el.categorySub.value = "";
  el.tags.value = "";
  el.description.value = "";
  el.toc.checked = true;
  el.comments.checked = true;
  el.pin.checked = false;
  el.mermaid.checked = false;
  el.math.checked = false;
  el.extra.value = "";
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
  el.categoryMain.value = data.categories?.[0] || "";
  el.categorySub.value = data.categories?.[1] || "";
  el.tags.value = (data.tags || []).join(", ");
  el.description.value = data.description || "";
  el.toc.checked = data.toc !== false;
  el.comments.checked = data.comments !== false;
  el.pin.checked = Boolean(data.pin);
  el.mermaid.checked = Boolean(data.mermaid);
  el.math.checked = Boolean(data.math);
  el.extra.value = data.extra || "";
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

function renderPostGroup(target, posts, options = {}) {
  if (!target) return;

  target.innerHTML = posts.length
    ? posts
        .map(
          (post) => `
            <article class="managed-post">
              <button type="button" class="list-item" data-path="${escapeHtml(post.relativePath)}">
                <strong>${escapeHtml(post.title)}</strong>
                <span>${escapeHtml(post.relativePath)}</span>
              </button>
              <div class="list-entry-actions">
                <button type="button" data-path="${escapeHtml(post.relativePath)}">수정</button>
                ${
                  options.draft
                    ? `<button type="button" class="primary" data-publish-path="${escapeHtml(post.relativePath)}">발행</button>`
                    : ""
                }
                <button type="button" class="danger" data-delete-path="${escapeHtml(post.relativePath)}" data-title="${escapeHtml(post.title)}">삭제</button>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class='muted'>${options.emptyText || "표시할 글이 없습니다."}</div>`;
}

function renderPosts(posts) {
  const query = state.searchQuery.trim().toLowerCase();
  let filtered = query
    ? posts.filter((post) =>
        [post.title, post.relativePath, post.fileName]
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

  const drafts = filtered.filter((post) => post.draft);
  const pendingPublished = filtered.filter((post) => !post.draft && post.pendingDeploy);
  const published = filtered.filter((post) => !post.draft && !post.pendingDeploy);

  renderPostGroup(el.draftsList, drafts, { draft: true, emptyText: "임시저장 글이 없습니다." });
  renderPostGroup(el.pendingPublishedList, pendingPublished, { emptyText: "아직 GitHub 배포 전인 발행 글이 없습니다." });
  renderPostGroup(el.publishedPostsList, published, { emptyText: "발행 글이 없습니다." });
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
    return { fileName, title: "", date: formatNow(), categories: [], tags: [], description: "", toc: true, comments: true, pin: false, mermaid: false, math: false, extra: "", body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { fileName, title: "", date: formatNow(), categories: [], tags: [], description: "", toc: true, comments: true, pin: false, mermaid: false, math: false, extra: "", body: normalized };
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
    .filter((line) => !/^(title|date|categories|tags|description|toc|comments|pin|mermaid|math):/.test(line.trim()))
    .join("\n")
    .trim();
  return {
    fileName,
    title: pick(/^title:\s*(.+)$/m),
    date: pick(/^date:\s*(.+)$/m) || formatNow(),
    categories: parseList(pick(/^categories:\s*(.+)$/m)),
    tags: parseList(pick(/^tags:\s*(.+)$/m)),
    description: pick(/^description:\s*(.+)$/m),
    toc: pickBool("toc", true),
    comments: pickBool("comments", true),
    pin: pickBool("pin", false),
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
      categories: parseCategories(),
      tags: parseTags(el.tags.value),
      description: el.description.value.trim(),
      toc: el.toc.checked,
      comments: el.comments.checked,
      pin: el.pin.checked,
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
    alert("현재 열어 둔 임시저장 글에 저장되지 않은 변경이 있습니다. 먼저 저장한 뒤 발행해 주세요.");
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
    alert("삭제할 글을 먼저 열어 주세요.");
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
    alert("먼저 이미지 파일을 선택하세요.");
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
  document.querySelector("#delete-post-btn").addEventListener("click", () => run(deleteCurrentPost));
  document.querySelector("#reset-editor-btn").addEventListener("click", () => run(beginNewPost));
  document.querySelector("#upload-image-btn").addEventListener("click", () => run(uploadImage));
  document.querySelector("#insert-image-btn").addEventListener("click", () => {
    if (!state.uploadedMarkdown) return alert("먼저 이미지를 저장하세요.");
    insertAtCursor(state.uploadedMarkdown);
  });
  document.querySelector("#build-btn").addEventListener("click", () => run(buildSite));
  document.querySelector("#start-preview-btn").addEventListener("click", () => run(startPreview));
  document.querySelector("#stop-preview-btn").addEventListener("click", () => run(stopPreview));
  document.querySelector("#open-preview-btn").addEventListener("click", () => window.open("http://127.0.0.1:4000/", "jekyll-preview"));
  document.querySelector("#publish-btn").addEventListener("click", () => run(publishSite));
  document.querySelector("#shutdown-app-btn").addEventListener("click", () => run(shutdownApp));
  document.querySelector("#save-raw-btn").addEventListener("click", () => run(saveRaw));
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
    el.mermaid,
    el.math,
    el.dateRefresh
  ].forEach((field) => {
    field?.addEventListener("change", scheduleAutosave);
  });

  el.postSearch?.addEventListener("input", (event) => {
    state.searchQuery = event.target.value || "";
    renderPosts(state.posts);
  });

  el.body.addEventListener("input", () => {
    updateBodyPreview();
    scheduleAutosave();
  });
  el.templateEditor.addEventListener("input", updateTemplatePreview);

  [el.draftsList, el.pendingPublishedList, el.publishedPostsList].forEach((list) => {
    list?.addEventListener("click", (event) => {
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

      const openButton = event.target.closest("[data-path]");
      if (openButton) {
        run(() => openPost(openButton.dataset.path));
      }
    });
  });

  el.templatesList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template]");
    if (button) run(() => applyTemplate(button.dataset.template));
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => run(() => loadRaw(button.dataset.kind)));
  });

  el.templateSelect.addEventListener("change", () => run(loadTemplateText));

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      if (state.panel === "editor") run(savePost);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "n") {
      event.preventDefault();
      run(beginNewPost);
    }
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
    alert(error.message || "알 수 없는 오류");
  } finally {
    document.body.classList.remove("loading");
  }
}

async function init() {
  resetEditor();
  bind();
  setActivePanel(state.panel);
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
