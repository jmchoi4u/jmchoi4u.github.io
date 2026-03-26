import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_PORT = 4317;
const PREVIEW_PORT = 4000;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
const LOG_RETENTION_DAYS = 7;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const logsDir = path.join(__dirname, "logs");
const logFile = path.join(logsDir, "editor.log");
const postsDir = path.join(repoRoot, "_posts");
const draftsDir = path.join(repoRoot, "_drafts");
const trashDir = path.join(repoRoot, "_trash");
const templatesDir = path.join(repoRoot, "src", "templates");
const assetsDir = path.join(repoRoot, "assets", "img");
const LOCAL_ONLY_STAGE_EXCLUDES = [
  ".claude",
  "AGENT_COLLAB_LOG.md",
  "app/logs"
];

const rawFiles = {
  config: path.join(repoRoot, "_config.yml"),
  contact: path.join(repoRoot, "_data", "contact.yml"),
  about: path.join(repoRoot, "_tabs", "about.md")
};

const state = {
  previewProcess: null,
  previewLogs: [],
  appLogs: [],
  shuttingDown: false,
  lastLogCleanupAt: 0
};

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".yml": "text/plain; charset=utf-8"
};

await fs.mkdir(logsDir, { recursive: true });
await fs.mkdir(postsDir, { recursive: true });
await fs.mkdir(draftsDir, { recursive: true });
await fs.mkdir(trashDir, { recursive: true });
await pruneOldLogs();

function stamp() {
  return new Date().toLocaleString("ko-KR");
}

async function appendLog(scope, message) {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  await fs.appendFile(logFile, line, "utf8");
  triggerLogCleanup();
}

async function pruneOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let content = "";

  try {
    content = await fs.readFile(logFile, "utf8");
  } catch {
    state.lastLogCleanupAt = Date.now();
    return;
  }

  const keptLines = content
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const match = line.match(/^\[([^\]]+)\]/);
      if (!match) return true;
      const time = Date.parse(match[1]);
      return Number.isNaN(time) || time >= cutoff;
    });

  await fs.writeFile(logFile, keptLines.length ? `${keptLines.join("\n")}\n` : "", "utf8");
  state.lastLogCleanupAt = Date.now();
}

function triggerLogCleanup() {
  if (Date.now() - state.lastLogCleanupAt < LOG_CLEANUP_INTERVAL_MS) {
    return;
  }

  // 오래된 로그만 주기적으로 정리해 두면 파일이 계속 비대해지지 않습니다.
  pruneOldLogs().catch(() => {});
}

function rememberLog(scope, message) {
  const line = `[${stamp()}] [${scope}] ${message}`;
  state.appLogs.unshift(line);
  state.appLogs = state.appLogs.slice(0, 200);
  appendLog(scope, message).catch(() => {});
}

function rememberPreview(message) {
  const line = `[${stamp()}] ${message}`;
  state.previewLogs.unshift(line);
  state.previewLogs = state.previewLogs.slice(0, 200);
  appendLog("PREVIEW", message).catch(() => {});
}

function sendJson(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, code, text) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function inside(base, target) {
  return path.resolve(target).startsWith(path.resolve(base));
}

function safeJoin(base, child) {
  const result = path.resolve(base, child);
  if (!inside(base, result)) {
    throw new Error("허용되지 않은 경로입니다.");
  }
  return result;
}

