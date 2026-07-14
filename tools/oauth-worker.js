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
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

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

function unsubscribePage(message, status = 200) {
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>구독 취소</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px">'
    + '<h2>구독 취소</h2>'
    + '<p style="color:#666">' + escHtml(message) + '</p>'
    + '<a href="https://jmchoi4u.github.io" style="color:#2d7a5a">블로그로 돌아가기</a>'
    + '</body></html>',
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

function subscriptionPage(title, message, status = 200) {
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escHtml(title) + '</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px">'
    + '<h2>' + escHtml(title) + '</h2>'
    + '<p style="color:#666">' + escHtml(message) + '</p>'
    + '<a href="https://jmchoi4u.github.io" style="color:#2d7a5a">블로그로 돌아가기</a>'
    + '</body></html>',
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

export default {
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
            html: '<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans KR,sans-serif;padding:32px;color:#252525">'
              + '<h2>새 글 알림을 확인해 주세요</h2>'
              + '<p style="line-height:1.7;color:#666">아래 버튼을 눌러야 구독이 시작됩니다. 요청하지 않았다면 이 메일을 무시해 주세요.</p>'
              + '<p><a href="' + escHtml(confirmLink) + '" style="display:inline-block;padding:12px 22px;background:#2d7a5a;color:#fff;text-decoration:none;border-radius:10px">구독 확인</a></p>'
              + '<p style="font-size:12px;color:#999">이 링크는 24시간 동안 유효합니다.</p>'
              + '</body></html>',
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
        if (key.name.startsWith(UNSUBSCRIBE_KEY_PREFIX)
          || key.name.startsWith(CONFIRM_KEY_PREFIX)
          || key.name.startsWith(RATE_KEY_PREFIX)
          || key.name.startsWith(NOTIFIED_KEY_PREFIX)
          || key.name.startsWith(DELIVERED_KEY_PREFIX)) continue;
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
          if (key.name.startsWith(UNSUBSCRIBE_KEY_PREFIX)
            || key.name.startsWith(CONFIRM_KEY_PREFIX)
            || key.name.startsWith(RATE_KEY_PREFIX)
            || key.name.startsWith(NOTIFIED_KEY_PREFIX)
            || key.name.startsWith(DELIVERED_KEY_PREFIX)) continue;
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
          const htmlBody = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
            + '<body style="margin:0;padding:0;background:#f4f2ef;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans KR,sans-serif">'
            + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ef;padding:32px 16px"><tr><td align="center">'
            + '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">'

            + '<tr><td style="padding:24px 0;text-align:center">'
            + '<span style="font-size:1.1rem;font-weight:700;color:#252525;letter-spacing:-0.02em">Jaemin Choi</span>'
            + '<span style="color:#bbb;margin:0 8px">|</span>'
            + '<span style="font-size:0.82rem;color:#888">블로그 새 글 알림</span>'
            + '</td></tr>'

            + '<tr><td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">'
            + '<table width="100%" cellpadding="0" cellspacing="0">'

            + '<tr><td style="background:linear-gradient(135deg,#8B9DC3 0%,#6B83A8 40%,#4A6B8A 100%);padding:40px 32px;text-align:center">'
            + '<p style="margin:0 0 4px;font-size:0.78rem;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.1em">New Post</p>'
            + '<h1 style="margin:0;font-size:1.5rem;font-weight:700;color:#fff;line-height:1.35;letter-spacing:-0.02em">' + escHtml(title) + '</h1>'
            + '</td></tr>'

            + '<tr><td style="padding:28px 32px 32px">'
            + (description ? '<p style="margin:0 0 24px;font-size:0.95rem;line-height:1.7;color:#555">' + escHtml(description) + '</p>' : '')
            + '<table cellpadding="0" cellspacing="0" width="100%"><tr>'
            + '<td><a href="' + escHtml(normalizedPostUrl) + '" style="display:inline-block;padding:13px 32px;background:#2d7a5a;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:0.9rem">글 읽으러 가기 &rarr;</a></td>'
            + '</tr></table>'
            + '</td></tr>'

            + '</table></td></tr>'

            + '<tr><td style="padding:20px 0;text-align:center">'
            + '<a href="https://ctee.kr/place/jmchoi4u" style="display:inline-block;padding:8px 18px;background:#FFDD00;color:#000;text-decoration:none;border-radius:999px;font-size:0.78rem;font-weight:600">&#9749; 커피 한 잔 후원하기</a>'
            + '</td></tr>'

            + '<tr><td style="padding:8px 0 24px;text-align:center">'
            + '<p style="margin:0 0 6px;font-size:0.72rem;color:#aaa">이 메일은 구독 신청에 의해 발송되었습니다.</p>'
            + '<a href="' + unsubLink + '" style="font-size:0.72rem;color:#aaa;text-decoration:underline">구독 취소</a>'
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
