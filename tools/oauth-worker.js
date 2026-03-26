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
 */

const ALLOWED_ORIGIN = 'https://jmchoi4u.github.io';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    if (origin !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    /* only POST /token */
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/token') {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    try {
      const { code } = await request.json();
      if (!code) throw new Error('missing code');

      /* exchange code for access token */
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
  },
};