async function readBody(req) {
  const parts = [];
  for await (const chunk of req) {
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

function parseList(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  return trimmed.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function yamlString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlInlineBreaks(value) {
  return String(value || "").replace(/\r?\n/g, "<br>");
}

function parseDoc(text, fileName = "") {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fileName, title: "", date: "", heroTitle: "", summary: "", heroImagePosition: "", categories: [], tags: [], description: "", extra: "", body: normalized, draft: false, hidden: false, permalink: "" };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { fileName, title: "", date: "", heroTitle: "", summary: "", heroImagePosition: "", categories: [], tags: [], description: "", extra: "", body: normalized, draft: false, hidden: false, permalink: "" };
  }
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 5).replace(/^\n/, "");
  const pick = (regex) => {
    const m = head.match(regex);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const pickBool = (key, fallback) => {
    const value = pick(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!value) return fallback;
    return value === "true";
  };
  const coverImageObjectMatch = head.match(/^image:\s*\n\s+path:\s*(.+)$/m);
  const coverImageScalarMatch = head.match(/^image:\s*(.+)$/m);
  const coverImage = coverImageObjectMatch
    ? coverImageObjectMatch[1].trim().replace(/^["']|["']$/g, "")
    : (coverImageScalarMatch ? coverImageScalarMatch[1].trim().replace(/^["']|["']$/g, "") : "");
  const extra = head
    .split("\n")
    .filter((line) => !/^(title|date|hero_title|summary|hero_image_position|categories|tags|description|toc|comments|pin|mermaid|math|permalink|hidden|image):/.test(line.trim()))
    .filter((line) => !(coverImageObjectMatch && /^\s+path:/.test(line)))
    .join("\n")
    .trim();
  return {
    fileName,
    title: pick(/^title:\s*(.+)$/m),
    date: pick(/^date:\s*(.+)$/m),
    heroTitle: pick(/^hero_title:\s*(.+)$/m),
    summary: pick(/^summary:\s*(.+)$/m),
    heroImagePosition: pick(/^hero_image_position:\s*(.+)$/m),
    categories: parseList(pick(/^categories:\s*(.+)$/m)),
    tags: parseList(pick(/^tags:\s*(.+)$/m)),
    description: pick(/^description:\s*(.+)$/m),
    toc: pickBool("toc", true),
    comments: pickBool("comments", true),
    pin: pickBool("pin", false),
    mermaid: pickBool("mermaid", false),
    math: pickBool("math", false),
    hidden: pickBool("hidden", false),
    coverImage,
    permalink: pick(/^permalink:\s*(.+)$/m),
    extra,
    body
  };
}

function makeDoc(data) {
  const lines = [
    "---",
    `title: ${yamlString(data.title || "제목 없음")}`,
    `date: ${data.date}`
  ];
  if (data.heroTitle) {
    lines.push(`hero_title: ${yamlString(yamlInlineBreaks(data.heroTitle))}`);
  }
  if (data.summary) {
    lines.push(`summary: ${yamlString(data.summary)}`);
  }
  if (data.heroImagePosition) {
    lines.push(`hero_image_position: ${yamlString(data.heroImagePosition)}`);
  }
  if ((data.categories || []).length) {
    lines.push(`categories: [${data.categories.map(yamlString).join(", ")}]`);
  }
  if ((data.tags || []).length) {
    lines.push(`tags: [${data.tags.map(yamlString).join(", ")}]`);
  }
  if (data.description) {
    lines.push(`description: ${yamlString(data.description)}`);
  }
  lines.push(`toc: ${data.toc ? "true" : "false"}`);
  lines.push(`comments: ${data.comments ? "true" : "false"}`);
  lines.push(`pin: ${data.pin ? "true" : "false"}`);
  lines.push(`mermaid: ${data.mermaid ? "true" : "false"}`);
  lines.push(`math: ${data.math ? "true" : "false"}`);
  if (data.hidden) {
    lines.push(`hidden: true`);
  }
  if (data.coverImage) {
    lines.push(`image:`);
    lines.push(`  path: ${data.coverImage}`);
  }
  if (data.permalink) {
    lines.push(`permalink: ${data.permalink}`);
  }
  if (String(data.extra || "").trim()) {
    lines.push(String(data.extra).trimEnd());
  }
  lines.push("---", "", String(data.body || "").trimEnd(), "");
  return lines.join("\n");
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

function makeTimeSlug(dateText = "") {
  const source = String(dateText || "");
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
  }

  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function resolvePostSlug(slugValue, titleValue, dateText) {
  return slugify(slugValue) || slugify(titleValue) || makeTimeSlug(dateText);
}

function collectManagedPostPath(targetSet, filePath) {
  const normalized = String(filePath || "")
    .trim()
    .replace(/^"(.*)"$/g, "$1")
    .replace(/\\"/g, "\"")
    .replace(/\\/g, "/");
  if (normalized.startsWith("_posts/") && normalized.endsWith(".md")) {
    targetSet.add(normalized);
  }
}

function collectManagedPostPathsFromStatus(text) {
  const result = new Set();
  for (const line of String(text || "").split(/\r?\n/).filter(Boolean)) {
    const body = line.slice(3).trim();
    if (!body) continue;

    if (body.includes(" -> ")) {
      const [before, after] = body.split(" -> ");
      collectManagedPostPath(result, before);
      collectManagedPostPath(result, after);
      continue;
    }

    collectManagedPostPath(result, body);
  }
  return result;
}

async function listPendingPublishedPaths() {
  const pending = new Set();
  const workingTree = await run("git status --porcelain=v1 --untracked-files=all -- _posts");

  if (workingTree.code === 0) {
    for (const filePath of collectManagedPostPathsFromStatus(workingTree.stdout)) {
      pending.add(filePath);
    }
  }

  const upstream = await run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
  if (upstream.code !== 0) {
    return pending;
  }

  const remoteRef = upstream.stdout.trim();
  if (!remoteRef) {
    return pending;
  }

  const ahead = await run(`git diff --name-only ${remoteRef}..HEAD -- _posts`);
  if (ahead.code === 0) {
    for (const filePath of String(ahead.stdout || "").split(/\r?\n/).filter(Boolean)) {
      collectManagedPostPath(pending, filePath);
    }
  }

  return pending;
}

async function moveFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      await fs.copyFile(source, target);
      await fs.unlink(source);
      return;
    }
    throw error;
  }
}

async function run(command, cwd = repoRoot) {
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function joinOutput(...parts) {
  return parts.filter(Boolean).join("\n").trim();
}

function looksLikeNonFastForward(result) {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return /fetch first|non-fast-forward|failed to push some refs/i.test(text);
}

function looksLikeNoUpstream(result) {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return /has no upstream branch|no upstream branch/i.test(text);
}

async function unstageLocalOnlyPaths() {
  for (const relativePath of LOCAL_ONLY_STAGE_EXCLUDES) {
    // 로컬 전용 설정/로그는 배포 커밋에 섞이지 않도록 자동으로 스테이징에서만 제외합니다.
    await run(`git reset -q HEAD -- "${relativePath}"`);
  }
}

async function syncRemoteBranch() {
  const upstream = await run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
  if (upstream.code !== 0) {
    return { ok: true, skipped: true, stdout: "", stderr: "" };
  }

  const fetch = await run("git fetch --prune");
  if (fetch.code !== 0) {
    return {
      ok: false,
      step: "fetch",
      error: `원격 변경 확인 실패: ${fetch.stderr || fetch.stdout || "git fetch 오류"}`,
      ...fetch
    };
  }

  const pull = await run("git pull --no-edit --no-rebase");
  if (pull.code !== 0) {
    await run("git merge --abort");
    return {
      ok: false,
      step: "pull",
      error: "원격 변경을 자동으로 합치는 중 충돌이 발생했습니다. 다른 곳에서 같은 파일을 수정한 것 같습니다.",
      stdout: joinOutput(fetch.stdout, pull.stdout),
      stderr: joinOutput(fetch.stderr, pull.stderr)
    };
  }

  return {
    ok: true,
    step: "pull",
    stdout: joinOutput(fetch.stdout, pull.stdout),
    stderr: joinOutput(fetch.stderr, pull.stderr)
  };
}

async function pushCurrentBranch() {
  let push = await run("git push");
  if (push.code === 0) {
    return push;
  }

  if (looksLikeNoUpstream(push)) {
    push = await run("git push -u origin HEAD");
  }

  return push;
}

async function summary() {
  const config = await fs.readFile(rawFiles.config, "utf8");
  const contact = await fs.readFile(rawFiles.contact, "utf8");
  const pick = (regex) => {
    const m = config.match(regex);
    return m
      ? m[1]
          .replace(/\s+#.*$/g, "")
          .trim()
          .replace(/^["']|["']$/g, "")
      : "";
  };
  const git = await run("git status --short --branch");
  const remote = await run("git remote get-url origin");
  const posts = await listPosts();
  const templates = await listTemplates();
  return {
    site: {
      title: pick(/^title:\s*(.+)$/m),
      tagline: pick(/^tagline:\s*(.+)$/m),
      url: pick(/^url:\s*(.+)$/m),
      avatar: pick(/^avatar:\s*(.+)$/m),
      author: pick(/^\s+name:\s*(.+)$/m),
      email: pick(/^\s+email:\s*(.+)$/m),
      links: [...contact.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1])
    },
    git: {
      branch: git.stdout.split(/\r?\n/)[0] || "",
      status: git.stdout.trim(),
      remote: remote.stdout.trim()
    },
    postsCount: posts.length,
    templatesCount: templates.length,
    preview: {
      running: Boolean(state.previewProcess),
      url: PREVIEW_URL,
      logs: state.previewLogs
    },
    logs: state.appLogs
  };
}

async function listPosts() {
  const result = [];
  const pendingPublishedPaths = await listPendingPublishedPaths();
  for (const [dir, draft] of [[postsDir, false], [draftsDir, true]]) {
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md"));
    } catch {}
    for (const name of names) {
      const full = path.join(dir, name);
      let raw;
      try { raw = await fs.readFile(full, "utf8"); } catch { continue; }
      const parsed = parseDoc(raw, name);
      result.push({
        fileName: name,
        relativePath: path.relative(repoRoot, full).replace(/\\/g, "/"),
        title: parsed.title || name.replace(/\.md$/i, ""),
        date: parsed.date,
        categories: parsed.categories || [],
        tags: parsed.tags || [],
        draft,
        hidden: parsed.hidden || false,
        pendingDeploy: !draft && pendingPublishedPaths.has(path.relative(repoRoot, full).replace(/\\/g, "/"))
      });
    }
  }
  return result.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
}

async function listTemplates() {
  const names = await fs.readdir(templatesDir);
  return names.filter((n) => n.endsWith(".md")).sort();
}

function normalizeTemplateName(name) {
  const fileName = path.basename(String(name || "").trim());
  if (!fileName.endsWith(".md")) {
    throw new Error("템플릿 파일명은 .md 로 끝나야 합니다.");
  }
  return fileName;
}

async function readTextFile(kind) {
  const file = rawFiles[kind];
  if (!file) throw new Error("허용되지 않은 파일입니다.");
  return await fs.readFile(file, "utf8");
}

async function saveTextFile(kind, content) {
  const file = rawFiles[kind];
  if (!file) throw new Error("허용되지 않은 파일입니다.");
  await fs.writeFile(file, content, "utf8");
  rememberLog("SAVE", `${kind} 파일 저장 완료`);
}

async function readTemplateText(name) {
  const fileName = normalizeTemplateName(name);
  const filePath = safeJoin(templatesDir, fileName);
  return await fs.readFile(filePath, "utf8");
}

async function saveTemplateText(name, content) {
  const fileName = normalizeTemplateName(name);
  const filePath = safeJoin(templatesDir, fileName);
  await fs.writeFile(filePath, content, "utf8");
  rememberLog("TEMPLATE", `${fileName} 저장 완료`);
}

function resolveManagedPostPath(relativePath) {
  const normalized = String(relativePath || "").trim().replace(/\\/g, "/");
  if (!normalized) {
    throw new Error("삭제할 글 경로가 비어 있습니다.");
  }
  if (!(normalized.startsWith("_posts/") || normalized.startsWith("_drafts/")) || !normalized.endsWith(".md")) {
    throw new Error("삭제할 수 없는 글 경로입니다.");
  }
  return {
    normalized,
    fullPath: safeJoin(repoRoot, normalized)
  };
}

async function backupFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  const backupPath = path.join(trashDir, `backup-${makeTimeSlug()}`, relativePath);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(filePath, backupPath);
  rememberLog("BACKUP", `${relativePath} -> ${path.relative(repoRoot, backupPath).replace(/\\/g, "/")}`);
}

async function getNextPostNumber() {
  let maxNum = 0;
  for (const dir of [postsDir, draftsDir]) {
    let names = [];
    try { names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")); } catch {}
    for (const name of names) {
      try {
        const raw = await fs.readFile(path.join(dir, name), "utf8");
        const match = raw.match(/^permalink:\s*\/posts\/(\d+)\/?/m);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      } catch {}
    }
  }
  return maxNum + 1;
}

async function savePost(data) {
  const draft = Boolean(data.draft);
  const date = String(data.date || "").trim() || `${new Date().toISOString().slice(0, 16).replace("T", " ")}:00 +0900`;
  const categories = (data.categories || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2);
  const tags = (data.tags || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

  // Auto-assign permalink number and use it as file slug
  let permalink = data.permalink || "";
  let postNum;
  if (!permalink) {
    postNum = await getNextPostNumber();
    if (!draft) permalink = `/posts/${postNum}/`;
  } else {
    const numMatch = permalink.match(/\/posts\/(\d+)\/?/);
    postNum = numMatch ? parseInt(numMatch[1], 10) : await getNextPostNumber();
  }

  const slug = String(postNum);
  const fileName = draft ? `${slug}.md` : `${date.slice(0, 10)}-${slug}.md`;
  const target = path.join(draft ? draftsDir : postsDir, fileName);

  const content = makeDoc({
    title: data.title,
    date,
    heroTitle: data.heroTitle,
    summary: data.summary,
    heroImagePosition: data.heroImagePosition,
    categories,
    tags,
    description: data.description,
    toc: data.toc !== false,
    comments: data.comments !== false,
    pin: Boolean(data.pin),
    hidden: Boolean(data.hidden),
    mermaid: Boolean(data.mermaid),
    math: Boolean(data.math),
    coverImage: data.coverImage || "",
    permalink,
    extra: data.extra,
    body: data.body
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await backupFile(target);
  if (data.originalRelativePath) {
    const oldPath = safeJoin(repoRoot, data.originalRelativePath);
    if (oldPath !== target) {
      await backupFile(oldPath);
    }
  }
  await fs.writeFile(target, content, "utf8");
  try {
    await fs.access(target);
  } catch {
    throw new Error(`파일 저장 실패: ${fileName} 파일이 디스크에 기록되지 않았습니다.`);
  }
  if (data.originalRelativePath) {
    const oldPath = safeJoin(repoRoot, data.originalRelativePath);
    if (oldPath !== target) {
      try { await fs.unlink(oldPath); } catch {}
    }
  }
  rememberLog("POST", `${fileName} 저장 완료`);
  return { ok: true, relativePath: path.relative(repoRoot, target).replace(/\\/g, "/"), fileName };
}

async function deletePost(data) {
  const { normalized, fullPath } = resolveManagedPostPath(data.relativePath);
  const trashPath = path.join(trashDir, makeTimeSlug(new Date().toISOString().replace("T", " ").replace("Z", "")), normalized);
  await moveFile(fullPath, trashPath);
  rememberLog("POST", `${normalized} 로컬 휴지통 이동 완료`);
  return { ok: true, relativePath: normalized, trashPath };
}

async function toggleHidden(data) {
  const { normalized, fullPath } = resolveManagedPostPath(data.relativePath);
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = parseDoc(raw, path.basename(fullPath));
  const newHidden = !parsed.hidden;
  const newDoc = makeDoc({ ...parsed, hidden: newHidden });
  await fs.writeFile(fullPath, newDoc, "utf8");
  rememberLog("POST", `${normalized} → ${newHidden ? "숨김" : "숨김 해제"}`);
  return { ok: true, relativePath: normalized, hidden: newHidden };
}

async function publishDraft(data) {
  const { normalized, fullPath } = resolveManagedPostPath(data.relativePath);
  if (!normalized.startsWith("_drafts/")) {
    throw new Error("임시저장 글만 발행할 수 있습니다.");
  }

  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = parseDoc(raw, path.basename(fullPath));
  const draftBaseName = path.basename(fullPath, ".md").replace(/^autosave-\d{8}-\d{6}-/, "");

  return await savePost({
    originalRelativePath: normalized,
    title: parsed.title,
    slug: resolvePostSlug(draftBaseName, parsed.title, parsed.date),
    date: parsed.date,
    draft: false,
    heroTitle: parsed.heroTitle || "",
    summary: parsed.summary || "",
    heroImagePosition: parsed.heroImagePosition || "",
    categories: parsed.categories,
    tags: parsed.tags,
    description: parsed.description,
    toc: parsed.toc !== false,
    comments: parsed.comments !== false,
    pin: Boolean(parsed.pin),
    hidden: Boolean(parsed.hidden),
    mermaid: Boolean(parsed.mermaid),
    math: Boolean(parsed.math),
    coverImage: parsed.coverImage || "",
    permalink: parsed.permalink || "",
    extra: parsed.extra,
    body: parsed.body
  });
}

async function saveImage(data) {
  const area = data.area === "profile" ? "profile" : "posts";
  const folder = area === "profile" ? "profile" : slugify(data.folderName || "sample-post");
  const fileName = path.basename(data.fileName || "image.png");
  const match = String(data.dataUrl || "").match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error("이미지 데이터가 올바르지 않습니다.");
  const targetDir = area === "profile" ? path.join(assetsDir, "profile") : path.join(assetsDir, "posts", folder);
  await fs.mkdir(targetDir, { recursive: true });
  const full = path.join(targetDir, fileName);
  await fs.writeFile(full, Buffer.from(match[2], "base64"));
  const sitePath = `/${path.relative(repoRoot, full).replace(/\\/g, "/")}`;
  rememberLog("IMAGE", `${sitePath} 저장 완료`);
  return { ok: true, sitePath, markdown: `![이미지 설명](${sitePath})` };
}

async function killPort(port) {
  await run(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $($_.OwningProcess) -Force -ErrorAction SilentlyContinue }"`);
}

async function killPreviewPort() {
  await killPort(PREVIEW_PORT);
}

async function startPreview() {
  if (state.previewProcess) {
    return { ok: true, message: "이미 실행 중입니다.", url: PREVIEW_URL };
  }
  await killPreviewPort();
  state.previewLogs = [];
  state.previewProcess = spawn(`bundle exec jekyll serve --livereload --host 127.0.0.1 --port ${PREVIEW_PORT}`, {
    cwd: repoRoot,
    shell: true,
    env: process.env,
    windowsHide: true
  });
  state.previewProcess.stdout.on("data", (chunk) => rememberPreview(chunk.toString().trim()));
  state.previewProcess.stderr.on("data", (chunk) => rememberPreview(chunk.toString().trim()));
  state.previewProcess.on("close", (code) => {
    rememberPreview(`미리보기 서버 종료. 코드: ${code}`);
    state.previewProcess = null;
  });
  rememberLog("PREVIEW", "미리보기 서버 시작");
  return { ok: true, message: "미리보기 서버 시작", url: PREVIEW_URL };
}

async function stopPreview() {
  if (state.previewProcess) {
    state.previewProcess.kill();
  }
  await killPreviewPort();
  state.previewProcess = null;
  rememberLog("PREVIEW", "미리보기 서버 중지 요청");
  return { ok: true, message: "중지 요청을 보냈습니다." };
}

async function shutdownApp() {
  if (state.shuttingDown) {
    return { ok: true, message: "이미 종료 중입니다." };
  }

  state.shuttingDown = true;
  rememberLog("APP", "웹앱 종료 요청");

  try {
    await stopPreview();
  } catch (error) {
    rememberLog("ERROR", error instanceof Error ? error.message : "미리보기 종료 중 오류");
  }

  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  }, 200);

  return { ok: true, message: "웹앱 종료를 시작했습니다." };
}

async function buildSite() {
  rememberLog("BUILD", "정적 빌드 실행");
  return await run("bundle exec jekyll b");
}

async function publish(message) {
  const commitMessage = String(message || "").trim() || `blog update ${new Date().toISOString()}`;
  const add = await run("git add -A");
  if (add.code !== 0) return { ok: false, error: "git add 실패: 파일 스테이징 중 오류가 발생했습니다.", step: "add", ...add };
  await unstageLocalOnlyPaths();
  const msgFile = path.join(logsDir, "commit-msg.tmp");
  await fs.writeFile(msgFile, commitMessage, "utf8");
  const commit = await run(`git commit -F "${msgFile.replace(/\\/g, "/")}"`);
  await fs.unlink(msgFile).catch(() => {});
  const nothing = `${commit.stdout}\n${commit.stderr}`.includes("nothing to commit");
  if (commit.code !== 0 && !nothing) return { ok: false, error: `git commit 실패: ${commit.stderr || commit.stdout || "알 수 없는 오류"}`, step: "commit", ...commit };

  const sync = await syncRemoteBranch();
  if (!sync.ok) {
    return {
      ok: false,
      step: sync.step,
      error: sync.error,
      stdout: joinOutput(commit.stdout, sync.stdout),
      stderr: joinOutput(commit.stderr, sync.stderr)
    };
  }

  let push = await pushCurrentBranch();
  if (push.code !== 0 && looksLikeNonFastForward(push)) {
    const retrySync = await syncRemoteBranch();
    if (!retrySync.ok) {
      return {
        ok: false,
        step: retrySync.step,
        error: retrySync.error,
        stdout: joinOutput(commit.stdout, sync.stdout, retrySync.stdout),
        stderr: joinOutput(commit.stderr, sync.stderr, push.stderr, retrySync.stderr)
      };
    }
    push = await pushCurrentBranch();
  }

  if (push.code !== 0) {
    return {
      ok: false,
      error: `git push 실패: ${push.stderr || push.stdout || "원격 저장소 연결을 확인하세요."}`,
      step: "push",
      stdout: joinOutput(commit.stdout, sync.stdout, push.stdout),
      stderr: joinOutput(commit.stderr, sync.stderr, push.stderr)
    };
  }

  rememberLog("PUBLISH", nothing ? "원격 동기화 후 git push 완료" : "커밋 후 원격 동기화 + git push 완료");
  return {
    ok: true,
    step: nothing ? "push-only" : "push",
    stdout: joinOutput(commit.stdout, sync.stdout, push.stdout),
    stderr: joinOutput(commit.stderr, sync.stderr, push.stderr)
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/summary") return sendJson(res, 200, await summary());
  if (req.method === "GET" && url.pathname === "/api/posts") return sendJson(res, 200, { posts: await listPosts() });
  if (req.method === "GET" && url.pathname === "/api/post") {
    const relativePath = url.searchParams.get("path") || "";
    const full = safeJoin(repoRoot, relativePath);
    return sendJson(res, 200, { ...parseDoc(await fs.readFile(full, "utf8"), path.basename(full)), relativePath, draft: relativePath.startsWith("_drafts/") });
  }
  if (req.method === "GET" && url.pathname === "/api/templates") return sendJson(res, 200, { templates: await listTemplates() });
  if (req.method === "GET" && url.pathname === "/api/template") {
    const name = url.searchParams.get("name") || "";
    const full = safeJoin(templatesDir, name);
    return sendJson(res, 200, parseDoc(await fs.readFile(full, "utf8"), name));
  }
  if (req.method === "GET" && url.pathname === "/api/template-raw") return sendJson(res, 200, { name: url.searchParams.get("name"), content: await readTemplateText(url.searchParams.get("name")) });
  if (req.method === "GET" && url.pathname === "/api/raw-file") return sendJson(res, 200, { kind: url.searchParams.get("kind"), content: await readTextFile(url.searchParams.get("kind")) });
  if (req.method === "GET" && url.pathname === "/api/preview-status") return sendJson(res, 200, { running: Boolean(state.previewProcess), url: PREVIEW_URL, logs: state.previewLogs });
  if (req.method === "GET" && url.pathname === "/api/filters") {
    const posts = await listPosts();
    const catSet = new Set();
    const tagSet = new Set();
    for (const post of posts) {
      try {
        const full = safeJoin(repoRoot, post.relativePath);
        const raw = await fs.readFile(full, "utf8");
        const parsed = parseDoc(raw, post.fileName);
        (parsed.categories || []).forEach((c) => catSet.add(c));
        (parsed.tags || []).forEach((t) => tagSet.add(t));
      } catch {}
    }
    return sendJson(res, 200, { categories: [...catSet].sort(), tags: [...tagSet].sort() });
  }

  const payload = JSON.parse((await readBody(req)) || "{}");
  if (req.method === "POST" && url.pathname === "/api/save-post") return sendJson(res, 200, await savePost(payload));
  if (req.method === "POST" && url.pathname === "/api/delete-post") return sendJson(res, 200, await deletePost(payload));
  if (req.method === "POST" && url.pathname === "/api/publish-post") return sendJson(res, 200, await publishDraft(payload));
  if (req.method === "POST" && url.pathname === "/api/toggle-hidden") return sendJson(res, 200, await toggleHidden(payload));
  if (req.method === "POST" && url.pathname === "/api/save-raw-file") { await saveTextFile(payload.kind, payload.content || ""); return sendJson(res, 200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/api/save-template") { await saveTemplateText(payload.name, payload.content || ""); return sendJson(res, 200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/api/upload-image") return sendJson(res, 200, await saveImage(payload));
  if (req.method === "POST" && url.pathname === "/api/start-preview") return sendJson(res, 200, await startPreview());
  if (req.method === "POST" && url.pathname === "/api/stop-preview") return sendJson(res, 200, await stopPreview());
  if (req.method === "POST" && url.pathname === "/api/build") return sendJson(res, 200, await buildSite());
  if (req.method === "POST" && url.pathname === "/api/shutdown") return sendJson(res, 200, await shutdownApp());
  if (req.method === "POST" && url.pathname === "/api/publish") {
    const result = await publish(payload.message);
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  return sendJson(res, 404, { error: "Not Found" });
}

function serveStatic(req, res, url) {
  const relativePath = url.pathname === "/" ? "index.html" : `.${url.pathname}`;
  const staticBaseDir = url.pathname.startsWith("/assets/") ? repoRoot : publicDir;
  const filePath = safeJoin(staticBaseDir, relativePath);
  createReadStream(filePath)
    .on("error", () => sendText(res, 404, "Not Found"))
    .once("open", () => {
      res.writeHead(200, { "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    })
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", APP_URL);
    if (url.pathname === "/favicon.ico") return sendText(res, 204, "");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    serveStatic(req, res, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    rememberLog("ERROR", message);
    sendJson(res, 500, { error: message });
  }
});

async function cleanupBeforeExit() {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  try {
    await stopPreview();
  } catch {}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    await cleanupBeforeExit();
    process.exit(0);
  });
}

function openBrowser(url) {
  spawn(`start "" "${url}"`, { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

let listenRetries = 0;
const MAX_LISTEN_RETRIES = 2;

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE" && listenRetries < MAX_LISTEN_RETRIES) {
    listenRetries++;
    console.log(`Port ${APP_PORT} in use, closing old process... (attempt ${listenRetries}/${MAX_LISTEN_RETRIES})`);
    await killPort(APP_PORT);
    await new Promise((r) => setTimeout(r, 1000));
    server.listen(APP_PORT, "127.0.0.1");
    return;
  }
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(APP_PORT, "127.0.0.1", async () => {
  await appendLog("APP", `블로그 편집기 시작: ${APP_URL}`);
  openBrowser(APP_URL);
  console.log(`Blog editor running: ${APP_URL}`);
});
