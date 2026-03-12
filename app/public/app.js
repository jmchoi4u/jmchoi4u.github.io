const state = {
  rawKind: "config",
  uploadedMarkdown: "",
  panel: "overview"
};

const markdownEngine = window.marked;
markdownEngine.setOptions({
  gfm: true,
  breaks: true
});

const el = {
  postsList: document.querySelector("#posts-list"),
  templatesList: document.querySelector("#templates-list"),
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
  imageArea: document.querySelector("#image-area"),
  imageFolder: document.querySelector("#image-folder"),
  imageFile: document.querySelector("#image-file"),
  imageResult: document.querySelector("#image-result"),
  publishMessage: document.querySelector("#publish-message"),
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
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "new-post";
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
  state.panel = panelId;
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === panelId);
  });
  document.querySelectorAll(".screen").forEach((section) => {
    section.classList.toggle("active-screen", section.id === panelId);
  });
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

function resetEditor() {
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
  updateBodyPreview();
}

function fillEditor(data) {
  el.title.value = data.title || "";
  el.slug.value = slugify((data.fileName || "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/i, ""));
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
  updateBodyPreview();
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

function renderPosts(posts) {
  el.postsList.innerHTML = posts.length
    ? posts
        .map(
          (post) => `
            <button type="button" class="list-item" data-path="${escapeHtml(post.relativePath)}">
              <strong>${escapeHtml(post.title)}</strong>
              <span>${escapeHtml(post.relativePath)}</span>
            </button>
          `
        )
        .join("")
    : "<div class='muted'>아직 글이 없습니다.</div>";
}

function renderTemplates(templates) {
  el.templateSelect.innerHTML = templates
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
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

async function loadPosts() {
  const data = await api("/api/posts");
  renderPosts(data.posts || []);
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
  fillEditor(await api(`/api/post?path=${encodeURIComponent(path)}`));
  setActivePanel("editor");
}

async function applyTemplate(name) {
  fillEditor(await api(`/api/template?name=${encodeURIComponent(name)}`));
  el.originalPath.value = "";
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
  const data = await api("/api/save-post", {
    method: "POST",
    body: JSON.stringify({
      originalRelativePath: el.originalPath.value || "",
      title: el.title.value.trim(),
      slug: el.slug.value.trim() || slugify(el.title.value),
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
      extra: el.extra.value,
      body: el.body.value
    })
  });
  el.originalPath.value = data.relativePath;
  setOutput("글 저장 완료", data.relativePath);
  await Promise.all([loadPosts(), loadSummary()]);
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
  await loadSummary();
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
    button.addEventListener("click", () => {
      setActivePanel(button.dataset.panel);
    });
  });

  document.querySelector("#refresh-summary-btn").addEventListener("click", () => run(loadSummary));
  document.querySelector("#refresh-posts-btn").addEventListener("click", () => run(loadPosts));
  document.querySelector("#new-post-btn").addEventListener("click", resetEditor);
  document.querySelector("#save-post-btn").addEventListener("click", () => run(savePost));
  document.querySelector("#reset-editor-btn").addEventListener("click", resetEditor);
  document.querySelector("#upload-image-btn").addEventListener("click", () => run(uploadImage));
  document.querySelector("#insert-image-btn").addEventListener("click", () => {
    if (!state.uploadedMarkdown) return alert("먼저 이미지를 저장하세요.");
    insertAtCursor(state.uploadedMarkdown);
  });
  document.querySelector("#build-btn").addEventListener("click", () => run(buildSite));
  document.querySelector("#start-preview-btn").addEventListener("click", () => run(startPreview));
  document.querySelector("#stop-preview-btn").addEventListener("click", () => run(stopPreview));
  document.querySelector("#open-preview-btn").addEventListener("click", () => window.open("http://127.0.0.1:4000/", "_blank", "noopener"));
  document.querySelector("#publish-btn").addEventListener("click", () => run(publishSite));
  document.querySelector("#shutdown-app-btn").addEventListener("click", () => run(shutdownApp));
  document.querySelector("#save-raw-btn").addEventListener("click", () => run(saveRaw));
  document.querySelector("#load-template-btn").addEventListener("click", () => run(loadTemplateText));
  document.querySelector("#new-template-btn").addEventListener("click", newTemplate);
  document.querySelector("#save-template-btn").addEventListener("click", () => run(saveTemplateText));
  document.querySelector("#apply-template-btn").addEventListener("click", applyTemplateEditorContent);

  document.querySelectorAll(".toolbar [data-insert]").forEach((button) => {
    button.addEventListener("click", () => insertAtCursor(button.dataset.insert.replaceAll("&#10;", "\n")));
  });

  document.querySelectorAll(".toolbar [data-wrap-before]").forEach((button) => {
    button.addEventListener("click", () => {
      wrapSelection(
        button.dataset.wrapBefore || "",
        button.dataset.wrapAfter || "",
        button.dataset.wrapPlaceholder || "텍스트"
      );
    });
  });

  document.querySelectorAll(".toolbar [data-text-color]").forEach((button) => {
    button.addEventListener("click", () => {
      applyTextColor(button.dataset.textColor || "#111827");
    });
  });

  el.title.addEventListener("input", () => {
    if (!el.slug.value.trim()) el.slug.value = slugify(el.title.value);
  });

  el.body.addEventListener("input", updateBodyPreview);
  el.templateEditor.addEventListener("input", updateTemplatePreview);

  el.postsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-path]");
    if (button) run(() => openPost(button.dataset.path));
  });

  el.templatesList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template]");
    if (button) run(() => applyTemplate(button.dataset.template));
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => run(() => loadRaw(button.dataset.kind)));
  });

  el.templateSelect.addEventListener("change", () => run(loadTemplateText));
}

async function run(task) {
  try {
    await task();
  } catch (error) {
    setOutput("오류", error.message || "알 수 없는 오류");
    alert(error.message || "알 수 없는 오류");
  }
}

async function init() {
  resetEditor();
  bind();
  setActivePanel("overview");
  await Promise.all([loadSummary(), loadPosts(), loadTemplates(), loadRaw("config")]);
  if (el.templateSelect.value) {
    await loadTemplateText(el.templateSelect.value);
  }
  renderHelpPreviews();
  updateBodyPreview();
  updateTemplatePreview();
}

init();
