import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {fileURLToPath} from 'node:url';
import { createPromotionService,createSponsoredProvider,quotaPeriod } from '../src/service/index.mjs';

const password = 'synthetic-passphrase-only';
const inference = (requestId, extra = {}) => ({ modelId: 'demo-synthetic', messages: [{ role: 'user', content: '读取合成采购资料，不调用真实系统。' }], tools: [], consent: { taskText: true }, requestId, ...extra });
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const successful = () => ({ message: { role: 'assistant', content: '隔离合成结果。' }, usage });
const waitUntil = async (condition) => { for (let attempt = 0; attempt < 400; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('condition did not occur'); };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'yuanyu-promotion-test-'));
  const services = [];
  t.after(async () => { for (const service of services.reverse()) await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function start(extra = {}) { const service = await createPromotionService({ dataDir, demo: true, monthlyTokens: 100_000, dailyRequests: 20,developer:{name:'开发者',contact:''}, ...options, ...extra }); services.push(service); return service; }
  const service = await start();
  const call = async (route, { token, body, method = body === undefined ? 'GET' : 'POST', base = service.url, headers = {} } = {}) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  let sequence = 0;
  const register = async (extra = {}, base) => { const result = await call('/v1/auth/register', { base, body: { email: `synthetic${++sequence}@example.test`, password, name: '合成用户', ...extra } }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; };
  const verified = async (base) => { const account = await register({}, base); const result = await call('/v1/auth/verify', { base, token: account.sessionToken, body: { code: account.demoVerificationCode } }); assert.equal(result.status, 200); return { ...account, account: result.data.account }; };
  return { dataDir, service, call, register, verified, start };
}

test('默认推广额度未开放，企业邮箱保留空入口；运营者额度配置跨重启持久化', async (t) => {
  const f = await fixture(t, { monthlyTokens: undefined, dailyRequests: undefined });
  const info = await f.call('/v1/public');
  assert.deepEqual(info.data.limits, { monthlyTokens: 0, dailyRequests: 0, configured: false });
  assert.equal(info.data.developer.contact, ''); assert.equal(info.data.deployment, 'local_demo'); assert.equal(info.data.registration.verification, 'demo_code');
  const user = await f.verified();
  const denied = await f.call('/v1/inference', { token: user.sessionToken, body: inference('quota-unset-001') });
  assert.equal(denied.status, 503); assert.equal(denied.data.error.code, 'PROMOTION_NOT_AVAILABLE');
  assert.deepEqual(f.service.operator.setQuota({ monthlyTokens: 20_000, dailyRequests: 2 }), { monthlyTokens: 20_000, dailyRequests: 2, configured: true });
  await f.service.close();
  const restarted = await f.start({ monthlyTokens: undefined, dailyRequests: undefined });
  assert.equal((await f.call('/v1/public', { base: restarted.url })).data.limits.monthlyTokens, 20_000);
  assert.equal((await f.call('/v1/inference', { base: restarted.url, token: user.sessionToken, body: inference('quota-open-001') })).data.synthetic, true);
});

test('注册、合成验证、登录、撤权与注销闭环，数据库不保存密码或明文令牌', async (t) => {
  const f = await fixture(t), user = await f.register();
  assert.equal(user.account.verified, false); assert.equal(user.account.tier, 'personal');
  assert.equal((await f.call('/v1/inference', { token: user.sessionToken, body: inference('unverified-001') })).data.error.code, 'VERIFICATION_REQUIRED');
  assert.equal((await f.call('/v1/auth/verify', { token: user.sessionToken, body: { code: 'wrong' } })).data.error.code, 'VERIFICATION_INVALID');
  assert.equal((await f.call('/v1/auth/verify', { token: user.sessionToken, body: { code: user.demoVerificationCode } })).data.account.verified, true);
  const login = await f.call('/v1/auth/login', { body: { email: user.account.email.toUpperCase(), password } });
  assert.equal(login.status, 200); assert.notEqual(login.data.sessionToken, user.sessionToken);
  assert.equal((await f.call('/v1/auth/login', { body: { email: user.account.email, password: 'synthetic-wrong-password' } })).data.error.code, 'AUTH_FAILED');
  const bytes = Buffer.concat(await Promise.all(['promotion.sqlite', 'promotion.sqlite-wal'].map((file) => readFile(join(f.dataDir, file)))));
  for (const secret of [password, user.sessionToken, login.data.sessionToken, user.demoVerificationCode]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  await f.call('/v1/auth/logout', { token: login.data.sessionToken, body: {} });
  assert.equal((await f.call('/v1/me', { token: login.data.sessionToken })).status, 401);
  f.service.operator.revokeSessions(user.account.id);
  assert.equal((await f.call('/v1/me', { token: user.sessionToken })).status, 401);
});

test('客户端不能伪造企业身份、公开额度、模型或工具，跨来源网页拒绝访问', async (t) => {
  const f = await fixture(t);
  for (const extra of [{ tier: 'enterprise' }, { companyId: 'acme' }, { monthlyTokens: 999_999 }]) assert.equal((await f.call('/v1/auth/register', { body: { email: 'forged@example.test', password, name: '伪造', ...extra } })).status, 400);
  const user = await f.verified();
  const cases = [
    [inference('forged-model-01', { modelId: 'unapproved-model' }), 'MODEL_NOT_ALLOWED'],
    [inference('forged-tool-001', { tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }] }), 'TOOL_NOT_ALLOWED'],
    [inference('forged-consent1', { consent: { taskText: false } }), 'CONSENT_REQUIRED'],
    [inference('forged-page-001', { messages: [{ role: 'user', content: 'task' }, { role: 'tool', tool_call_id: 'test', content: 'page' }] }), 'CONSENT_REQUIRED'],
  ];
  for (const [body, code] of cases) assert.equal((await f.call('/v1/inference', { token: user.sessionToken, body })).data.error.code, code);
  assert.equal((await f.call('/v1/public', { headers: { origin: 'https://untrusted.example.test' } })).data.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal((await f.call('/v1/operator/set-quota', { token: user.sessionToken, body: { monthlyTokens: 999_999, dailyRequests: 1000 } })).status, 404);
  assert.equal((await f.call('/v1/me', { token: user.sessionToken })).data.usage.reservedTokens, 0);
});

test('精确用量结算、重复请求缓存、内容冲突拒绝，用户配额相互隔离', async (t) => {
  let calls = 0;
  const f = await fixture(t, { requestModel: () => { calls++; return successful(); } }), first = await f.verified(), second = await f.verified();
  const body = inference('idempotency-001');
  const result = await f.call('/v1/inference', { token: first.sessionToken, body });
  assert.equal(result.status, 200); assert.deepEqual(result.data.usage, usage); assert.equal(result.data.synthetic, false);
  assert.deepEqual((await f.call('/v1/inference', { token: first.sessionToken, body })).data, result.data); assert.equal(calls, 1);
  assert.equal((await f.call('/v1/inference', { token: first.sessionToken, body: { ...body, messages: [{ role: 'user', content: 'changed' }] } })).data.error.code, 'REQUEST_ID_CONFLICT');
  const privateUsage = (await f.call('/v1/me', { token: first.sessionToken })).data.usage;
  assert.equal(privateUsage.usedTokens, 15); assert.equal(privateUsage.reservedTokens, 0); assert.equal(privateUsage.dailyRequestsUsed, 1);
  assert.equal((await f.call('/v1/me', { token: second.sessionToken })).data.usage.usedTokens, 0);
  assert.equal((await f.call('/v1/inference', { token: second.sessionToken, body })).status, 200); assert.equal(calls, 2);
});

test('月额度和日次数在调用前限制，重复缓存不扣第二次，运营者可调整额度', async (t) => {
  let calls = 0;
  const f = await fixture(t, { monthlyTokens: 20, dailyRequests: 1, requestModel: () => { calls++; return successful(); } }), user = await f.verified();
  const request = (body) => f.call('/v1/inference', { token: user.sessionToken, body });
  assert.equal((await request(inference('monthly-denied1'))).data.error.code, 'MONTHLY_QUOTA_EXCEEDED'); assert.equal(calls, 0);
  f.service.operator.setQuota({ monthlyTokens: 10_000, dailyRequests: 1 });
  assert.equal((await request(inference('daily-allowed-1'))).status, 200);
  assert.equal((await request(inference('daily-allowed-1'))).status, 200); assert.equal(calls, 1);
  assert.equal((await request(inference('daily-denied-01'))).data.error.code, 'DAILY_REQUEST_LIMIT'); assert.equal(calls, 1);
  f.service.operator.setQuota({ monthlyTokens: 10_000, dailyRequests: 2 });
  assert.equal((await request(inference('daily-allowed-2'))).status, 200); assert.equal(calls, 2);
});

test('未知用量保留预留且缓存结果，提供方失败保留预留且不自动重复调用', async (t) => {
  let calls = 0;
  const f = await fixture(t, { requestModel: () => { calls++; if (calls === 1) return { message: { role: 'assistant', content: '合成内容，但上游缺少用量。' } }; throw Object.assign(new Error('do not expose synthetic-provider-secret'), { status: 402 }); } }), user = await f.verified();
  const first = await f.call('/v1/inference', { token: user.sessionToken, body: inference('usage-unknown01') });
  assert.equal(first.data.status, 'usage_pending'); assert.equal(first.data.usage, null);
  const reserved = (await f.call('/v1/me', { token: user.sessionToken })).data.usage.reservedTokens; assert.ok(reserved > 1600);
  assert.deepEqual((await f.call('/v1/inference', { token: user.sessionToken, body: inference('usage-unknown01') })).data, first.data); assert.equal(calls, 1);
  const failed = await f.call('/v1/inference', { token: user.sessionToken, body: inference('provider-fail01') });
  assert.equal(failed.data.error.code, 'PROVIDER_PAYMENT_REQUIRED'); assert.equal(JSON.stringify(failed.data).includes('secret'), false);
  assert.deepEqual((await f.call('/v1/inference', { token: user.sessionToken, body: inference('provider-fail01') })).data, failed.data); assert.equal(calls, 2);
  assert.ok((await f.call('/v1/me', { token: user.sessionToken })).data.usage.reservedTokens > reserved);
});

test('两个服务共享数据库时并发预留原子生效，启动第二实例不破坏存活请求', async (t) => {
  let calls = 0, release;
  const pending = new Promise((resolve) => { release = resolve; });
  const requester = async () => { calls++; await pending; return successful(); };
  const f = await fixture(t, { monthlyTokens: 3000, requestModel: requester }), user = await f.verified();
  const running = f.call('/v1/inference', { token: user.sessionToken, body: inference('concurrent-0001') });
  await waitUntil(() => calls === 1);
  const second = await f.start({ monthlyTokens: undefined, dailyRequests: undefined });
  assert.equal((await f.call('/v1/inference', { base: second.url, token: user.sessionToken, body: inference('concurrent-0001') })).data.error.code, 'REQUEST_PENDING');
  assert.equal((await f.call('/v1/inference', { base: second.url, token: user.sessionToken, body: inference('concurrent-0002') })).data.error.code, 'MONTHLY_QUOTA_EXCEEDED'); assert.equal(calls, 1);
  release(); assert.equal((await running).status, 200);
  assert.equal((await f.call('/v1/inference', { base: second.url, token: user.sessionToken, body: inference('concurrent-0001') })).data.status, 'completed'); assert.equal(calls, 1);
});

test('推理期间撤销会话或停用账号会抑制迟到结果，旧会话重新启用后仍无效', async (t) => {
  let called = false, release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { requestModel: async () => { called = true; await pending; return successful(); } }), user = await f.verified();
  const running = f.call('/v1/inference', { token: user.sessionToken, body: inference('revoked-running1') });
  await waitUntil(() => called); f.service.operator.setAccountEnabled(user.account.id, false); release();
  const result = await running; assert.equal(result.status, 401); assert.equal(JSON.stringify(result.data).includes('隔离合成结果'), false);
  f.service.operator.setAccountEnabled(user.account.id, true);
  assert.equal((await f.call('/v1/me', { token: user.sessionToken })).status, 401);
  const login = await f.call('/v1/auth/login', { body: { email: user.account.email, password } }); assert.equal(login.status, 200);
  assert.ok((await f.call('/v1/me', { token: login.data.sessionToken })).data.usage.reservedTokens > 0);
});

test('提供方处理中进程崩溃后重启保留额度并拒绝重发，不能冒充完成或免费重试', async (t) => {
  const f = await fixture(t); await f.service.close();
  const script = `import {createPromotionService} from ${JSON.stringify(new URL('../src/service/index.mjs', import.meta.url).href)};
    const service=await createPromotionService({dataDir:process.argv[1],demo:true,monthlyTokens:100000,dailyRequests:20,
      requestModel:()=>{process.send({entered:true});return new Promise(()=>{});}});
    process.send({url:service.url});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.dataDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  let base, entered = false; child.on('message', (message) => { if (message.url) base = message.url; if (message.entered) entered = true; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitUntil(() => base); const user = await f.verified(base);
  const body = inference('crashed-provider1'), running = f.call('/v1/inference', { base, token: user.sessionToken, body }).catch(() => null);
  await waitUntil(() => entered); const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; await running;
  const restarted = await f.start({ monthlyTokens: undefined, dailyRequests: undefined });
  const replay = await f.call('/v1/inference', { base: restarted.url, token: user.sessionToken, body });
  assert.equal(replay.status, 409); assert.equal(replay.data.error.code, 'REQUEST_UNCERTAIN');
  const after = (await f.call('/v1/me', { base: restarted.url, token: user.sessionToken })).data.usage;
  assert.ok(after.reservedTokens > 0); assert.equal(after.usedTokens, 0); assert.equal(after.dailyRequestsUsed, 1);
});

test('真实模式不会返回合成验证码或自动调用模型，运营者验证明确可用', async (t) => {
  const f = await fixture(t, { demo: false });
  const info = await f.call('/v1/public'); assert.equal(info.data.registration.verification, 'operator_required'); assert.deepEqual(info.data.models, []);
  const user = await f.register(); assert.equal(Object.hasOwn(user, 'demoVerificationCode'), false);
  assert.equal(f.service.operator.verifyAccount(user.account.id).verified, true);
  assert.equal((await f.call('/v1/inference', { token: user.sessionToken, body: inference('no-provider-001') })).data.error.code, 'INFERENCE_NOT_CONFIGURED');
  assert.throws(() => f.service.operator.setQuota({ monthlyTokens: -1, dailyRequests: 1 }));
});

test('服务端限时失败保留预留，上游额外工具不能绕过允许集合', async (t) => {
  const f = await fixture(t, { inferenceTimeoutMs: 15, requestModel: () => new Promise(() => {}) }), user = await f.verified();
  const result = await f.call('/v1/inference', { token: user.sessionToken, body: inference('timeout-once-01') }); assert.equal(result.status, 504); assert.equal(result.data.error.code, 'PROVIDER_TIMEOUT');
  assert.ok((await f.call('/v1/me', { token: user.sessionToken })).data.usage.reservedTokens > 0);
  const second = await f.start({ requestModel: () => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'unrequested', type: 'function', function: { name: 'browser_open', arguments: '{"siteId":"x"}' } }] }, usage }) });
  const denied = await f.call('/v1/inference', { base: second.url, token: user.sessionToken, body: inference('extra-tool-0001') }); assert.equal(denied.data.error.code, 'PROVIDER_UNAVAILABLE');
});

test('验证码错误次数与注册登录速率受限，重启后不能重置验证码尝试', async (t) => {
  const f = await fixture(t), user = await f.register();
  for (let attempt = 0; attempt < 8; attempt++) assert.equal((await f.call('/v1/auth/verify', { token: user.sessionToken, body: { code: 'wrong' } })).data.error.code, 'VERIFICATION_INVALID');
  const second = await f.start();
  assert.equal((await f.call('/v1/auth/verify', { base: second.url, token: user.sessionToken, body: { code: user.demoVerificationCode } })).data.error.code, 'VERIFICATION_INVALID');
  for (let attempt = 0; attempt < 8; attempt++) assert.equal((await f.call('/v1/auth/login', { body: { email: 'missing@example.test', password } })).data.error.code, 'AUTH_FAILED');
  assert.equal((await f.call('/v1/auth/login', { base: second.url, body: { email: 'missing@example.test', password } })).data.error.code, 'RATE_LIMITED');
});

test('推广总预算跨账户和服务实例原子限制，真实模式必须显式设置总预算',async t=>{
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{globalMonthlyTokens:3000,requestModel:async()=>{calls++;await gate;return successful();}}),first=await f.verified(),second=await f.verified();
  const running=f.call('/v1/inference',{token:first.sessionToken,body:inference('global-budget-01')});
  await waitUntil(()=>calls===1);
  const service=await f.start({globalMonthlyTokens:undefined});
  assert.equal((await f.call('/v1/inference',{base:service.url,token:second.sessionToken,body:inference('global-budget-02')})).data.error.code,'PROMOTION_BUDGET_EXCEEDED');
  assert.equal(calls,1);release();await running;
  assert.equal(service.operator.promotionBudget().usedTokens,15);
  assert.equal(service.operator.promotionBudget().reservedTokens,0);
  const normal=await fixture(t,{demo:false,requestModel:()=>successful(),models:[{id:'demo-synthetic',label:'隔离上游'}]}),user=await normal.register();normal.service.operator.verifyAccount(user.account.id);
  assert.equal((await normal.call('/v1/inference',{token:user.sessionToken,body:inference('budget-closed-01')})).data.error.code,'PROMOTION_NOT_AVAILABLE');
  normal.service.operator.setPromotionBudget(10_000);
  assert.equal((await normal.call('/v1/inference',{token:user.sessionToken,body:inference('budget-opened-01')})).status,200);
  const restarted=await normal.start({globalMonthlyTokens:undefined});assert.equal(restarted.operator.promotionBudget().configured,true);
});

test('合成演示默认总预算不能在切成真实模式后冒充开发者授权',async t=>{
  const f=await fixture(t),user=await f.verified();
  const actual=await f.start({demo:false,models:[{id:'demo-synthetic',label:'隔离响应'}],requestModel:()=>successful()});
  assert.equal((await f.call('/v1/inference',{base:actual.url,token:user.sessionToken,body:inference('demo-budget-real1')})).data.error.code,'PROMOTION_NOT_AVAILABLE');
});

test('推广上游适配不在初始化读取密钥，真实调用仅发送服务端白名单模型并限制输出',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-provider-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const secret='synthetic-server-only-api-key',keyFile=join(dir,'provider.key');let calls=0;
  const config={id:'public-model',label:'推广模型',baseUrl:'https://provider.example.invalid/v1',model:'private-route',apiKeyFile:keyFile};
  const upstream=createSponsoredProvider({providers:[config],fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://provider.example.invalid/v1/chat/completions');assert.equal(options.headers.authorization,`Bearer ${secret}`);assert.equal(options.redirect,'error');const input=JSON.parse(options.body);assert.equal(input.model,'private-route');assert.equal(input.max_tokens,1600);assert.equal(input.stream,false);assert.equal(Object.hasOwn(input,'tools'),false);return new Response(JSON.stringify({choices:[{message:successful().message}],usage}));}});
  assert.equal(calls,0);assert.deepEqual(upstream.models,[{id:'public-model',label:'推广模型'}]);
  await assert.rejects(upstream.requestModel({modelId:'public-model',messages:[],tools:[],maxTokens:1600}),/PROVIDER_UNAVAILABLE/);
  assert.equal(calls,0);await writeFile(keyFile,secret);
  const result=await upstream.requestModel({modelId:'public-model',messages:[{role:'user',content:'合成任务'}],tools:[],maxTokens:1600});assert.deepEqual(result.usage,usage);assert.equal(calls,1);
  for(const baseUrl of ['http://provider.invalid','https://user:pass@provider.invalid','https://provider.invalid/v1?key=x','https://provider.invalid/v1/chat/completions'])assert.throws(()=>createSponsoredProvider({providers:[{...config,baseUrl}]}),/PROVIDER_CONFIG_INVALID/);
  const denied=createSponsoredProvider({providers:[config],fetchImpl:async()=>new Response(secret,{status:402})});await assert.rejects(denied.requestModel({modelId:'public-model',messages:[],tools:[],maxTokens:1600}),cause=>cause.status===402&&!cause.message.includes(secret));
});

test('开发者默认微信联系方式可配置，公开目录不包含运营配置路径',async t=>{
  const f=await fixture(t,{developer:undefined}),info=(await f.call('/v1/public')).data;
  assert.deepEqual(info.developer,{name:'开发者',contact:'wsltest',contactType:'wechat'});
  const custom=await f.start({developer:{name:'团队',contact:'configured_wechat',contactType:'wechat'}});assert.equal((await f.call('/v1/public',{base:custom.url})).data.developer.contact,'configured_wechat');
});

test('免费额度按北京时间00点划分日月边界，与主机时区无关',()=>{
  assert.deepEqual(quotaPeriod(Date.parse('2026-11-06T15:59:59.999Z')),{day:'2026-11-06',month:'2026-11'});
  assert.deepEqual(quotaPeriod(Date.parse('2026-11-06T16:00:00.000Z')),{day:'2026-11-07',month:'2026-11'});
  assert.deepEqual(quotaPeriod(Date.parse('2026-11-30T15:59:59.999Z')),{day:'2026-11-30',month:'2026-11'});
  assert.deepEqual(quotaPeriod(Date.parse('2026-11-30T16:00:00.000Z')),{day:'2026-12-01',month:'2026-12'});
  assert.deepEqual(quotaPeriod(Date.parse('2026-12-31T16:00:00.000Z')),{day:'2027-01-01',month:'2027-01'});
});

test('本机运营CLI可以验证停用和调额度，不启动HTTP或读取密钥且不重置活请求预算',async t=>{
  let entered=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{requestModel:async()=>{entered=true;await gate;return successful();}}),user=await f.register();
  const configFile=join(f.dataDir,'operator-config.json');
  await writeFile(configFile,JSON.stringify({dataDir:f.dataDir,demo:false,monthlyTokens:999_999,globalMonthlyTokens:1,providers:[{apiKeyFile:join(f.dataDir,'must-not-exist.key')}]}));
  const script=fileURLToPath(new URL('../scripts/service-admin.mjs',import.meta.url));
  const admin=(...args)=>{const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{...process.env,YUANYU_PROMOTION_CONFIG:configFile},windowsHide:true});assert.equal(result.status,0,result.stderr);for(const secret of ['password_hash','token_hash',password,user.sessionToken,'apiKeyFile'])assert.equal(result.stdout.includes(secret),false);return JSON.parse(result.stdout);};
  assert.equal(admin('list').accounts[0].verified,false);
  assert.equal(admin('verify',user.account.email).account.verified,true);
  assert.equal((await f.call('/v1/public')).data.limits.monthlyTokens,100_000,'管理命令不能悄悄应用配置中的新额度');
  const running=f.call('/v1/inference',{token:user.sessionToken,body:inference('admin-live-0001')});await waitUntil(()=>entered);
  const before=f.service.operator.promotionBudget().reservedTokens;
  assert.equal(admin('quota','50000','12').value.dailyRequests,12);
  assert.equal(admin('budget','70000').value,70000);
  assert.equal(f.service.operator.promotionBudget().reservedTokens,before);
  assert.equal(admin('disable',user.account.email).account.enabled,false);
  release();assert.equal((await running).status,401,'停用账号抑制迟到输出');
  assert.equal(admin('enable',user.account.email).account.enabled,true);
  assert.equal((await f.call('/v1/me',{token:user.sessionToken})).status,401,'重新启用不会恢复被撤销的旧会话');
  const login=await f.call('/v1/auth/login',{body:{email:user.account.email,password}});assert.equal(login.status,200);
  admin('revoke',user.account.email);assert.equal((await f.call('/v1/me',{token:login.data.sessionToken})).status,401);
  assert.equal(f.service.operator.promotionBudget().monthlyTokens,70000);
});
