import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoModelMessage } from './demo-model.mjs';

const derive = promisify(scrypt), HASH_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_OUTPUT = 1600, BODY_LIMIT = 200_000, SESSION_TTL = 7 * 86400_000;
const TOOL_NAMES = new Set(['propose_workflow_plan', 'browser_open', 'browser_observe', 'browser_act', 'browser_handoff']);
const ERROR_TEXT = {
  INPUT_INVALID: '请求格式无效。', BODY_TOO_LARGE: '请求内容过大。', AUTH_FAILED: '邮箱或密码不正确。',
  ACCOUNT_UNAVAILABLE: '此邮箱暂不能注册，请尝试登录或联系开发者。', AUTH_REQUIRED: '请重新登录。',
  VERIFICATION_REQUIRED: '请先完成邮箱或运营者验证。', VERIFICATION_INVALID: '验证码无效或已过期。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。', MODEL_NOT_ALLOWED: '此模型不在服务允许的列表中。',
  CONSENT_REQUIRED: '请明确同意发送本次任务及所选页面内容。', TOOL_NOT_ALLOWED: '服务不接受此工具。',
  MONTHLY_QUOTA_EXCEEDED: '本月推广额度不足，没有调用模型。', DAILY_REQUEST_LIMIT: '今日请求次数已达上限，没有调用模型。',
  REQUEST_ID_CONFLICT: '此请求编号已用于不同内容，请使用新的请求编号。', REQUEST_PENDING: '同一请求正在处理，请稍后查看；不会重复调用。',
  REQUEST_UNCERTAIN: '原请求用量或结果待核实，预留额度保留；不会自动重新调用。',
  REQUEST_CONTEXT_EXPIRED: '原请求已处理，但临时模型上下文已过期；不会重新调用，请新建任务。',
  INFERENCE_NOT_CONFIGURED: '服务尚未配置真实模型，不会调用付费模型。', PROVIDER_PAYMENT_REQUIRED: '模型提供方拒绝请求：服务额度或套餐不可用；没有自动重试。',
  PROMOTION_NOT_AVAILABLE: '推广额度尚未开放，请使用自有模型或联系开发者。',
  PROMOTION_BUDGET_EXCEEDED: '本月推广总额度不足，请使用自有模型或联系开发者。',
  PROVIDER_AUTH_FAILED: '模型服务配置未通过验证，请联系开发者。', PROVIDER_RATE_LIMITED: '模型提供方限流，请稍后手动重试。',
  PROVIDER_UNAVAILABLE: '模型服务未返回可核对结果，预留额度保留，请联系开发者。', PROVIDER_TIMEOUT: '模型服务超时，用量待核实，预留额度保留。',
  ORIGIN_NOT_ALLOWED: '此网页来源不能访问本机服务。', NOT_FOUND: '接口不存在。', SERVICE_UNAVAILABLE: '服务暂不可用，请稍后重试。', SERVICE_FAILURE: '服务未完成请求，请联系开发者。',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value = Date.now()) => new Date(value).toISOString();
const quotaDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function quotaPeriod(value=Date.now()){
  const parts=Object.fromEntries(quotaDate.formatToParts(new Date(value)).map(part=>[part.type,part.value]));
  const day=`${parts.year}-${parts.month}-${parts.day}`;
  return {day,month:day.slice(0,7)};
}
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (status, code) => Object.assign(new Error(ERROR_TEXT[code] || ERROR_TEXT.SERVICE_FAILURE), { status, code });
const assert = (condition, status = 400, code = 'INPUT_INVALID') => { if (!condition) throw error(status, code); };
const fields = (input, names) => assert(plain(input) && Object.keys(input).every((key) => names.includes(key)));
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const inside = (base, candidate) => { const offset = path.relative(base, candidate); return offset === '' || (!path.isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${path.sep}`)); };
function email(value) {
  assert(typeof value === 'string' && value.length <= 254 && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(value));
  return value.toLowerCase();
}
function accountView(row) { return { id: row.id, email: row.email, displayName: row.display_name, tier: 'personal', verified: row.verified === 1 }; }
function safeMessage(input) {
  // Provider metadata varies across compatible services (refusal, annotations,
  // IDs, etc.). Project only validated conversation fields into the result.
  // Client-supplied messages still use the closed schema in inferenceInput.
  assert(plain(input));
  assert(input.role === 'assistant' && (input.content === null || input.content === undefined || text(input.content, 0, 40_000)));
  const result = { role: 'assistant', content: input.content ?? null };
  if (input.reasoning_content !== undefined && input.reasoning_content !== null) {
    assert(text(input.reasoning_content, 0, 30_000)); result.reasoning_content = input.reasoning_content;
  }
  if (input.tool_calls !== undefined && input.tool_calls !== null) {
    assert(Array.isArray(input.tool_calls) && input.tool_calls.length <= 8);
    result.tool_calls = input.tool_calls.map((call) => {
      fields(call, ['id', 'type', 'function']); fields(call.function, ['name', 'arguments']);
      assert(text(call.id, 1, 100) && call.type === 'function' && TOOL_NAMES.has(call.function.name) && text(call.function.arguments, 1, 12_000));
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  assert(result.content !== null || result.tool_calls?.length > 0);
  return result;
}
function inferenceInput(input, models) {
  fields(input, ['modelId', 'messages', 'tools', 'consent', 'requestId']);
  assert(models.some((model) => model.id === input.modelId), 400, 'MODEL_NOT_ALLOWED');
  assert(typeof input.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(input.requestId));
  fields(input.consent, ['taskText', 'pageContent']);
  assert(input.consent.taskText === true && (input.consent.pageContent === undefined || typeof input.consent.pageContent === 'boolean'), 403, 'CONSENT_REQUIRED');
  assert(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 40);
  for (const message of input.messages) {
    fields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content']);
    assert(['system', 'user', 'assistant', 'tool'].includes(message.role) && (text(message.content, 0, 40_000) || (message.role === 'assistant' && message.content === null)));
    if (message.role === 'tool') assert(input.consent.pageContent === true && text(message.tool_call_id, 1, 100), 403, 'CONSENT_REQUIRED');
    else assert(message.tool_call_id === undefined);
    if (message.reasoning_content !== undefined) assert(message.role === 'assistant' && (message.reasoning_content === null || text(message.reasoning_content, 0, 30_000)));
    if (message.tool_calls !== undefined) safeMessage({ role: message.role, content: message.content, tool_calls: message.tool_calls });
  }
  assert(input.messages.some((message) => message.role === 'user' && message.content.trim().length > 0));
  assert(Array.isArray(input.tools) && input.tools.length <= 5);
  const names = new Set();
  for (const tool of input.tools) {
    fields(tool, ['type', 'function']); fields(tool.function, ['name', 'description', 'parameters', 'strict']);
    assert(tool.type === 'function' && TOOL_NAMES.has(tool.function.name) && !names.has(tool.function.name), 400, 'TOOL_NOT_ALLOWED');
    names.add(tool.function.name);
    assert(plain(tool.function.parameters) && (tool.function.description === undefined || text(tool.function.description, 0, 3000))
      && (tool.function.strict === undefined || typeof tool.function.strict === 'boolean'));
  }
  const payload = JSON.parse(JSON.stringify(input));
  const inputBound = Buffer.byteLength(JSON.stringify({ messages: payload.messages, tools: payload.tools }), 'utf8') + payload.messages.length * 200;
  assert(inputBound + MAX_OUTPUT <= BODY_LIMIT);
  return { payload, digest: hash(canonical(payload)), reservation: inputBound + MAX_OUTPUT, inputBound };
}
async function body(request) {
  assert(request.headers['content-type']?.split(';')[0].trim() === 'application/json');
  const parts = []; let length = 0;
  for await (const part of request) { length += part.length; assert(length <= BODY_LIMIT, 413, 'BODY_TOO_LARGE'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw error(400, 'INPUT_INVALID'); }
}

/** An explicitly configured central account/quota service. It does not grant company identity or execute tools. */
export async function createPromotionService({ dataDir, host = '127.0.0.1', port = 0, demo = true,
  monthlyTokens, dailyRequests, globalMonthlyTokens, developer = { name: '开发者', contact: 'wsltest',contactType:'wechat' },
  requestModel, models, deliverVerification, inferenceTimeoutMs = 30_000 } = {}) {
  assert(typeof dataDir === 'string' && path.isAbsolute(dataDir) && !inside(REPOSITORY, path.resolve(dataDir)));
  assert(typeof demo === 'boolean' && typeof host === 'string' && (!demo || ['127.0.0.1', 'localhost', '::1'].includes(host)));
  const validLimits = (tokens, requests) => Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 1_000_000_000
    && Number.isSafeInteger(requests) && requests >= 0 && requests <= 100_000;
  assert(Number.isInteger(port) && port >= 0 && port <= 65535 && validLimits(monthlyTokens ?? 0, dailyRequests ?? 0));
  assert(globalMonthlyTokens === undefined || Number.isSafeInteger(globalMonthlyTokens) && globalMonthlyTokens >= 0 && globalMonthlyTokens <= 1_000_000_000);
  fields(developer, ['name', 'contact','contactType']); assert(text(developer.name, 1, 100) && text(developer.contact, 0, 500) && (developer.contactType===undefined||developer.contactType==='wechat'));
  assert((requestModel === undefined || typeof requestModel === 'function') && (deliverVerification === undefined || typeof deliverVerification === 'function')
    && Number.isSafeInteger(inferenceTimeoutMs) && inferenceTimeoutMs >= 10 && inferenceTimeoutMs <= 60_000);
  const catalog = models ?? (demo ? [{ id: 'demo-synthetic', label: '本机合成演示（非LLM）' }] : []);
  assert(Array.isArray(catalog) && catalog.length <= 30);
  const publicModels = catalog.map((model) => { fields(model, ['id', 'label']); assert(typeof model.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(model.id) && text(model.label, 1, 100)); return { id: model.id, label: model.label }; });
  assert(new Set(publicModels.map((model) => model.id)).size === publicModels.length);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  assert((await fs.lstat(dataDir)).isDirectory() && !(await fs.lstat(dataDir)).isSymbolicLink());
  dataDir = await fs.realpath(dataDir); assert(!inside(REPOSITORY, dataDir));
  const databaseFile = path.join(dataDir, 'promotion.sqlite');
  try { assert((await fs.lstat(databaseFile)).isFile() && !(await fs.lstat(databaseFile)).isSymbolicLink()); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const db = new DatabaseSync(databaseFile, { timeout: 1000 });
  await fs.chmod(databaseFile, 0o600).catch(() => {});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS verification(account_id TEXT PRIMARY KEY REFERENCES accounts(id),code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auth_rates(rate_key TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(rate_key,bucket));
    CREATE TABLE IF NOT EXISTS service_settings(setting_key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quota(account_id TEXT NOT NULL,month TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,month));
    CREATE TABLE IF NOT EXISTS daily(account_id TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,day));
    CREATE TABLE IF NOT EXISTS requests(account_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,month TEXT NOT NULL,day TEXT NOT NULL,reserved INTEGER NOT NULL,status TEXT NOT NULL,response_json TEXT,error_status INTEGER,error_code TEXT,created_at TEXT NOT NULL,owner_pid INTEGER,owner_instance TEXT,PRIMARY KEY(account_id,request_id));`);
  // A second live service must not invalidate another instance's provider request.
  // Only abandoned process owners become uncertain; their reservation is retained.
  const instanceId = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const requestColumns = new Set(db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name));
    if (!requestColumns.has('owner_pid')) db.exec('ALTER TABLE requests ADD COLUMN owner_pid INTEGER');
    if (!requestColumns.has('owner_instance')) db.exec('ALTER TABLE requests ADD COLUMN owner_instance TEXT');
    for (const owner of db.prepare("SELECT DISTINCT owner_pid FROM requests WHERE status='pending'").all()) {
      let alive = false;
      if (Number.isInteger(owner.owner_pid) && owner.owner_pid > 0) {
        try { process.kill(owner.owner_pid, 0); alive = true; } catch (cause) { alive = cause.code === 'EPERM'; }
      }
      if (!alive) db.prepare("UPDATE requests SET status='uncertain',error_status=409,error_code='REQUEST_UNCERTAIN' WHERE status='pending' AND owner_pid IS ?").run(owner.owner_pid);
    }
    db.exec('COMMIT');
  } catch (cause) { db.exec('ROLLBACK'); db.close(); throw cause; }
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const transaction = (operation) => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (cause) { db.exec('ROLLBACK'); throw cause; } };
  const previousLimits = get("SELECT value FROM service_settings WHERE setting_key='quota'");
  const savedLimits = previousLimits ? JSON.parse(previousLimits.value) : { monthlyTokens: 0, dailyRequests: 0 };
  const initialLimits = { monthlyTokens: monthlyTokens ?? savedLimits.monthlyTokens, dailyRequests: dailyRequests ?? savedLimits.dailyRequests };
  assert(validLimits(initialLimits.monthlyTokens, initialLimits.dailyRequests));
  run("INSERT INTO service_settings(setting_key,value) VALUES('quota',?) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value", JSON.stringify(initialLimits));
  const savedBudget=get("SELECT value FROM service_settings WHERE setting_key='budget'");
  const initialBudget=globalMonthlyTokens??(savedBudget?JSON.parse(savedBudget.value):demo?1_000_000_000:0);
  run("INSERT INTO service_settings(setting_key,value) VALUES('budget',?) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value",JSON.stringify(initialBudget));
  if(globalMonthlyTokens!==undefined)run("INSERT INTO service_settings(setting_key,value) VALUES('budget_explicit','true') ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value");
  const promotionBudget=(month=quotaPeriod().month)=>{
    const monthlyTokens=JSON.parse(get("SELECT value FROM service_settings WHERE setting_key='budget'").value);
    assert(Number.isSafeInteger(monthlyTokens)&&monthlyTokens>=0&&monthlyTokens<=1_000_000_000,503,'SERVICE_UNAVAILABLE');
    const used=get('SELECT COALESCE(SUM(used),0) AS used,COALESCE(SUM(reserved),0) AS reserved FROM quota WHERE month=?',month);
    return {monthlyTokens,usedTokens:used.used,reservedTokens:used.reserved,remainingTokens:Math.max(0,monthlyTokens-used.used-used.reserved),configured:monthlyTokens>0&&(demo||get("SELECT value FROM service_settings WHERE setting_key='budget_explicit'")?.value==='true')};
  };
  const quotaLimits = () => {
    const limits = JSON.parse(get("SELECT value FROM service_settings WHERE setting_key='quota'").value);
    assert(validLimits(limits.monthlyTokens, limits.dailyRequests), 503, 'SERVICE_UNAVAILABLE');
    return { ...limits, configured: limits.monthlyTokens > 0 && limits.dailyRequests > 0 };
  };
  const currentUsage = (accountId) => {
    const { monthlyTokens, dailyRequests } = quotaLimits();
    const {day,month}=quotaPeriod(),quota = get('SELECT used,reserved FROM quota WHERE account_id=? AND month=?', accountId, month);
    return { month, usedTokens: quota?.used ?? 0, reservedTokens: quota?.reserved ?? 0,
      remainingTokens: Math.max(0, monthlyTokens - (quota?.used ?? 0) - (quota?.reserved ?? 0)),
      dailyRequestsUsed: get('SELECT count FROM daily WHERE account_id=? AND day=?', accountId, day)?.count ?? 0, monthlyTokens, dailyRequests };
  };
  const authenticate = (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || ''); assert(match, 401, 'AUTH_REQUIRED');
    const tokenHash = hash(match[1]);
    const account = get('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.revoked=0 AND s.expires_at>? AND a.enabled=1', tokenHash, Date.now());
    assert(account, 401, 'AUTH_REQUIRED'); return { account, tokenHash };
  };
  function rate(request, route, address) {
    const bucket = Math.floor(Date.now() / 900_000), ip = hash(request.socket.remoteAddress || 'unknown');
    transaction(() => {
      for (const [key, maximum] of [[`${route}:ip:${ip}`, 60], [`${route}:email:${hash(address)}`, 8]]) {
        const count = get('SELECT count FROM auth_rates WHERE rate_key=? AND bucket=?', key, bucket)?.count ?? 0;
        assert(count < maximum, 429, 'RATE_LIMITED');
        run('INSERT INTO auth_rates(rate_key,bucket,count) VALUES(?,?,1) ON CONFLICT(rate_key,bucket) DO UPDATE SET count=count+1', key, bucket);
      }
      run('DELETE FROM auth_rates WHERE bucket<?', bucket - 8);
    });
  }
  function newSession(account) {
    const sessionToken = randomBytes(32).toString('base64url'), expiresAt = Date.now() + SESSION_TTL;
    run('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)', hash(sessionToken), account.id, expiresAt);
    return { sessionToken, account: accountView(account), expiresAt: iso(expiresAt) };
  }
  const pending = new Set(), transientResponses = new Map(); let closing = false, authJobs = 0;
  const contextKey=(accountId,requestId)=>`${accountId}:${requestId}`;
  const rememberResponse=(key,response)=>{
    const now=Date.now();
    for(const [id,value] of transientResponses)if(value.expiresAt<=now)transientResponses.delete(id);
    while(transientResponses.size>=128)transientResponses.delete(transientResponses.keys().next().value);
    transientResponses.set(key,{response,expiresAt:now+300_000});
  };
  const passwordHash = async (password, salt) => {
    assert(authJobs < 4, 429, 'RATE_LIMITED'); authJobs++;
    try { return await derive(password, salt, 64, HASH_OPTIONS); } finally { authJobs--; }
  };
  async function infer(request, input) {
    const { account } = authenticate(request); assert(account.verified === 1, 403, 'VERIFICATION_REQUIRED');
    assert(demo || requestModel, 503, 'INFERENCE_NOT_CONFIGURED');
    const { payload, digest, reservation, inputBound } = inferenceInput(input, publicModels);
    const {day,month}=quotaPeriod();
    const prior = transaction(() => {
      const previous = get('SELECT * FROM requests WHERE account_id=? AND request_id=?', account.id, payload.requestId);
      if (previous) { assert(previous.payload_hash === digest, 409, 'REQUEST_ID_CONFLICT'); return previous; }
      const { monthlyTokens, dailyRequests, configured } = quotaLimits();
      assert(configured, 503, 'PROMOTION_NOT_AVAILABLE');
      const budget=promotionBudget(month);
      assert(budget.configured,503,'PROMOTION_NOT_AVAILABLE');
      assert(reservation<=budget.remainingTokens,402,'PROMOTION_BUDGET_EXCEEDED');
      run('INSERT INTO quota(account_id,month) VALUES(?,?) ON CONFLICT DO NOTHING', account.id, month);
      const quota = get('SELECT used,reserved FROM quota WHERE account_id=? AND month=?', account.id, month);
      assert(quota.used + quota.reserved + reservation <= monthlyTokens, 402, 'MONTHLY_QUOTA_EXCEEDED');
      const count = get('SELECT count FROM daily WHERE account_id=? AND day=?', account.id, day)?.count ?? 0;
      assert(count < dailyRequests, 429, 'DAILY_REQUEST_LIMIT');
      run('INSERT INTO requests(account_id,request_id,payload_hash,month,day,reserved,status,created_at,owner_pid,owner_instance) VALUES(?,?,?,?,?,?,?,?,?,?)', account.id, payload.requestId, digest, month, day, reservation, 'pending', iso(), process.pid, instanceId);
      run('UPDATE quota SET reserved=reserved+? WHERE account_id=? AND month=?', reservation, account.id, month);
      run('INSERT INTO daily(account_id,day,count) VALUES(?,?,1) ON CONFLICT(account_id,day) DO UPDATE SET count=count+1', account.id, day);
      return undefined;
    });
    if (prior) {
      if (prior.response_json) {
        const saved=JSON.parse(prior.response_json);
        if(saved.requiresTransientContext){
          const cached=transientResponses.get(contextKey(account.id,payload.requestId));
          assert(cached&&cached.expiresAt>Date.now(),409,'REQUEST_CONTEXT_EXPIRED');
          return cached.response;
        }
        return saved;
      }
      throw error(prior.error_status || 409, prior.error_code || 'REQUEST_PENDING');
    }
    const controller = new AbortController(); pending.add(controller);
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => requestModel ? requestModel({ modelId: payload.modelId, messages: payload.messages, tools: payload.tools, maxTokens: MAX_OUTPUT, signal: controller.signal }) : {
          message: demoModelMessage(payload), usage: { prompt_tokens: Math.min(inputBound, Math.max(1, Math.ceil(inputBound / 4))), completion_tokens: 100, total_tokens: Math.min(inputBound, Math.max(1, Math.ceil(inputBound / 4))) + 100 },
        }),
        new Promise((_, reject) => {
          const stop = () => reject(error(504, 'PROVIDER_TIMEOUT'));
          controller.signal.addEventListener('abort', stop, { once: true });
          timer = setTimeout(() => controller.abort(), inferenceTimeoutMs);
        }),
      ]);
      authenticate(request); // Revocation while the provider was running suppresses its late output.
      const message = safeMessage(result?.message);
      const allowedTools = new Set(payload.tools.map((tool) => tool.function.name));
      assert(!message.tool_calls?.some((call) => !allowedTools.has(call.function.name)), 502, 'PROVIDER_UNAVAILABLE');
      const usage = result?.usage;
      const valid = plain(usage) && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
        && usage.prompt_tokens > 0 && usage.prompt_tokens <= inputBound && usage.completion_tokens <= MAX_OUTPUT
        && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens && usage.total_tokens <= reservation;
      const response = { requestId: payload.requestId, status: valid ? 'completed' : 'usage_pending', message,
        usage: valid ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null, synthetic: demo && !requestModel };
      // Provider reasoning is an opaque, request-scoped continuation field. Preserve
      // it for the current tool loop without writing it to the billing database.
      const persistent=structuredClone(response);
      if(typeof message.reasoning_content==='string'){
        delete persistent.message.reasoning_content;persistent.requiresTransientContext=true;
      }
      transaction(() => {
        const current = get('SELECT status,owner_instance FROM requests WHERE account_id=? AND request_id=?', account.id, payload.requestId);
        assert(current?.status === 'pending' && current.owner_instance === instanceId, 409, 'REQUEST_UNCERTAIN');
        if (valid) run('UPDATE quota SET reserved=reserved-?,used=used+? WHERE account_id=? AND month=?', reservation, usage.total_tokens, account.id, month);
        run('UPDATE requests SET status=?,response_json=? WHERE account_id=? AND request_id=?', valid ? 'completed' : 'usage_pending', JSON.stringify(persistent), account.id, payload.requestId);
      });
      if(persistent.requiresTransientContext)rememberResponse(contextKey(account.id,payload.requestId),response);
      return response;
    } catch (cause) {
      const code = cause.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : cause.code === 'PROVIDER_TIMEOUT' || controller.signal.aborted ? 'PROVIDER_TIMEOUT'
        : cause.status === 402 ? 'PROVIDER_PAYMENT_REQUIRED' : [401, 403].includes(cause.status) ? 'PROVIDER_AUTH_FAILED' : cause.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE';
      const status = code === 'AUTH_REQUIRED' ? 401 : code === 'PROVIDER_TIMEOUT' ? 504 : code === 'PROVIDER_PAYMENT_REQUIRED' ? 402 : code === 'PROVIDER_RATE_LIMITED' ? 429 : 502;
      run("UPDATE requests SET status='uncertain',error_status=?,error_code=? WHERE account_id=? AND request_id=? AND status='pending'", status, code, account.id, payload.requestId);
      throw error(status, code);
    } finally { clearTimeout(timer); pending.delete(controller); }
  }
  async function handle(request) {
    assert(!closing, 503, 'SERVICE_UNAVAILABLE');
    const url = new URL(request.url, 'http://local.invalid'); assert(!url.search && !url.hash, 404, 'NOT_FOUND');
    if (request.headers.origin) assert(request.headers.origin === serviceUrl, 403, 'ORIGIN_NOT_ALLOWED');
    if (request.method === 'GET' && url.pathname === '/v1/public') return { deployment: demo ? 'local_demo' : 'configured', developer: { name: developer.name, contact: developer.contact,contactType:developer.contactType||'wechat' },
      limits: quotaLimits(),quotaTimeZone:'Asia/Shanghai', promotionBudget:{configured:promotionBudget().configured}, models: publicModels, registration: { enabled: true, verification: demo ? 'demo_code' : deliverVerification ? 'email' : 'operator_required',
        notice: demo ? '本机合成注册演示，未上线真实实名或邮件验证。' : deliverVerification ? '邮件验证由已配置的可信投递器处理，生产实名未接入。' : '真实邮件与实名服务未上线，注册后需联系运营者验证。' } };
    if (request.method === 'GET' && url.pathname === '/v1/me') { const { account } = authenticate(request); return { account: accountView(account), usage: currentUsage(account.id) }; }
    assert(request.method === 'POST', 404, 'NOT_FOUND');
    if (url.pathname === '/v1/auth/register') {
      const input = await body(request); fields(input, ['email', 'password', 'name']);
      const address = email(input.email); assert(text(input.password, 12, 128) && text(input.name, 1, 80) && input.name.trim().length > 0);
      rate(request, 'register', address);
      assert(!get('SELECT id FROM accounts WHERE email=?', address), 409, 'ACCOUNT_UNAVAILABLE');
      const salt = randomBytes(24).toString('hex'), derived = await passwordHash(input.password, salt), id = randomUUID();
      const code = randomBytes(24).toString('base64url'), expiresAt = Date.now() + 1800_000;
      transaction(() => {
        assert(!get('SELECT id FROM accounts WHERE email=?', address), 409, 'ACCOUNT_UNAVAILABLE');
        run('INSERT INTO accounts(id,email,display_name,salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', id, address, input.name.trim(), salt, derived.toString('hex'), iso());
        run('INSERT INTO verification(account_id,code_hash,expires_at) VALUES(?,?,?)', id, hash(`${id}:${code}`), expiresAt);
      });
      const response = newSession(get('SELECT * FROM accounts WHERE id=?', id));
      if (demo) response.demoVerificationCode = code;
      else if (deliverVerification) {
        try { await deliverVerification({ email: address, name: input.name.trim(), code, expiresAt: iso(expiresAt) }); }
        catch { response.verification = 'operator_required'; }
      }
      return response;
    }
    if (url.pathname === '/v1/auth/login') {
      const input = await body(request); fields(input, ['email', 'password']);
      let address; try { address = email(input.email); } catch { address = 'invalid@example.invalid'; }
      rate(request, 'login', address);
      const account = get('SELECT * FROM accounts WHERE email=?', address);
      const acceptable = text(input.password, 12, 128);
      const candidate = await passwordHash(acceptable ? input.password : 'invalid-password-placeholder', account?.salt || '000000000000000000000000000000000000000000000000');
      const expected = account ? Buffer.from(account.password_hash, 'hex') : Buffer.alloc(64);
      assert(account?.enabled === 1 && acceptable && expected.length === candidate.length && timingSafeEqual(expected, candidate), 401, 'AUTH_FAILED');
      const current=get('SELECT * FROM accounts WHERE id=?',account.id);
      assert(current?.enabled===1&&current.password_hash===account.password_hash,401,'AUTH_FAILED');
      return newSession(current);
    }
    if (url.pathname === '/v1/auth/verify') {
      const { account } = authenticate(request), input = await body(request); fields(input, ['code']);
      authenticate(request);
      assert(text(input.code, 1, 100), 400, 'VERIFICATION_INVALID');
      transaction(() => {
        const challenge = get('SELECT * FROM verification WHERE account_id=?', account.id);
        assert(challenge && challenge.expires_at > Date.now() && challenge.attempts < 8, 400, 'VERIFICATION_INVALID');
        run('UPDATE verification SET attempts=attempts+1 WHERE account_id=?', account.id);
      });
      const challenge = get('SELECT * FROM verification WHERE account_id=?', account.id);
      assert(timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(hash(`${account.id}:${input.code}`), 'hex')), 400, 'VERIFICATION_INVALID');
      transaction(() => { run('UPDATE accounts SET verified=1 WHERE id=?', account.id); run('DELETE FROM verification WHERE account_id=?', account.id); });
      return { account: accountView(get('SELECT * FROM accounts WHERE id=?', account.id)) };
    }
    if (url.pathname === '/v1/auth/logout') { const session = authenticate(request); fields(await body(request), []); run('UPDATE sessions SET revoked=1 WHERE token_hash=?', session.tokenHash); return { loggedOut: true }; }
    if (url.pathname === '/v1/inference') return infer(request, await body(request));
    throw error(404, 'NOT_FOUND');
  }
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    handle(request).then((data) => {
      response.writeHead(request.url === '/v1/auth/register' ? 201 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(data));
    }, (cause) => {
      const status = Number.isInteger(cause.status) ? cause.status : cause.code === 'ERR_SQLITE_ERROR' ? 503 : 500;
      const code = ERROR_TEXT[cause.code] ? cause.code : status === 503 ? 'SERVICE_UNAVAILABLE' : 'SERVICE_FAILURE';
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ error: { code, message: ERROR_TEXT[code] } }));
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); }); }
  catch (cause) { db.close(); throw cause; }
  const address = server.address(), serviceUrl = `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`;
  return Object.freeze({ url: serviceUrl,
    close: async () => { if (closing) return; closing = true; for (const controller of pending) controller.abort(); await new Promise((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve())); transientResponses.clear(); db.close(); },
    operator: Object.freeze({
      setPromotionBudget(monthlyTokens){assert(Number.isSafeInteger(monthlyTokens)&&monthlyTokens>=0&&monthlyTokens<=1_000_000_000);transaction(()=>{run("UPDATE service_settings SET value=? WHERE setting_key='budget'",JSON.stringify(monthlyTokens));run("INSERT INTO service_settings(setting_key,value) VALUES('budget_explicit','true') ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value");});return promotionBudget();},
      promotionBudget,
      setQuota(input) { fields(input, ['monthlyTokens', 'dailyRequests']); assert(validLimits(input.monthlyTokens, input.dailyRequests));
        transaction(() => run("UPDATE service_settings SET value=? WHERE setting_key='quota'", JSON.stringify({ monthlyTokens: input.monthlyTokens, dailyRequests: input.dailyRequests })));
        return quotaLimits(); },
      verifyAccount(id) { assert(text(id, 1, 100) && get('SELECT id FROM accounts WHERE id=?', id), 404, 'NOT_FOUND'); transaction(() => { run('UPDATE accounts SET verified=1 WHERE id=?', id); run('DELETE FROM verification WHERE account_id=?', id); }); return accountView(get('SELECT * FROM accounts WHERE id=?', id)); },
      revokeSessions(id) { assert(text(id, 1, 100)); return { revoked: Number(run('UPDATE sessions SET revoked=1 WHERE account_id=?', id).changes) }; },
      setAccountEnabled(id, enabled) { assert(text(id, 1, 100) && typeof enabled === 'boolean' && get('SELECT id FROM accounts WHERE id=?', id), 404, 'NOT_FOUND'); transaction(() => { run('UPDATE accounts SET enabled=? WHERE id=?', enabled ? 1 : 0, id); if (!enabled) run('UPDATE sessions SET revoked=1 WHERE account_id=?', id); }); return { enabled }; },
    }),
  });
}
