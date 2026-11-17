import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAttachments, buildAttachmentParts, attachmentRecords } from '../src/agent/attachments.mjs';
import { createBrowserModelRequester } from '../src/model/gateway.mjs';
import { createAgentStore } from '../src/agent/store.mjs';
import { createTaskBudget } from '../src/agent/budget.mjs';

const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const png = {
  name: '截图.png', mediaType: 'image/png',
  data: `data:image/png;base64,${pngData}`, size: Buffer.from(pngData, 'base64').length,
};
const txtData = Buffer.from('合成记录 SYN-091，金额 9087 分。\n第二行参考。', 'utf8');
const note = {
  name: '核对笔记.txt', mediaType: 'text/plain',
  data: `data:text/plain;base64,${txtData.toString('base64')}`, size: txtData.length,
};

test('附件校验：类型白名单、显式拒绝视频、大小与数量上限、内容与名称验证', async () => {
  const ok = validateAttachments([png, note]);
  assert.equal(ok.length, 2);
  assert.equal(ok[0].kind, 'image');
  assert.equal(ok[1].kind, 'text');
  assert.equal(validateAttachments(undefined).length, 0);
  assert.equal(validateAttachments([]).length, 0);
  const mp4 = { name: '录像.mp4', mediaType: 'video/mp4', size: 10, data: 'data:video/mp4;base64,AAAA' };
  assert.throws(() => validateAttachments([mp4]), error => error.code === 'ATTACHMENT_VIDEO_UNSUPPORTED');
  assert.throws(() => validateAttachments([{ name: '程序.exe', mediaType: 'application/octet-stream', size: 10, data: 'data:application/octet-stream;base64,AAAA' }]), error => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED');
  assert.throws(() => validateAttachments([{ ...png, name: 'a/b.png' }]), error => error.code === 'ATTACHMENT_NAME_INVALID');
  assert.throws(() => validateAttachments([{ ...png, size: 3 * 1024 * 1024 + 1 }]), error => error.code === 'ATTACHMENT_TOO_LARGE');
  const big = { name: '大.png', mediaType: 'image/png', size: 3 * 1024 * 1024, data: `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}` };
  assert.throws(() => validateAttachments([0, 1, 2, 3].map(i => ({ ...big, name: `大${i}.png` }))), error => error.code === 'ATTACHMENT_TOO_LARGE');
  assert.throws(() => validateAttachments([png, png]), error => error.code === 'ATTACHMENT_DUPLICATE');
  assert.throws(() => validateAttachments([{ ...png, data: 'data:image/png;base64,not-base64!!!' }]), error => error.code === 'ATTACHMENT_DATA_INVALID');
  assert.throws(() => validateAttachments([{ ...png, mediaType: 'image/gif' }]), error => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED');
  assert.throws(() => validateAttachments(Array(7).fill(png)), error => error.code === 'ATTACHMENT_LIMIT');
});

test('多模态消息parts：图片转 image_url，文本附摘录，PDF/Office/音频仅登记', () => {
  const pdf = validateAttachments([{ name: '合同.pdf', mediaType: 'application/pdf', size: 3, data: 'data:application/pdf;base64,AAAA' }])[0];
  const parts = buildAttachmentParts([...validateAttachments([png, note]), pdf]);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { type: 'image_url', image_url: { url: png.data } });
  assert.equal(parts[1].type, 'text');
  assert.ok(parts[1].text.includes('核对笔记.txt'));
  assert.ok(parts[1].text.includes('SYN-091'));
  assert.equal(parts[2].type, 'text');
  assert.ok(parts[2].text.includes('合同.pdf'));
  assert.ok(parts[2].text.includes('不解析其正文'));
  const records = attachmentRecords(validateAttachments([png]));
  assert.deepEqual(records, [{ id: 'att-1', name: '截图.png', mediaType: 'image/png', kind: 'image', size: png.size }]);
});

async function gatewayFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'yuanyu-attach-gw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'model.local.json'), keyFile = join(dir, 'model.key');
  await writeFile(keyFile, 'synthetic-model-key');
  const profile = { schemaVersion: 1, enabled: true, baseUrl: 'https://model.example.test/v1', model: 'synthetic-test-model', apiKeyFile: keyFile, dataScope: 'selected_pages' };
  await writeFile(file, JSON.stringify(profile));
  return { file, profile, dir };
}
const browserTools = [{ type: 'function', function: { name: 'browser_observe', parameters: { type: 'object', properties: { siteId: { type: 'string' } }, required: ['siteId'], additionalProperties: false } } }];
const systemMessage = { role: 'system', content: 'Use bounded read-only browser tools.' };
const partsMessage = { role: 'user', content: [{ type: 'text', text: '读取合成记录' }, { type: 'image_url', image_url: { url: png.data } }, { type: 'text', text: '[附件 核对笔记.txt]\nSYN-091' }] };

