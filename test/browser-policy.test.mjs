import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserDriver } from '../src/browser/driver.mjs';
import { isAllowedSystemUrl, validateReadResult, validateRows, validateSystem } from '../src/browser/policy.mjs';

const systems = {
  procurement: { id: 'procurement', label: 'Mock采购', origin: 'http://127.0.0.1:15331', url: 'http://127.0.0.1:15331/' },
  warehouse: { id: 'warehouse', label: 'Mock仓储', origin: 'http://127.0.0.1:15332', url: 'http://127.0.0.1:15332/' },
};

test('URL policy confines each system to fixed loopback origin and business routes', () => {
  assert.equal(isAllowedSystemUrl('http://127.0.0.1:15331/orders?month=2026-09', 'procurement', systems.procurement.origin), true);
  for (const url of ['https://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1:15332/orders?month=2026-10', 'http://127.0.0.1:15331/orders?month=2026-10&month=2026-09', 'http://127.0.0.1:15331/orders?month=2025-10', 'http://127.0.0.1:15331/orders?month=2026-10#x', 'http://demo:demo123@127.0.0.1:15331/', 'http://127.0.0.1:15331/private', 'http://127.0.0.1:15331/receipts']) {
    assert.equal(isAllowedSystemUrl(url, 'procurement', systems.procurement.origin), false, url);
  }
  assert.throws(() => validateSystem('procurement', { ...systems.procurement, origin: 'http://localhost:15331' }));
});

test('table validation rejects unsafe amounts, duplicate PO, mismatched dates and fields', () => {
  const row = { poNumber: 'PO-001', supplier: '合成供应商', orderDate: '2026-10-01', status: '已审核', amountCents: 101 };
  assert.equal(validateRows('procurement', [row], '2026-10')[0].amountCents, 101);
  for (const changed of [{ amountCents: 1.01 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { orderDate: '2026-09-30' }, { orderDate: '2026-10-32' }, { status: '可疑状态' }, { password: 'forbidden' }]) assert.throws(() => validateRows('procurement', [{ ...row, ...changed }], '2026-10'));
  assert.throws(() => validateRows('procurement', [row, row], '2026-10'));
  assert.throws(() => validateReadResult({ rows: [row], source: { systemId: 'procurement', url: `${systems.procurement.origin}/orders?month=2026-09`, month: '2026-10', readAt: new Date().toISOString() } }, 'procurement', '2026-10'));
});

test('browser cancellation rejects late navigation and locks down its separate session', async () => {
  let created;
  let finishLoad;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); created = this; this.options = options; this.dead = false;
      const session = new EventEmitter();
      session.setPermissionRequestHandler = (handler) => { session.permission = handler; };
      session.setPermissionCheckHandler = (handler) => { session.permissionCheck = handler; };
      session.webRequest = { onBeforeRequest: (handler) => { session.request = handler; } };
      this.webContents = new EventEmitter(); this.webContents.session = session;
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      this.webContents.getURL = () => systems.procurement.url;
    }
    loadURL() { return new Promise((resolve) => { finishLoad = resolve; }); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); this.webContents.emit('destroyed'); }
  }
  const driver = createBrowserDriver({ BrowserWindow: FakeWindow, systems, show: false });
  const pending = driver.readSystem('procurement', { month: '2026-10', credential: { username: 'demo', password: 'demo123', origin: systems.procurement.origin } });
  const rejected = assert.rejects(pending, (error) => error.code === 'CANCELLED' && !error.message.includes('demo123'));
  assert.equal(created.options.webPreferences.nodeIntegration, false);
  assert.equal(created.options.webPreferences.sandbox, true);
  assert.equal(created.options.webPreferences.preload, undefined);
  assert.equal(created.options.webPreferences.partition.startsWith('persist:'), false);
  assert.deepEqual(created.openHandler(), { action: 'deny' });
  assert.equal(created.webContents.session.permissionCheck(), false);
  let denied;
  created.webContents.session.request({ url: 'https://example.com/' }, ({ cancel }) => { denied = cancel; });
  assert.equal(denied, true);
  await driver.close(); finishLoad(); await rejected;
  await assert.rejects(driver.readSystem('procurement', { month: '2026-10' }), { code: 'CANCELLED' });
});
