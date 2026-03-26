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
 * 5. Deploy 후 Worker URL을 jm-studio/index.html의 WORKER_URL에 입력
 *
 * 구독(Subscribe) 기능:
 * - Settings > Variables > KV Namespace Bindings에서:
 *   Variable name: SUBSCRIBERS
 *   KV Namespace: (새로 만들거나 기존 것 선택)
 * - POST /subscribe  { email: "..." }  → KV에 이메일 저장
 * - GET  /subscribers → 구독자 목록 (GitHub 인증 필요)
 */

const ALLOWED_ORIGINS = [
  'https://jmchoi4u.github.io',
  'http://127.0.0.1:4317',
];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    /* preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    /* origin check */
    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    /* ── POST /token : GitHub OAuth 토큰 교환 ── */
    if (request.method === 'POST' && path === '/token') {
      try {
        const { code } = await request.json();
        if (!code) throw new Error('missing code');

        const ghRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: env.GH_CLIENT_ID,
            client_secret: env.GH_CLIENT_SECRET,
            code,
          }),
        });

        const data = await ghRes.json();

        if (data.error) {
          return new Response(JSON.stringify({ error: data.error_description || data.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        return new Response(JSON.stringify({ access_token: data.access_token }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    /* ── POST /subscribe : 이메일 구독 등록 ── */
    if (request.method === 'POST' && path === '/subscribe') {
      try {
        const { email } = await request.json();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return new Response(JSON.stringify({ error: 'invalid email' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const normalizedEmail = email.toLowerCase().trim();

        if (env.SUBSCRIBERS) {
          const existing = await env.SUBSCRIBERS.get(normalizedEmail);
          if (!existing) {
            await env.SUBSCRIBERS.put(normalizedEmail, JSON.stringify({
              email: normalizedEmail,
              subscribedAt: new Date().toISOString(),
              active: true,
            }));
          }
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    /* ── POST /unsubscribe : 구독 해지 ── */
    if (request.method === 'POST' && path === '/unsubscribe') {
      try {
        const { email } = await request.json();
        if (!email) throw new Error('missing email');
        const normalizedEmail = email.toLowerCase().trim();

        if (env.SUBSCRIBERS) {
          await env.SUBSCRIBERS.delete(normalizedEmail);
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    /* ── GET /subscribers : 구독자 목록 (관리자용, GitHub 인증 필요) ── */
    if (request.method === 'GET' && path === '/subscribers') {
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
      if (user.login.toLowerCase() !== 'jmchoi4u') {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      /* KV에서 구독자 목록 조회 */
      const list = [];
      if (env.SUBSCRIBERS) {
        const keys = await env.SUBSCRIBERS.list();
        for (const key of keys.keys) {
          const val = await env.SUBSCRIBERS.get(key.name);
          if (val) list.push(JSON.parse(val));
        }
      }

      return new Response(JSON.stringify({ subscribers: list, count: list.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    /* ── POST /notify : 새 글 알림 발송 (GitHub Actions에서 호출) ── */
    if (request.method === 'POST' && path === '/notify') {
      try {
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace('Bearer ', '');
        if (!token) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

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
        if (user.login.toLowerCase() !== 'jmchoi4u') {
          return new Response(JSON.stringify({ error: 'forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const { title, url: postUrl, description } = await request.json();
        if (!title || !postUrl) throw new Error('missing title or url');

        if (!env.SUBSCRIBERS || !env.RESEND_API_KEY) {
          return new Response(JSON.stringify({ error: 'not configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const keys = await env.SUBSCRIBERS.list();
        const emails = [];
        for (const key of keys.keys) {
          const val = await env.SUBSCRIBERS.get(key.name);
          if (val) {
            const sub = JSON.parse(val);
            if (sub.active !== false) emails.push(sub.email);
          }
        }

        if (emails.length === 0) {
          return new Response(JSON.stringify({ ok: true, sent: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
          });
        }

        const workerUrl = new URL(request.url).origin;
        let sent = 0;

        for (const email of emails) {
          const unsubLink = workerUrl + '/unsub?email=' + encodeURIComponent(email);
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
            + '<td><a href="' + escHtml(postUrl) + '" style="display:inline-block;padding:13px 32px;background:#2d7a5a;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:0.9rem">글 읽으러 가기 &rarr;</a></td>'
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
              from: 'Jaemin Choi <onboarding@resend.dev>',
              to: [email],
              reply_to: 'jmchoi4u@gmail.com',
              subject: '새 글: ' + title,
              html: htmlBody,
            }),
          });

          if (res.ok) sent++;
        }

        return new Response(JSON.stringify({ ok: true, sent, total: emails.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    /* ── GET /unsub : 이메일 구독 취소 (이메일 링크용) ── */
    if (request.method === 'GET' && path === '/unsub') {
      const email = new URL(request.url).searchParams.get('email');
      if (email && env.SUBSCRIBERS) {
        await env.SUBSCRIBERS.delete(email.toLowerCase().trim());
      }
      return new Response(
        '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px">'
        + '<h2>구독이 취소되었습니다</h2>'
        + '<p style="color:#666">더 이상 새 글 알림을 받지 않습니다.</p>'
        + '<a href="https://jmchoi4u.github.io" style="color:#2d7a5a">블로그로 돌아가기</a>'
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
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