test('浏览器模型接受首个用户消息的多模态parts并原样发送，后续消息不允许数组内容', async t => {
  const { file } = await gatewayFixture(t);
  const request = await createBrowserModelRequester({
    file, consent: { taskText: true, pageContent: true },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.messages[1], partsMessage);
      assert.equal(body.messages.length, 2);
      return new Response(JSON.stringify({ choices: [{ message: { content: '仅已读取的合成记录符合条件。' } }] }));
    },
  });
  const result = await request({ messages: [systemMessage, partsMessage], tools: browserTools });
  assert.equal(result.content, '仅已读取的合成记录符合条件。');
  const laterArray = { role: 'user', content: [{ type: 'text', text: '补充说明' }] };
  await assert.rejects(request({ messages: [systemMessage, { role: 'user', content: '开始' }, laterArray], tools: browserTools }), /MODEL_INPUT_INVALID/);
  await assert.rejects(request({ messages: [systemMessage, { role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }], tools: browserTools }), /MODEL_INPUT_INVALID/);
  await assert.rejects(request({ messages: [systemMessage, { role: 'user', content: [{ type: 'text', text: '开始' }, { type: 'image_url', image_url: { url: 'data:text/html;base64,PGI+' } }] }], tools: browserTools }), /MODEL_INPUT_INVALID/);
  await assert.rejects(request({ messages: [systemMessage, { role: 'user', content: [] }], tools: browserTools }), /MODEL_INPUT_INVALID/);
});

test('任务存储：附件元数据白名单、文件落盘往返、篡改与未知附件拒绝', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'yuanyu-attach-store-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const identity = { companyId: 'mock-acme', userId: 'alice', displayName: '林悦', provider: 'mock' };
  const store = createAgentStore({ dataDir, identity });
  const records = attachmentRecords(validateAttachments([png, note]));
  const task = await store.createTask({
    goal: '读取合成记录并核对附件', siteBindings: [{ id: 'interactive-mock', origin: 'http://127.0.0.1:15333', revision: 1 }],
    mode: 'mock_browser', budget: createTaskBudget({}),
    attachments: records,
  });
  assert.equal(task.attachments.length, 2);
  for (const record of records) {
    const buffer = record.name.endsWith('.txt') ? txtData : Buffer.from(pngData, 'base64');
    await store.saveAttachment(task.id, record, buffer);
  }
  const loaded = await store.loadAttachment(task.id, records[1]);
  assert.equal(loaded.toString('utf8'), txtData.toString('utf8'));
  await assert.rejects(store.loadAttachment(task.id, { id: 'att-9', name: '不存在.txt', mediaType: 'text/plain', kind: 'text', size: 1 }), error => error.code === 'AGENT_TASK_NOT_FOUND');
  // 篡改磁盘文件后读取必须失败。
  const base = join(dataDir, 'agents', 'mock-acme', 'alice', 'attachments', task.id);
  const files = (await import('node:fs/promises')).readdir;
  const stored = (await files(base)).find(name => name.endsWith('.txt'));
  await writeFile(join(base, stored), '被篡改的内容明显更长');
  await assert.rejects(store.loadAttachment(task.id, records[1]), error => error.code === 'AGENT_UNSAFE_PATH');
  // 白名单之外的字段与非法类别拒绝。
  await store.updateTask(task.id, { status: 'cancelled' });
  await assert.rejects(store.createTask({
    goal: 'x', siteBindings: [{ id: 'interactive-mock', origin: 'http://127.0.0.1:15333', revision: 1 }], mode: 'mock_browser',
    attachments: [{ id: 'att-1', name: 'a.png', mediaType: 'image/png', kind: 'video', size: 1 }],
  }), /AGENT_INPUT_INVALID|附件类别无效/);
});

