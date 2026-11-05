import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const same = (left, right) => { const a = Buffer.from(String(left ?? '')); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
const page = (body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>交互式浏览器合成演示</title><style>body{font:16px system-ui;max-width:900px;margin:36px auto;padding:20px}label{display:block;margin:18px 0}input,select,button{padding:9px;font:inherit}table{border-collapse:collapse;margin-top:24px}td,th{padding:10px;border:1px solid #bbc}nav{margin:20px 0}</style></head><body><h1>受控浏览器合成演示</h1><p>仅使用本机隔离合成数据，不连接真实企业。合成登录及MFA由可信测试工具或用户接管完成。</p>${body}</body></html>`;

/** HTTP loopback is intentionally opt-in and exists only for local integration tests. */
export async function startInteractiveMockSite({ port = 0 } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('合成站点端口无效。');
  const sessions = new Map();
  let origin;
  let writes = 0;
  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers });
    response.end(body);
  };
  const login = (message = '') => page(`${message ? `<p role="alert">${escape(message)}</p>` : ''}<form id="interactive-login" method="post" action="/login"><label>合成账号 <input name="username" autocomplete="username" required></label><label>合成密码 <input type="password" name="password" autocomplete="current-password" required></label><button id="login-submit" type="submit">登录并进入MFA</button></form>`);
  const mfa = (message = '') => page(`${message ? `<p role="alert">${escape(message)}</p>` : ''}<p id="mfa-required">需要用户完成合成MFA。</p><form method="post" action="/mfa"><label>验证码 <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label><button id="mfa-submit" type="submit">验证并继续</button></form>`);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) return send(response, 400, page('<p>请求主机不匹配。</p>'));
      const url = new URL(request.url, origin);
      const token = /(?:^|;\s*)interactive_session=([a-f0-9]{48})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      const state = sessions.get(token);
      if (request.method === 'POST') {
        if (request.headers.origin !== origin || !String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(response, 403, page('<p>提交来源不匹配。</p>'));
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(response, 413, 'Too large'); }
        const fields = new URLSearchParams(body);
        if (url.pathname === '/login') {
          if (!same(fields.get('username'), 'demo') || !same(fields.get('password'), 'interactive123')) return send(response, 401, login('合成账号或密码不正确。'));
          const nextToken = randomBytes(24).toString('hex');
          sessions.set(nextToken, { mfa: false });
          return send(response, 303, '', { Location: '/mfa', 'Set-Cookie': `interactive_session=${nextToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
        }
        if (url.pathname === '/mfa') {
          if (!state) return send(response, 303, '', { Location: '/' });
          if (!same(fields.get('otp'), '246810')) return send(response, 401, mfa('合成验证码不正确。'));
          state.mfa = true;
          return send(response, 303, '', { Location: '/records' });
        }
        if (url.pathname === '/write' && state?.mfa) { writes += 1; return send(response, 200, page('<p id="write-receipt">不应由普通工具触发的合成业务写入。</p>')); }
        return send(response, 405, page('<p>不支持此合成动作。</p>'));
      }
      if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
      if (url.pathname === '/' || url.pathname === '/login') return send(response, 200, login());
      if (url.pathname === '/mfa') return send(response, state ? 200 : 303, state ? mfa() : '', state ? {} : { Location: '/' });
      if (!['/records', '/changed'].includes(url.pathname)) return send(response, 404, page('<p>页面不在合成场景中。</p>'));
      if (!state?.mfa) return send(response, 303, '', { Location: state ? '/mfa' : '/' });
      const changed = url.pathname === '/changed';
      const month = url.searchParams.get('month') ?? '2026-10';
      if (!['2026-10', '2026-09'].includes(month)) return send(response, 400, page('<p>合成月份无效。</p>'));
      const q = (url.searchParams.get('q') ?? '').slice(0, 80);
      return send(response, 200, page(`<p data-authenticated="true">MFA已完成；页面版本 ${changed ? '2' : '1'}</p><form id="record-search" action="${changed ? '/changed' : '/records'}" method="get"><label>搜索 <input id="${changed ? 'changed-search' : 'record-query'}" name="q" type="search" value="${escape(q)}"></label><label>月份 <select name="month"><option value="2026-10"${month === '2026-10' ? ' selected' : ''}>2026-10</option><option value="2026-09"${month === '2026-09' ? ' selected' : ''}>2026-09</option></select></label><button id="search-submit" type="submit">筛选合成记录</button></form><p id="result-summary">当前合成月份 ${month}，${q ? '已应用搜索条件' : '全部合成记录'}。</p><table><thead><tr><th>单号</th><th>金额（分）</th></tr></thead><tbody><tr><td>${month === '2026-10' ? 'SYN-101' : 'SYN-091'}</td><td>${month === '2026-10' ? '12345' : '9087'}</td></tr></tbody></table><nav><a id="change-page" href="${changed ? '/records' : '/changed'}">切换合成页面版本</a></nav><form id="business-write" action="/write" method="post"><button id="business-submit" type="submit">提交合成业务写入</button></form><input type="hidden" name="token" value="hidden-fixture-token"><input id="private-input" value="private-input-value" hidden><div hidden>hidden-fixture-text</div><div aria-hidden="true">aria-hidden-fixture-text</div><div style="display:none">css-hidden-fixture-text</div><p>文档链接 https://synthetic.invalid/reference?token=visible-query-secret</p><p>access_token=visible-token-secret</p>`));
    } catch { if (!response.headersSent) send(response, 500, page('<p>合成站点失败。</p>')); else response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    site: Object.freeze({ id: 'interactive-mock', label: '交互式本机合成站点', origin, entryPath: '/', paths: ['/', '/login', '/mfa', '/records', '/changed', '/write'], queryKeys: { '/records': ['q', 'month'], '/changed': ['q', 'month'] }, allowMockLoopback: true, credentialForm: { selector: '#interactive-login', usernameSelector: 'input[name="username"]', passwordSelector: 'input[name="password"]', actionPath: '/login', method: 'post' }, manualPostPaths: ['/login', '/mfa'], readOnlyActions: [{ selector: '#search-submit', kind: 'search' }, { selector: '#change-page', kind: 'read' }] }),
    // Synthetic test assertion only; no real business store is accessed.
    getWriteCount: () => writes,
    async close() { if (closed) return; closed = true; sessions.clear(); await new Promise((resolve, reject) => { server.close((problem) => problem ? reject(problem) : resolve()); server.closeAllConnections(); }); },
  };
}
