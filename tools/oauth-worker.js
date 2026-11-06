/*
 * Cloudflare Worker: GitHub OAuth Token Exchange Proxy
 *
 * 배포 방법:
 * 1. https://dash.cloudflare.com 에서 Workers & Pages > Create
 * 2. "Create Worker" 클릭 > 이름: jm-studio-auth
 * 3. 이 코드를 붙여넣기
 * 4. Settings > Variables에 환경변수 추가:
 *    - GH_CLIENT_ID = Ov23lixOBhnUUxH7VhoH
 *    - GH_CLIENT_SECRET = (GitHub에서 생성한 시크릿)
 *    - NOTIFY_SECRET = (GitHub Actions와 공유할 32바이트 이상의 랜덤 시크릿)
 *    - RESEND_API_KEY = (구독 확인 및 새 글 알림 발송용)
 *    - EMAIL_FROM = (Resend에서 검증된 발신자, 예: Jaemin Choi <blog@example.com>)
 * 5. Deploy 후 Worker URL을 jm-studio/index.html의 WORKER_URL에 입력
 *
 * 구독(Subscribe) 기능:
 * - Settings > Variables > KV Namespace Bindings에서:
 *   Variable name: SUBSCRIBERS
 *   KV Namespace: (새로 만들거나 기존 것 선택)
 * - POST /subscribe  { email: "..." }  → 확인 메일 발송 후 승인 대기
 * - GET  /confirm?token=... → 이메일 확인 및 구독 활성화
 * - GET  /subscribers → 구독자 목록 (GitHub 인증 필요)
 *
 * 같은 KV에 둔 것:
 * - GET/POST /likes  글의 '공감' 수. 방문자는 브라우저가 만든 임의 ID로 구분한다.
 * - GET/POST /memos  Studio 글감 메모함 (블로그 주인만, GitHub 토큰으로 확인)
 *
 * 예약 발행: wrangler.jsonc의 triggers.crons가 매시간 scheduled()를 부른다.
 * GH_DISPATCH_TOKEN(이 저장소 하나에 Actions 읽기/쓰기 권한만 준 fine-grained
 * 토큰)을 secret으로 넣으면 그때마다 Pages 워크플로의 예약 확인을 깨운다.
 */

const ALLOWED_ORIGINS = [
  'https://jmchoi4u.github.io',
  'http://127.0.0.1:4317',
  'http://localhost:4317',
];

const ALLOWED_REDIRECT_URIS = [
  'https://jmchoi4u.github.io/jm-studio/',
  'http://127.0.0.1:4317/jm-studio/',
  'http://localhost:4317/jm-studio/',
];

const OWNER_LOGIN = 'jmchoi4u';
const GOATCOUNTER_SITE = 'jmchoi4u';
const UNSUBSCRIBE_KEY_PREFIX = 'unsub:';
const CONFIRM_KEY_PREFIX = 'confirm:';
const RATE_KEY_PREFIX = 'rate:subscribe:';
const NOTIFIED_KEY_PREFIX = 'notified:';
const DELIVERED_KEY_PREFIX = 'delivered:';
const LIKE_KEY_PREFIX = 'likes:';
const LIKED_KEY_PREFIX = 'liked:';
const LIKE_RATE_PREFIX = 'rate:like:';
const MEMO_KEY = 'memos:owner';
const OWNER_TOKEN_PREFIX = 'owner-token:';
const MEMO_LIMIT = 300;
const MEMO_TEXT_LIMIT = 2000;
const VISITOR_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SITE_REPO = 'jmchoi4u.github.io';
const BLOG_NAME = "James Choi's Memo";
const MAIL_FONT = '-apple-system,BlinkMacSystemFont,Apple SD Gothic Neo,Malgun Gothic,Noto Sans KR,sans-serif';
/* Every KV key that is not a subscriber record starts with one of these. */
const NON_SUBSCRIBER_PREFIXES = [
  UNSUBSCRIBE_KEY_PREFIX,
  CONFIRM_KEY_PREFIX,
  'rate:',
  NOTIFIED_KEY_PREFIX,
  DELIVERED_KEY_PREFIX,
  LIKE_KEY_PREFIX,
  LIKED_KEY_PREFIX,
  MEMO_KEY,
  OWNER_TOKEN_PREFIX,
];
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

