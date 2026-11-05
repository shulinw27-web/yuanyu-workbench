import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ACCOUNTS = Object.freeze({ username: 'demo', password: 'demo123' });
const DATA = Object.freeze({
  procurement: {
    '2026-10': [
      ['PO-202610-001', '青禾办公合成供应商', '2026-10-03', '已审核', 100000],
      ['PO-202610-002', '远川设备合成供应商', '2026-10-09', '已审核', 250000],
      ['PO-202610-003', '北岸耗材合成供应商', '2026-10-18', '已审核', 180000],
      ['PO-202610-004', '待审合成供应商', '2026-10-24', '待审核', 90000],
    ],
    '2026-09': [
      ['PO-202609-001', '九月文具合成供应商', '2026-09-02', '已审核', 45678],
      ['PO-202609-002', '九月仪器合成供应商', '2026-09-12', '已审核', 220001],
      ['PO-202609-003', '九月材料合成供应商', '2026-09-21', '已审核', 76543],
      ['PO-202609-004', '九月待审合成供应商', '2026-09-26', '待审核', 12000],
    ],
  },
  warehouse: {
    '2026-10': [
      ['GR-202610-001', 'PO-202610-001', '2026-10-05', '已入库', 100000],
      ['GR-202610-002', 'PO-202610-002', '2026-10-14', '已入库', 150000],
    ],
    '2026-09': [
      ['GR-202609-001', 'PO-202609-001', '2026-09-06', '已入库', 45678],
      ['GR-202609-002', 'PO-202609-002', '2026-09-16', '已入库', 120000],
      ['GR-202609-003', 'PO-202609-002', '2026-09-19', '已入库', 100001],
    ],
  },
});
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const descriptors = {
  procurement: { label: 'Mock采购系统', path: '/orders', fields: ['poNumber', 'supplier', 'orderDate', 'status', 'amountCents'], labels: ['采购单号', '供应商（合成）', '订单日期', '审核状态', '采购金额（分）'] },
  warehouse: { label: 'Mock仓储系统', path: '/receipts', fields: ['receiptNumber', 'poNumber', 'receivedDate', 'status', 'amountCents'], labels: ['入库单号', '采购单号', '入库日期', '入库状态', '入库金额（分）'] },
};

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:1080px;margin:40px auto;padding:0 24px;background:#f4f7fb;color:#17263c}main{background:white;padding:28px;border:1px solid #d9e2ef;border-radius:16px}h1{margin-top:0}.mock{padding:12px 16px;background:#fff3ca;border-radius:8px;margin-bottom:22px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:9px 12px;border:1px solid #a8b7cb;border-radius:7px}button{background:#215ca8;color:white;cursor:pointer}table{border-collapse:collapse;width:100%;margin-top:24px}td,th{text-align:left;border-bottom:1px solid #d9e2ef;padding:12px 9px}th{background:#edf3fa}.error{color:#b42318}</style></head><body><main><h1>${title}</h1><div class="mock">本页为隔离的 Mock 演示，仅使用合成数据。演示账号：<strong>demo</strong> / <strong>demo123</strong>。不连接真实企业系统。</div>${body}</main></body></html>`;
}

function send(response, status, html, headers = {}) {
  // Chromium suppresses a form POST's Origin under no-referrer. Preserve it for
  // same-origin login so the strict server-side Origin check remains effective.
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...headers });
  response.end(html);
}