test('控制器端到端：带图片附件的模型浏览器任务完成，附件落盘且模型收到多模态parts', async t => {
  const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
  const { mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { createController } = await import('../src/controller.mjs');
  const { createBrowserModelRequester } = await import('../src/model/gateway.mjs');
  const dataDir = await mkdtemp(join(tmpdir(), 'yuanyu-attach-ctl-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const cryptoAdapter = { available: () => true, encrypt: text => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const out = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64'); }, decrypt: text => { const buf = Buffer.from(text, 'base64'), d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString(); } };
  const systems = { procurement: { id: 'procurement', label: 'procurement', origin: 'http://127.0.0.1:15331', url: 'http://127.0.0.1:15331/' } };
  const seenParts = [];
  let turn = 0, firstRequest = true;
  const browser = { open: async () => ({ mode: 'automatic' }), observe: async () => ({ text: '合成测试采购单已入库', elements: [] }), handoff: async () => ({}), act: async () => ({}), cancel: async () => {}, close: async () => {} };
  const factory = options => createBrowserModelRequester({
    ...options, fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const first = body.messages[1].content;
      if (firstRequest) { assert.ok(Array.isArray(first)); assert.equal(first[0].type, 'text'); assert.equal(first[1].type, 'image_url'); assert.ok(first[1].image_url.url.startsWith('data:image/png;base64,')); seenParts.push(...first.slice(1)); firstRequest = false; }
      turn++;
      const name = turn === 1 ? 'browser_open' : turn === 2 ? 'browser_observe' : null;
      const message = name ? { tool_calls: [{ id: `step-${turn}`, function: { name, arguments: JSON.stringify({ siteId: 'site-business' }) } }] } : { content: '根据当前合成页面，采购单已入库；未覆盖其他系统。' };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    },
  });
  const controller = await createController({ dataDir, cryptoAdapter, systems, BrowserWindow: class { constructor() { throw new Error('NO_BROWSER_ALLOWED'); } }, interactiveFactory: () => browser, agentRequesterFactory: factory });
  t.after(() => controller.close());
  const site = await controller.invoke('site.register', { id: 'site-business', label: '合成业务配置', origin: 'https://fixture.example.invalid', entryPath: '/', paths: ['/'] });
  const file = join(dataDir, 'models', 'mock-acme', 'alice', 'model.local.json'), apiKeyFile = join(dataDir, 'synthetic.key');
  await mkdir(join(dataDir, 'models', 'mock-acme', 'alice'), { recursive: true });
  await writeFile(apiKeyFile, 'synthetic-controller-key');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, enabled: true, baseUrl: 'https://provider.example.invalid/v1', model: 'synthetic-controller', apiKeyFile, dataScope: 'selected_pages' }));
  await assert.rejects(controller.invoke('agent.start', { goal: '查看合成业务状态', siteIds: [site.id], mode: 'compatible_browser', consent: { taskText: true, pageContent: true }, attachments: [{ name: '录像.mp4', mediaType: 'video/mp4', size: 8, data: 'data:video/mp4;base64,AAAA' }] }), error => error.code === 'ATTACHMENT_VIDEO_UNSUPPORTED');
  const { taskId } = await controller.invoke('agent.start', { goal: '查看合成业务状态', siteIds: [site.id], mode: 'compatible_browser', consent: { taskText: true, pageContent: true }, attachments: [{ name: png.name, mediaType: png.mediaType, size: png.size, data: png.data }] });
  await controller.waitForIdle();
  let task = (await controller.snapshot()).agentTasks.find(entry => entry.id === taskId);
  assert.equal(task.status, 'awaiting_review', JSON.stringify(task.error));
  await controller.invoke('agent.confirmResult', { id: taskId, confirmed: true, expectedAttempt: task.attempt });
  task = (await controller.snapshot()).agentTasks.find(entry => entry.id === taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.attachments.length, 1);
  assert.equal(task.attachments[0].name, '截图.png');
  assert.equal(task.attachments[0].kind, 'image');
  const stored = join(dataDir, 'agents', 'mock-acme', 'alice', 'attachments', taskId, `att-1-${png.name}`);
  assert.ok(existsSync(stored), '附件文件必须按任务落盘');
  assert.equal(seenParts.length, 1);
});