function isSubscriberKey(name) {
  return !NON_SUBSCRIBER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Notify-Secret',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function normalizeCounterPath(value) {
  let path = String(value || '').trim();
  if (path.toUpperCase() === 'TOTAL') return 'TOTAL';
  if (!path || path.length > 512 || path.charAt(0) !== '/') return '';

  try {
    path = decodeURIComponent(path);
  } catch (e) {
    return '';
  }
  if (/[\u0000-\u001f\u007f?#]/.test(path)) return '';

  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

function normalizeCounterRange(value, allowRelative) {
  const range = String(value || '').trim().toLowerCase();
  if (!range) return '';
  if (allowRelative && /^(week|month|year)$/.test(range)) return range;
  return /^\d{4}-\d{2}-\d{2}$/.test(range) ? range : '';
}

function sanitizeCounterValue(value) {
  const digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  return digits || '0';
}

async function proxyViewCounter(url, origin) {
  const counterPath = normalizeCounterPath(url.searchParams.get('path'));
  const rawStart = url.searchParams.get('start') || '';
  const rawEnd = url.searchParams.get('end') || '';
  const start = normalizeCounterRange(rawStart, true);
  const end = normalizeCounterRange(rawEnd, false);

  if (!counterPath || (rawStart && !start) || (rawEnd && !end)) {
    return jsonResponse({ error: 'invalid counter query' }, 400, origin);
  }

  const upstream = new URL(
    'https://' + GOATCOUNTER_SITE + '.goatcounter.com/counter/'
      + encodeURIComponent(counterPath) + '.json'
  );
  if (start) upstream.searchParams.set('start', start);
  if (end) upstream.searchParams.set('end', end);

  let response;
  try {
    response = await fetch(upstream.toString(), {
      headers: { 'Accept': 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 300 },
    });
  } catch (e) {
    return jsonResponse({ error: 'counter upstream unavailable' }, 502, origin);
  }

  const cacheHeaders = {
    'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (response.status === 404) {
    return jsonResponse({ count: '0', count_unique: '0' }, 404, origin, cacheHeaders);
  }
  if (!response.ok) {
    return jsonResponse({ error: 'counter upstream failed' }, 502, origin);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid counter response' }, 502, origin);
  }

  return jsonResponse({
    count: sanitizeCounterValue(payload && payload.count),
    count_unique: sanitizeCounterValue(payload && payload.count_unique),
  }, 200, origin, cacheHeaders);
}

function subscribersUnavailable(origin) {
  return jsonResponse({ error: 'subscriber storage unavailable' }, 503, origin);
}

function generateUnsubscribeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateOpaqueToken() {
  return generateUnsubscribeToken();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function secretsMatch(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !received || !expected) return false;
  const [left, right] = await Promise.all([sha256Hex(received), sha256Hex(expected)]);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function isValidUnsubscribeToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

async function ensureUnsubscribeToken(store, email, subscriber) {
  const previousToken = typeof subscriber.unsubscribeToken === 'string'
    ? subscriber.unsubscribeToken
    : '';
  const unsubscribeToken = isValidUnsubscribeToken(previousToken)
    ? previousToken
    : generateUnsubscribeToken();

  if (previousToken && previousToken !== unsubscribeToken) {
    await store.delete(UNSUBSCRIBE_KEY_PREFIX + previousToken);
  }

  const normalized = {
    ...subscriber,
    email,
    unsubscribeToken,
  };
  await store.put(email, JSON.stringify(normalized));
  await store.put(UNSUBSCRIBE_KEY_PREFIX + unsubscribeToken, email);
  return normalized;
}

async function listAllKeys(store) {
  const keys = [];
  let cursor;
  do {
    const page = await store.list(cursor ? { cursor } : {});
    keys.push(...(Array.isArray(page.keys) ? page.keys : []));
    cursor = page.list_complete === false && page.cursor ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/* The page an e-mail link opens: one card in the blog's sky palette. */
function noticePage(title, message, status = 200) {
  return new Response(
    '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escHtml(title) + '</title></head>'
    + '<body style="margin:0;padding:64px 20px;background:#F4F7FA;color:#1B1F24;text-align:center;font-family:' + MAIL_FONT + '">'
    + '<div style="max-width:420px;margin:0 auto;padding:32px 24px;border:1px solid #E6EAEF;border-radius:16px;background:#fff">'
    + '<p style="margin:0 0 6px;color:#2F5D8A;font-size:13px;font-weight:700">' + escHtml(BLOG_NAME) + '</p>'
    + '<h1 style="margin:0 0 10px;font-size:20px;letter-spacing:-0.02em">' + escHtml(title) + '</h1>'
    + '<p style="margin:0 0 22px;color:#5D6670;line-height:1.7">' + escHtml(message) + '</p>'
    + '<a href="https://jmchoi4u.github.io" style="display:inline-block;padding:11px 20px;border-radius:10px;background:#2F5D8A;color:#fff;text-decoration:none;font-weight:600">블로그로 돌아가기</a>'
    + '</div></body></html>',
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

function unsubscribePage(message, status = 200) {
  return noticePage('구독 취소', message, status);
}

function subscriptionPage(title, message, status = 200) {
  return noticePage(title, message, status);
}

/* ── 공감 ──
   A reader's press is remembered by a random ID their browser keeps, not by
   their address: many phones share one address. The address only limits how
   fast presses come in. */
function normalizeLikePath(value) {
  const path = normalizeCounterPath(value);
  return /^\/posts\/[^/]+$/.test(path) ? path : '';
}

async function likeState(store, path, visitor) {
  const visitorKey = LIKED_KEY_PREFIX + await sha256Hex(visitor + '\n' + path);
  const [count, liked] = await Promise.all([
    store.get(LIKE_KEY_PREFIX + path),
    VISITOR_PATTERN.test(visitor) ? store.get(visitorKey) : null,
  ]);
  return { count: Math.max(0, Number(count) || 0), liked: Boolean(liked), visitorKey };
}

async function handleLikes(request, store, url, origin) {
  if (request.method === 'GET') {
    const path = normalizeLikePath(url.searchParams.get('path'));
    if (!path) return jsonResponse({ error: 'invalid path' }, 400, origin);
    const { count, liked } = await likeState(store, path, url.searchParams.get('visitor') || '');
    return jsonResponse({ count, liked }, 200, origin);
  }

  let body = null;
  try { body = await request.json(); } catch (e) {}
  const path = normalizeLikePath(body && body.path);
  const visitor = body && typeof body.visitor === 'string' ? body.visitor : '';
  if (!path || !VISITOR_PATTERN.test(visitor) || typeof body.like !== 'boolean') {
    return jsonResponse({ error: 'invalid like' }, 400, origin);
  }

  const clientAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = LIKE_RATE_PREFIX + await sha256Hex(clientAddress);
  const recentPresses = Number(await store.get(rateKey) || 0);
  if (recentPresses >= 30) {
    return jsonResponse({ error: '잠시 후 다시 눌러 주세요.' }, 429, origin, { 'Retry-After': '600' });
  }
  await store.put(rateKey, String(recentPresses + 1), { expirationTtl: 600 });

  const state = await likeState(store, path, visitor);
  if (body.like === state.liked) return jsonResponse({ count: state.count, liked: state.liked }, 200, origin);
  const count = Math.max(0, state.count + (body.like ? 1 : -1));
  await store.put(LIKE_KEY_PREFIX + path, String(count));
  if (body.like) await store.put(state.visitorKey, '1', { expirationTtl: 365 * 24 * 60 * 60 });
  else await store.delete(state.visitorKey);
  return jsonResponse({ count, liked: body.like }, 200, origin);
}

/* ── Studio 글감 메모함 ──
   Private notes, so they live here rather than in the public repository.
   Only the blog's owner reads or changes them; a checked token is trusted
   for ten minutes so every memo does not cost a GitHub call. */
async function isOwnerToken(store, token) {
  if (!token) return false;
  const tokenKey = OWNER_TOKEN_PREFIX + await sha256Hex(token);
  if (await store.get(tokenKey)) return true;
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'jm-studio',
    },
  });
  if (!userRes.ok) return false;
  let user = null;
  try { user = await userRes.json(); } catch (e) {}
  if (!user || String(user.login || '').toLowerCase() !== OWNER_LOGIN) return false;
  await store.put(tokenKey, '1', { expirationTtl: 600 });
  return true;
}

async function readMemos(store) {
  try {
    const memos = JSON.parse(await store.get(MEMO_KEY) || '[]');
    return Array.isArray(memos) ? memos : [];
  } catch (e) {
    return [];
  }
}

/* One change at a time (add, update, delete), so a phone and a computer
   writing at once do not overwrite each other's list. An add may carry the
   ID the browser gave it while offline; adding it twice is harmless. */
async function handleMemos(request, store, origin) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!await isOwnerToken(store, token)) return jsonResponse({ error: 'unauthorized' }, 401, origin);
  const memos = await readMemos(store);
  if (request.method === 'GET') return jsonResponse({ memos }, 200, origin);

  let change = null;
  try { change = await request.json(); } catch (e) {}
  const action = change && change.action;
  const id = change && typeof change.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(change.id) ? change.id : '';
  const text = change && typeof change.text === 'string' ? change.text.trim().slice(0, MEMO_TEXT_LIMIT) : '';
  const now = new Date().toISOString();
  let next;
  if (action === 'add') {
    if (!text) return jsonResponse({ error: 'empty memo' }, 400, origin);
    if (id && memos.some((memo) => memo.id === id)) return jsonResponse({ memos }, 200, origin);
    if (memos.length >= MEMO_LIMIT) {
      return jsonResponse({ error: '메모가 너무 많아요. 오래된 메모를 지워 주세요.' }, 400, origin);
    }
    next = [{ id: id || generateOpaqueToken().slice(0, 16), text, createdAt: now }, ...memos];
  } else if (action === 'update') {
    if (!id || !text) return jsonResponse({ error: 'invalid memo' }, 400, origin);
    next = memos.map((memo) => (memo.id === id ? { ...memo, text, updatedAt: now } : memo));
  } else if (action === 'delete') {
    if (!id) return jsonResponse({ error: 'invalid memo' }, 400, origin);
    next = memos.filter((memo) => memo.id !== id);
  } else {
    return jsonResponse({ error: 'unknown action' }, 400, origin);
  }
  await store.put(MEMO_KEY, JSON.stringify(next));
  return jsonResponse({ memos: next }, 200, origin);
}

/* ── 예약 발행 ──
   Cloudflare's clock runs on time; GitHub's scheduled runs are often late or
   skipped. Without GH_DISPATCH_TOKEN this does nothing and the workflow's
   own schedule is all there is. */
async function dispatchDueCheck(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const response = await fetch(
    'https://api.github.com/repos/' + OWNER_LOGIN + '/' + SITE_REPO + '/actions/workflows/pages-deploy.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.GH_DISPATCH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jm-studio',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { due_check: 'true' } }),
    }
  );
  if (!response.ok) console.log('due check dispatch failed: ' + response.status);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchDueCheck(env));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    /* 이메일 링크는 브라우저 탐색 요청이라 Origin 헤더가 없을 수 있다. */
    if (request.method === 'GET' && path === '/unsub') {
      if (!env.SUBSCRIBERS) {
        return unsubscribePage('구독 저장소가 준비되지 않아 지금은 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503);
      }

      const unsubscribeToken = url.searchParams.get('token') || '';
      if (!isValidUnsubscribeToken(unsubscribeToken)) {
        return unsubscribePage('유효하지 않거나 이미 처리된 구독 취소 링크입니다.');
      }

      try {
        const mappingKey = UNSUBSCRIBE_KEY_PREFIX + unsubscribeToken;
        const email = await env.SUBSCRIBERS.get(mappingKey);
        if (email) {
          const normalizedEmail = email.toLowerCase().trim();
          const rawSubscriber = await env.SUBSCRIBERS.get(normalizedEmail);
          let subscriber = null;
          try { subscriber = rawSubscriber ? JSON.parse(rawSubscriber) : null; } catch (e) {}

          if (subscriber && subscriber.unsubscribeToken === unsubscribeToken) {
            await env.SUBSCRIBERS.delete(normalizedEmail);
          }
          await env.SUBSCRIBERS.delete(mappingKey);
        }
        return unsubscribePage('구독 취소가 처리되었습니다. 더 이상 새 글 알림을 받지 않습니다.');
      } catch (e) {
        return unsubscribePage('구독 취소 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', 500);
      }
    }

    if (request.method === 'GET' && path === '/confirm') {
      if (!env.SUBSCRIBERS) {
        return subscriptionPage('구독 확인', '구독 저장소가 준비되지 않아 지금은 처리할 수 없습니다.', 503);
      }

      const confirmationToken = url.searchParams.get('token') || '';
      if (!isValidUnsubscribeToken(confirmationToken)) {
        return subscriptionPage('구독 확인', '유효하지 않거나 만료된 확인 링크입니다.', 400);
      }

      try {
        const mappingKey = CONFIRM_KEY_PREFIX + confirmationToken;
        const email = await env.SUBSCRIBERS.get(mappingKey);
        if (!email) return subscriptionPage('구독 확인', '유효하지 않거나 만료된 확인 링크입니다.', 400);

        const normalizedEmail = email.toLowerCase().trim();
        const rawSubscriber = await env.SUBSCRIBERS.get(normalizedEmail);
        let subscriber = null;
        try { subscriber = rawSubscriber ? JSON.parse(rawSubscriber) : null; } catch (e) {}
        if (!subscriber || subscriber.confirmationToken !== confirmationToken) {
          await env.SUBSCRIBERS.delete(mappingKey);
          return subscriptionPage('구독 확인', '유효하지 않거나 만료된 확인 링크입니다.', 400);
        }

        delete subscriber.confirmationToken;
        subscriber.active = true;
        subscriber.confirmedAt = new Date().toISOString();
        await ensureUnsubscribeToken(env.SUBSCRIBERS, normalizedEmail, subscriber);
        await env.SUBSCRIBERS.delete(mappingKey);
        return subscriptionPage('구독 완료', '이메일 확인이 완료되었습니다. 이제 새 글 알림을 받을 수 있습니다.');
      } catch (e) {
        return subscriptionPage('구독 확인', '구독 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', 500);
      }
    }

    /* preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    /* origin check */
    const isServerNotify = request.method === 'POST' && path === '/notify';
    if (!isAllowedOrigin(origin) && !isServerNotify) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET' && path === '/views') {
      return proxyViewCounter(url, origin);
    }

    if (path === '/likes' && (request.method === 'GET' || request.method === 'POST')) {
      if (!env.SUBSCRIBERS) return subscribersUnavailable(origin);
      return handleLikes(request, env.SUBSCRIBERS, url, origin);
    }

    if (path === '/memos' && (request.method === 'GET' || request.method === 'POST')) {
      if (!env.SUBSCRIBERS) return subscribersUnavailable(origin);
      return handleMemos(request, env.SUBSCRIBERS, origin);
    }

    if (request.method === 'GET' && path === '/capabilities') {
      return new Response(JSON.stringify({ pkce: true, oauth_scope: 'public_repo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }

    /* ── POST /token : GitHub OAuth 토큰 교환 ── */
    if (request.method === 'POST' && path === '/token') {
      try {
        const { code, code_verifier: codeVerifier, redirect_uri: redirectUri } = await request.json();
        if (typeof code !== 'string' || !code.trim()) {
          return jsonResponse({ error: 'missing code' }, 400, origin);
        }
        if (!ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
          return jsonResponse({ error: 'invalid redirect_uri' }, 400, origin);
        }
        if (typeof codeVerifier !== 'string' || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
          return jsonResponse({ error: 'invalid code_verifier' }, 400, origin);
        }
        if (!env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET) {
          return jsonResponse({ error: 'oauth service unavailable' }, 503, origin);
        }

        const tokenRequest = {
          client_id: env.GH_CLIENT_ID,
          client_secret: env.GH_CLIENT_SECRET,
          code: code.trim(),
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        };

        const ghRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(tokenRequest),
        });

        let data;
        try {
          data = await ghRes.json();
        } catch (e) {
          return jsonResponse({ error: 'invalid response from GitHub' }, 502, origin);
        }

        if (!ghRes.ok || data.error) {
          return jsonResponse(
            { error: data.error_description || data.error || 'GitHub token exchange failed' },
            ghRes.status >= 400 && ghRes.status < 500 ? 400 : 502,
            origin
          );
        }
        if (typeof data.access_token !== 'string' || !data.access_token) {
          return jsonResponse({ error: 'GitHub did not return an access token' }, 502, origin);
        }

        const grantedScopes = String(data.scope || '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
        if (grantedScopes.length !== 1 || grantedScopes[0] !== 'public_repo') {
          return jsonResponse({
            error: 'GitHub 권한이 public_repo와 일치하지 않습니다. GitHub 앱 권한을 취소한 뒤 다시 연결해 주세요.',
          }, 403, origin);
        }

        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': 'Bearer ' + data.access_token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'jm-studio',
          },
        });
        if (!userRes.ok) {
          return jsonResponse({ error: 'GitHub account verification failed' }, 502, origin);
        }

        let user;
        try {
          user = await userRes.json();
        } catch (e) {
          return jsonResponse({ error: 'invalid GitHub user response' }, 502, origin);
        }
        if (!user || user.login !== OWNER_LOGIN) {
          return jsonResponse({ error: 'forbidden' }, 403, origin);
        }

        return jsonResponse({ access_token: data.access_token, scope: data.scope }, 200, origin);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, origin);
      }
    }

    /* ── POST /subscribe : 이메일 구독 등록 ── */
    if (request.method === 'POST' && path === '/subscribe') {
      if (!env.SUBSCRIBERS) return subscribersUnavailable(origin);
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return jsonResponse({ error: 'subscription email unavailable' }, 503, origin);

      try {
        const { email } = await request.json();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return new Response(JSON.stringify({ error: 'invalid email' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const clientAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = RATE_KEY_PREFIX + await sha256Hex(clientAddress);
        const recentAttempts = Number(await env.SUBSCRIBERS.get(rateKey) || 0);
        if (recentAttempts >= 3) {
          return jsonResponse({ error: '잠시 후 다시 시도해 주세요.' }, 429, origin, { 'Retry-After': '600' });
        }
        await env.SUBSCRIBERS.put(rateKey, String(recentAttempts + 1), { expirationTtl: 600 });

        const existing = await env.SUBSCRIBERS.get(normalizedEmail);
        let subscriber = null;
        try { subscriber = existing ? JSON.parse(existing) : null; } catch (e) {}
        if (subscriber && subscriber.active === true) {
          return jsonResponse({ ok: true, active: true }, 200, origin);
        }

        if (subscriber && isValidUnsubscribeToken(subscriber.confirmationToken)) {
          await env.SUBSCRIBERS.delete(CONFIRM_KEY_PREFIX + subscriber.confirmationToken);
        }
        const confirmationToken = generateOpaqueToken();
        subscriber = {
          ...(subscriber || {}),
          email: normalizedEmail,
          subscribedAt: subscriber && subscriber.subscribedAt
            ? subscriber.subscribedAt
            : new Date().toISOString(),
          active: false,
          confirmationToken,
        };
        await env.SUBSCRIBERS.put(normalizedEmail, JSON.stringify(subscriber));
        await env.SUBSCRIBERS.put(CONFIRM_KEY_PREFIX + confirmationToken, normalizedEmail, { expirationTtl: 86400 });

        const confirmLink = new URL(request.url).origin + '/confirm?token=' + encodeURIComponent(confirmationToken);
        const confirmationResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [normalizedEmail],
            reply_to: 'jmchoi4u@gmail.com',
            subject: '새 글 알림 구독 확인',
            html: '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>'
              + '<body style="margin:0;padding:32px 16px;background:#F4F7FA;color:#1B1F24;font-family:' + MAIL_FONT + '">'
              + '<div style="max-width:520px;margin:0 auto;padding:32px 28px;border:1px solid #E6EAEF;border-radius:16px;background:#fff">'
              + '<p style="margin:0 0 8px;color:#2F5D8A;font-size:13px;font-weight:700">' + escHtml(BLOG_NAME) + '</p>'
              + '<h1 style="margin:0 0 12px;font-size:22px;line-height:1.4;letter-spacing:-0.02em">새 글 알림을 확인해 주세요</h1>'
              + '<p style="margin:0 0 24px;color:#5D6670;font-size:15px;line-height:1.7">아래 버튼을 눌러야 구독이 시작돼요. 신청하지 않았다면 이 메일은 무시해 주세요.</p>'
              + '<a href="' + escHtml(confirmLink) + '" style="display:inline-block;padding:13px 24px;border-radius:10px;background:#2F5D8A;color:#fff;text-decoration:none;font-weight:600;font-size:15px">구독 확인</a>'
              + '<p style="margin:24px 0 0;color:#8C95A0;font-size:12px">이 링크는 24시간 동안 쓸 수 있어요.</p>'
              + '</div></body></html>',
          }),
        });
        if (!confirmationResponse.ok) {
          await env.SUBSCRIBERS.delete(normalizedEmail);
          await env.SUBSCRIBERS.delete(CONFIRM_KEY_PREFIX + confirmationToken);
          return jsonResponse({ error: 'confirmation email failed' }, 502, origin);
        }

        return jsonResponse({ ok: true, pending: true }, 200, origin);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500, origin);
      }
    }

    /* ── GET /subscribers : 구독자 목록 (관리자용, GitHub 인증 필요) ── */
    if (request.method === 'GET' && path === '/subscribers') {
      if (!env.SUBSCRIBERS) return subscribersUnavailable(origin);

      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');

      if (!token) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      /* GitHub API로 사용자 확인 */
      const userRes = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'jm-studio' },
      });
      if (!userRes.ok) {
        return new Response(JSON.stringify({ error: 'invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
      const user = await userRes.json();
      if (!user.login || user.login.toLowerCase() !== OWNER_LOGIN) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      /* KV에서 구독자 목록 조회 */
      const list = [];
      const keys = await listAllKeys(env.SUBSCRIBERS);
      for (const key of keys) {
        if (!isSubscriberKey(key.name)) continue;
        const val = await env.SUBSCRIBERS.get(key.name);
        if (val) {
          try {
            const subscriber = JSON.parse(val);
            if (!subscriber.email) continue;
            const { unsubscribeToken, ...safeSubscriber } = subscriber;
            list.push(safeSubscriber);
          } catch (e) {}
        }
      }

      return new Response(JSON.stringify({ subscribers: list, count: list.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    /* ── POST /notify : 새 글 알림 발송 (GitHub Actions에서 호출) ── */
    if (request.method === 'POST' && path === '/notify') {
      if (!env.SUBSCRIBERS) return subscribersUnavailable(origin);

      try {
        const notifySecret = request.headers.get('X-Notify-Secret') || '';
        if (!env.NOTIFY_SECRET) return jsonResponse({ error: 'notification service unavailable' }, 503, origin);
        if (!await secretsMatch(notifySecret, env.NOTIFY_SECRET)) {
          return jsonResponse({ error: 'unauthorized' }, 401, origin);
        }

        const { title, url: postUrl, description } = await request.json();
        if (typeof title !== 'string' || !title.trim() || typeof postUrl !== 'string') {
          return jsonResponse({ error: 'missing title or url' }, 400, origin);
        }
        let normalizedPostUrl;
        try {
          const parsedPostUrl = new URL(postUrl);
          if (parsedPostUrl.origin !== 'https://jmchoi4u.github.io') throw new Error('invalid origin');
          normalizedPostUrl = parsedPostUrl.href;
        } catch (e) {
          return jsonResponse({ error: 'invalid post url' }, 400, origin);
        }

        const notificationKey = NOTIFIED_KEY_PREFIX + await sha256Hex(normalizedPostUrl);
        if (await env.SUBSCRIBERS.get(notificationKey)) {
          return jsonResponse({ ok: true, sent: 0, duplicate: true }, 200, origin);
        }

        if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
          return new Response(JSON.stringify({ error: 'not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const keys = await listAllKeys(env.SUBSCRIBERS);
        const subscribers = [];
        for (const key of keys) {
          if (!isSubscriberKey(key.name)) continue;
          const val = await env.SUBSCRIBERS.get(key.name);
          if (val) {
            let subscriber;
            try { subscriber = JSON.parse(val); } catch (e) { continue; }
            const normalizedEmail = String(subscriber.email || key.name).toLowerCase().trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) continue;
            subscriber = await ensureUnsubscribeToken(env.SUBSCRIBERS, normalizedEmail, subscriber);
            if (key.name !== normalizedEmail) await env.SUBSCRIBERS.delete(key.name);
            if (subscriber.active === true) subscribers.push({
              email: normalizedEmail,
              unsubscribeToken: subscriber.unsubscribeToken,
            });
          }
        }

        if (subscribers.length === 0) {
          await env.SUBSCRIBERS.put(notificationKey, JSON.stringify({ url: normalizedPostUrl, notifiedAt: new Date().toISOString() }));
          return jsonResponse({ ok: true, sent: 0 }, 200, origin);
        }

        const workerUrl = new URL(request.url).origin;
        let sent = 0;
        let failed = 0;
        let alreadySent = 0;

        for (const subscriber of subscribers) {
          const email = subscriber.email;
          const deliveryKey = DELIVERED_KEY_PREFIX + await sha256Hex(normalizedPostUrl + '\n' + email);
          if (await env.SUBSCRIBERS.get(deliveryKey)) {
            alreadySent++;
            continue;
          }
          const unsubLink = workerUrl + '/unsub?token=' + encodeURIComponent(subscriber.unsubscribeToken);
          const htmlBody = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>'
            + '<body style="margin:0;padding:0;background:#F4F7FA;font-family:' + MAIL_FONT + '">'
            + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FA;padding:32px 16px"><tr><td align="center">'
            + '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">'

            + '<tr><td style="padding:0 4px 14px;text-align:left">'
            + '<span style="font-size:15px;font-weight:700;color:#1B1F24;letter-spacing:-0.02em">' + escHtml(BLOG_NAME) + '</span>'
            + '<span style="margin-left:8px;font-size:13px;color:#5D6670">새 글 알림</span>'
            + '</td></tr>'

            + '<tr><td style="padding:32px 28px;border:1px solid #E6EAEF;border-radius:16px;background:#ffffff">'
            + '<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#2F5D8A">새 글</p>'
            + '<h1 style="margin:0 0 14px;font-size:22px;font-weight:700;color:#1B1F24;line-height:1.4;letter-spacing:-0.02em">' + escHtml(title) + '</h1>'
            + (description ? '<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#5D6670">' + escHtml(description) + '</p>' : '<div style="height:10px"></div>')
            + '<a href="' + escHtml(normalizedPostUrl) + '" style="display:inline-block;padding:13px 26px;border-radius:10px;background:#2F5D8A;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">글 읽으러 가기</a>'
            + '</td></tr>'

            + '<tr><td style="padding:20px 0 6px;text-align:center">'
            + '<a href="https://ctee.kr/place/jmchoi4u" style="display:inline-block;padding:8px 16px;border:1px solid #E6EAEF;border-radius:999px;background:#ffffff;color:#5D6670;text-decoration:none;font-size:12px">&#9749; 커피 한 잔 후원하기</a>'
            + '</td></tr>'

            + '<tr><td style="padding:12px 0 8px;text-align:center">'
            + '<p style="margin:0 0 6px;font-size:12px;color:#8C95A0">구독을 신청해서 받는 메일이에요.</p>'
            + '<a href="' + unsubLink + '" style="font-size:12px;color:#8C95A0;text-decoration:underline">구독 취소</a>'
            + '</td></tr>'

            + '</table></td></tr></table></body></html>';

          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.RESEND_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: env.EMAIL_FROM,
              to: [email],
              reply_to: 'jmchoi4u@gmail.com',
              subject: '새 글: ' + title,
              html: htmlBody,
            }),
          });

          if (res.ok) {
            sent++;
            await env.SUBSCRIBERS.put(deliveryKey, JSON.stringify({ url: normalizedPostUrl, email, deliveredAt: new Date().toISOString() }));
          } else failed++;
        }

        if (failed > 0) {
          return jsonResponse({ error: 'email delivery failed', sent, alreadySent, failed, total: subscribers.length }, 502, origin);
        }

        await env.SUBSCRIBERS.put(notificationKey, JSON.stringify({ url: normalizedPostUrl, notifiedAt: new Date().toISOString() }));
        return jsonResponse({ ok: true, sent, alreadySent, total: subscribers.length }, 200, origin);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    /* ── 404 ── */
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  },
};

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
