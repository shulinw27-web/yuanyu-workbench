import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockSystems } from '../src/mock/systems.mjs';

async function login(system, password = 'demo123') {
  return fetch(`${system.origin}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: system.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'demo', password }) });
}

test('real separate Mock servers require login and return distinct month-filtered HTML', async () => {
  const mock = await startMockSystems();
  try {
    assert.notEqual(mock.systems.procurement.origin, mock.systems.warehouse.origin);
    for (const [id, system] of Object.entries(mock.systems)) {
      const route = id === 'procurement' ? '/orders' : '/receipts';
      const entry = await fetch(system.url);
      assert.equal(entry.headers.get('referrer-policy'), 'same-origin', 'Chromium表单登录需要保留同源POST Origin');
      const initial = await entry.text();
      assert.match(initial, /Mock/); assert.match(initial, /demo123/); assert.match(initial, /id="login-form"/);
      const before = await fetch(`${system.origin}${route}?month=2026-10`, { redirect: 'manual' });
      assert.equal(before.status, 303);
      assert.equal((await login(system, 'incorrect')).status, 401);
      const authenticated = await login(system);
      assert.equal(authenticated.status, 303);
      const cookie = authenticated.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
      const headers = { Cookie: cookie.split(';')[0] };
      const october = await (await fetch(`${system.origin}${route}?month=2026-10`, { headers })).text();
      const september = await (await fetch(`${system.origin}${route}?month=2026-09`, { headers })).text();
      assert.match(october, /data-month="2026-10"/); assert.match(september, /data-month="2026-09"/);
      assert.match(october, /PO-202610-001/); assert.doesNotMatch(october, /PO-202609-001/);
      assert.match(september, /PO-202609-001/); assert.doesNotMatch(september, /PO-202610-001/);
      assert.equal((await fetch(`${system.origin}${route}?month=2025-01`, { headers })).status, 400);
      const other = mock.systems[id === 'procurement' ? 'warehouse' : 'procurement'];
      const wrongOrigin = await fetch(`${system.origin}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: other.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=demo&password=demo123' });
      assert.equal(wrongOrigin.status, 403);
    }
    const usedPort = Number(new URL(mock.systems.procurement.origin).port);
    await assert.rejects(startMockSystems({ ports: { procurement: usedPort } }), (error) => error.code === 'EADDRINUSE');
    await assert.rejects(startMockSystems({ ports: { procurement: 443 } }));
  } finally { await mock.close(); }
});
