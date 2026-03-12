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

const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const logsDir = path.join(__dirname, "logs");
const logFile = path.join(logsDir, "editor.log");
const postsDir = path.join(repoRoot, "_posts");
const draftsDir = path.join(repoRoot, "_drafts");
const templatesDir = path.join(repoRoot, "src", "templates");
const assetsDir = path.join(repoRoot, "assets", "img");

const rawFiles = {
  config: path.join(repoRoot, "_config.yml"),
  contact: path.join(repoRoot, "_data", "contact.yml"),
  about: path.join(repoRoot, "_tabs", "about.md")
};

const state = {
  previewProcess: null,
  previewLogs: [],
  appLogs: []
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
await fs.mkdir(draftsDir, { recursive: true });

function stamp() {
  return new Date().toLocaleString("ko-KR");
}

async function appendLog(scope, message) {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  await fs.appendFile(logFile, line, "utf8");
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

function parseDoc(text, fileName = "") {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fileName, title: "", date: "", categories: [], tags: [], description: "", extra: "", body: normalized, draft: false };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { fileName, title: "", date: "", categories: [], tags: [], description: "", extra: "", body: normalized, draft: false };
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
  const extra = head
    .split("\n")
    .filter((line) => !/^(title|date|categories|tags|description|toc|comments|pin|mermaid|math):/.test(line.trim()))
    .join("\n")
    .trim();
  return {
    fileName,
    title: pick(/^title:\s*(.+)$/m),
    date: pick(/^date:\s*(.+)$/m),
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

function makeDoc(data) {
  const lines = [
    "---",
    `title: ${yamlString(data.title || "제목 없음")}`,
    `date: ${data.date}`
  ];
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
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "new-post";
}

async function run(command, cwd = repoRoot) {
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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
  for (const [dir, draft] of [[postsDir, false], [draftsDir, true]]) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const full = path.join(dir, entry.name);
      const raw = await fs.readFile(full, "utf8");
      const parsed = parseDoc(raw, entry.name);
      result.push({
        fileName: entry.name,
        relativePath: path.relative(repoRoot, full).replace(/\\/g, "/"),
        title: parsed.title || entry.name.replace(/\.md$/i, ""),
        date: parsed.date,
        draft
      });
    }
  }
  return result.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
}

async function listTemplates() {
  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  return entries.filter((x) => x.isFile() && x.name.endsWith(".md")).map((x) => x.name).sort();
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

async function savePost(data) {
  const draft = Boolean(data.draft);
  const date = String(data.date || "").trim() || `${new Date().toISOString().slice(0, 16).replace("T", " ")}:00 +0900`;
  const slug = slugify(data.slug || data.title);
  const fileName = draft ? `${slug}.md` : `${date.slice(0, 10)}-${slug}.md`;
  const target = path.join(draft ? draftsDir : postsDir, fileName);
  const categories = (data.categories || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2);
  const tags = (data.tags || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  await fs.writeFile(target, makeDoc({
    title: data.title,
    date,
    categories,
    tags,
    description: data.description,
    toc: data.toc !== false,
    comments: data.comments !== false,
    pin: Boolean(data.pin),
    mermaid: Boolean(data.mermaid),
    math: Boolean(data.math),
    extra: data.extra,
    body: data.body
  }), "utf8");
  if (data.originalRelativePath) {
    const oldPath = safeJoin(repoRoot, data.originalRelativePath);
    if (oldPath !== target) {
      try { await fs.unlink(oldPath); } catch {}
    }
  }
  rememberLog("POST", `${fileName} 저장 완료`);
  return { ok: true, relativePath: path.relative(repoRoot, target).replace(/\\/g, "/"), fileName };
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

async function killPreviewPort() {
  await run(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PREVIEW_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`);
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
    env: process.env
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

async function buildSite() {
  rememberLog("BUILD", "정적 빌드 실행");
  return await run("bundle exec jekyll b");
}

async function publish(message) {
  const commitMessage = String(message || "").trim() || `blog update ${new Date().toISOString()}`;
  const add = await run("git add -A");
  if (add.code !== 0) return { ok: false, step: "add", ...add };
  const commit = await run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
  const nothing = `${commit.stdout}\n${commit.stderr}`.includes("nothing to commit");
  if (commit.code !== 0 && !nothing) return { ok: false, step: "commit", ...commit };
  if (nothing) return { ok: true, step: "noop", ...commit };
  const push = await run("git push");
  if (push.code !== 0) return { ok: false, step: "push", ...push };
  rememberLog("PUBLISH", "git push 완료");
  return { ok: true, step: "push", stdout: `${commit.stdout}\n${push.stdout}`.trim(), stderr: `${commit.stderr}\n${push.stderr}`.trim() };
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

  const payload = JSON.parse((await readBody(req)) || "{}");
  if (req.method === "POST" && url.pathname === "/api/save-post") return sendJson(res, 200, await savePost(payload));
  if (req.method === "POST" && url.pathname === "/api/save-raw-file") { await saveTextFile(payload.kind, payload.content || ""); return sendJson(res, 200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/api/save-template") { await saveTemplateText(payload.name, payload.content || ""); return sendJson(res, 200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/api/upload-image") return sendJson(res, 200, await saveImage(payload));
  if (req.method === "POST" && url.pathname === "/api/start-preview") return sendJson(res, 200, await startPreview());
  if (req.method === "POST" && url.pathname === "/api/stop-preview") return sendJson(res, 200, await stopPreview());
  if (req.method === "POST" && url.pathname === "/api/build") return sendJson(res, 200, await buildSite());
  if (req.method === "POST" && url.pathname === "/api/publish") {
    const result = await publish(payload.message);
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  return sendJson(res, 404, { error: "Not Found" });
}

function serveStatic(req, res, url) {
  const relativePath = url.pathname === "/" ? "index.html" : `.${url.pathname}`;
  const filePath = safeJoin(publicDir, relativePath);
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

function openBrowser(url) {
  spawn(`start "" "${url}"`, { shell: true, detached: true, stdio: "ignore" }).unref();
}

server.listen(APP_PORT, "127.0.0.1", async () => {
  await appendLog("APP", `블로그 편집기 시작: ${APP_URL}`);
  openBrowser(APP_URL);
  console.log(`블로그 편집기 실행 중: ${APP_URL}`);
});