function equalCredential(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function startOne(id, port) {
  const descriptor = descriptors[id];
  const sessions = new Map();
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host) return send(response, 400, page(descriptor.label, '<p>请求主机不匹配。</p>'));
      if (!['GET', 'POST'].includes(request.method)) return send(response, 405, 'Method not allowed');
      const sessionId = /(?:^|;\s*)mock_session=([a-f0-9]{48})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      const authenticated = sessionId && (sessions.get(sessionId) ?? 0) > Date.now();
      if (url.pathname === '/login' && request.method === 'POST') {
        if (request.headers.origin !== origin || !String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(response, 403, page(descriptor.label, '<p>登录请求来源不匹配。</p>'));
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) return send(response, 413, 'Request too large');
        }
        const fields = new URLSearchParams(body);
        if (!equalCredential(fields.get('username'), ACCOUNTS.username) || !equalCredential(fields.get('password'), ACCOUNTS.password)) {
          return send(response, 401, loginPage(id, '演示账号或密码不正确。'));
        }
        const token = randomBytes(24).toString('hex');
        sessions.set(token, Date.now() + 60 * 60 * 1000);
        return send(response, 303, '', { Location: `${descriptor.path}?month=2026-10`, 'Set-Cookie': `mock_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
      }
      if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
      if (url.pathname === '/' || url.pathname === '/login') return send(response, 200, loginPage(id));
      if (url.pathname !== descriptor.path) return send(response, 404, page(descriptor.label, '<p>页面不存在。</p>'));
      if (!authenticated) return send(response, 303, '', { Location: '/' });
      const month = url.searchParams.get('month') ?? '2026-10';
      if (!Object.hasOwn(DATA[id], month)) return send(response, 400, page(descriptor.label, '<p>仅提供2026-09与2026-10的合成数据。</p>'));
      const rows = DATA[id][month].map((row) => `<tr>${row.map((cell, index) => `<td data-field="${descriptor.fields[index]}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
      return send(response, 200, page(descriptor.label, `<p data-authenticated="true">已登录演示用户 demo</p><form id="month-filter" action="${descriptor.path}" method="get"><label>业务月份 <select id="month" name="month">${['2026-10', '2026-09'].map((value) => `<option value="${value}"${value === month ? ' selected' : ''}>${value}</option>`).join('')}</select></label><button type="submit">筛选月份</button></form><p>当前月份：<strong id="dataset-month">${month}</strong>；所有金额以整数分展示。</p><table id="business-data" data-system="${id}" data-month="${month}" data-schema="1"><thead><tr>${descriptor.fields.map((field, index) => `<th data-field="${field}">${descriptor.labels[index]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`));
    } catch {
      if (!response.headersSent) send(response, 500, page(descriptor.label, '<p>Mock系统暂时不可用。</p>'));
      else response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    system: Object.freeze({ id, label: descriptor.label, origin, url: `${origin}/` }),
    close: () => new Promise((resolve, reject) => { sessions.clear(); server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

function loginPage(id, error = '') {
  return page(descriptors[id].label, `${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form id="login-form" action="/login" method="post"><label>演示账号 <input id="username" name="username" autocomplete="off" required></label><label>演示密码 <input id="password" name="password" type="password" autocomplete="off" required></label><button type="submit">登录Mock系统</button></form>`);
}

export async function startMockSystems({ ports = {} } = {}) {
  if (!ports || typeof ports !== 'object' || Array.isArray(ports) || Object.keys(ports).some((key) => !Object.hasOwn(descriptors, key))) throw new Error('Mock端口配置无效。');
  const configuredPorts = Object.fromEntries(Object.keys(descriptors).map((id) => [id, ports[id] ?? 0]));
  if (Object.values(configuredPorts).some((port) => !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) || (configuredPorts.procurement !== 0 && configuredPorts.procurement === configuredPorts.warehouse)) throw new Error('Mock端口必须是0或不同的1024–65535整数。');
  const started = [];
  try {
    started.push(await startOne('procurement', configuredPorts.procurement));
    started.push(await startOne('warehouse', configuredPorts.warehouse));
  } catch (error) {
    await Promise.allSettled(started.map((item) => item.close()));
    throw error;
  }
  let closed = false;
  return {
    systems: Object.freeze(Object.fromEntries(started.map((item) => [item.system.id, item.system]))),
    async close() { if (closed) return; closed = true; await Promise.all(started.map((item) => item.close())); },
  };
}
