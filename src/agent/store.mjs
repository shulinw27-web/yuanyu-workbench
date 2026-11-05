import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {isAccountIdentity} from '../product/client.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOTS = new Map();
const COMPANIES = Object.freeze({ alice: 'mock-acme', bob: 'mock-acme', outsider: 'mock-other' });
const STATUSES = new Set(['running', 'awaiting_user', 'interrupted', 'completed', 'failed', 'cancelled']);
const STOPPED = new Set(['interrupted', 'completed', 'failed', 'cancelled']);
const MODES = new Set(['mock_browser', 'compatible_browser']);
const SECRET_TEXT = /(?:\b(?:password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|authorization|cookie|api[_-]?key|otp|mfa[_ -]?code)\s*[:=]|(?:密码|口令|验证码|访问令牌)\s*[:：=]|\bBearer\s+[a-zA-Z0-9._~-]+|\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.|<\/?(?:html|body|script)\b|<!doctype)/i;
const SENSITIVE_LOCATOR = /password|passwd|secret|token|credential|authorization|cookie|username|login|email|otp|mfa|密码|口令|验证码|登录|账号|用户名|提交|删除|审批|支付|付款|保存|submit|delete|approve|pay(?:ment)?|save/i;
const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function assert(value, code = 'AGENT_STORE_INVALID', message = '浏览器任务数据无法验证。') { if (!value) fail(code, message); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function fields(value, allowed) {
  assert(plain(value) && Object.keys(value).every((key) => allowed.includes(key)), 'AGENT_INPUT_INVALID', '浏览器任务包含不支持的字段。');
}
function text(value, max, min = 1) {
  assert(typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
    'AGENT_INPUT_INVALID', '浏览器任务文字格式无效。');
  assert(!SECRET_TEXT.test(value), 'AGENT_SENSITIVE_DATA', '任务与模板不能保存凭据、令牌或原始网页。');
  return value;
}
function identifier(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value), 'AGENT_INPUT_INVALID', '浏览器任务标识无效。');
  return value;
}
function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function identityView(identity) {
  fields(identity, ['companyId', 'userId', 'displayName', 'provider']);
  assert(isAccountIdentity(identity) || identity.provider === 'mock' && Object.hasOwn(COMPANIES, identity.userId) && COMPANIES[identity.userId] === identity.companyId,
    'INVALID_IDENTITY', '仅允许已配置的 Mock 演示身份。');
  return Object.freeze({ companyId: identity.companyId, userId: identity.userId,
    displayName: text(identity.displayName, 80), provider: identity.provider });
}

function bindings(input, mode) {
  assert(Array.isArray(input) && input.length > 0 && input.length <= 12, 'AGENT_BINDINGS_INVALID', '请绑定有限的已验证站点。');
  const result = input.map((entry) => {
    fields(entry, ['id', 'origin', 'revision']);
    identifier(entry.id);
    assert(Number.isSafeInteger(entry.revision) && entry.revision >= 1, 'AGENT_BINDINGS_INVALID', '站点版本无效。');
    let url;
    try { url = new URL(entry.origin); } catch { fail('AGENT_BINDINGS_INVALID', '站点来源无效。'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    assert(url.origin === entry.origin && !url.username && !url.password
      && (url.protocol === 'https:' || (mode === 'mock_browser' && loopback && url.protocol === 'http:')),
    'AGENT_BINDINGS_INVALID', '仅允许精确 HTTPS 来源或本机 Mock 来源。');
    return { id: entry.id, origin: url.origin, revision: entry.revision };
  });
  assert(new Set(result.map((entry) => entry.id)).size === result.length, 'AGENT_BINDINGS_INVALID', '任务站点不能重复。');
  return result;
}

function steps(input) {
  assert(Array.isArray(input) && input.length <= 100, 'AGENT_INPUT_INVALID', '任务步骤格式无效。');
  return input.map((step) => {
    fields(step, ['id', 'label', 'status', 'detail', 'tool', 'siteId']);
    const result = { label: text(step.label, 200), status: step.status };
    assert(['pending', 'planning', 'running', 'executing', 'completed', 'step_completed', 'awaiting_user', 'failed', 'cancelled', 'interrupted'].includes(step.status), 'AGENT_INPUT_INVALID', '任务步骤状态无效。');
    if (step.id !== undefined) result.id = identifier(step.id);
    if (step.detail !== undefined) result.detail = text(step.detail, 1000, 0);
    if (step.tool !== undefined) result.tool = identifier(step.tool);
    if (step.siteId !== undefined) result.siteId = identifier(step.siteId);
    return result;
  });
}

function trace(input, siteBindings) {
  assert(Array.isArray(input) && input.length <= 100, 'AGENT_TRACE_INVALID', '可复用操作超过本机模板范围。');
  const sites = new Set(siteBindings.map((entry) => entry.id));
  return input.map((entry) => {
    fields(entry, ['tool', 'siteId', 'locator', 'value']);
    assert(['open', 'observe', 'click', 'fill', 'select'].includes(entry.tool) && sites.has(entry.siteId), 'AGENT_TRACE_INVALID', '模板仅接受绑定站点的有限只读工具。');
    const result = { tool: entry.tool, siteId: entry.siteId };
    if (['open', 'observe'].includes(entry.tool)) {
      assert(entry.locator === undefined && entry.value === undefined, 'AGENT_TRACE_INVALID', '打开与观察工具不能附带页面数据。');
      return result;
    }
    fields(entry.locator, ['role', 'name', 'readOnly']);
    assert(['button', 'link', 'textbox', 'combobox'].includes(entry.locator.role)
      && entry.locator.readOnly === true, 'AGENT_TRACE_INVALID', '模板动作必须来自已核验的只读控件。');
    const name = text(entry.locator.name, 120).trim();
    assert(name && !SENSITIVE_LOCATOR.test(name), 'AGENT_TRACE_INVALID', '模板不能定位登录、凭据或业务写入控件。');
    if (entry.tool === 'click') {
      assert(['button', 'link'].includes(entry.locator.role) && entry.value === undefined, 'AGENT_TRACE_INVALID', '只读点击格式无效。');
    } else {
      assert((entry.tool === 'fill' && entry.locator.role === 'textbox')
        || (entry.tool === 'select' && entry.locator.role === 'combobox'), 'AGENT_TRACE_INVALID', '只读筛选格式无效。');
      result.value = text(entry.value, 200, 0);
    }
    result.locator = { role: entry.locator.role, name, readOnly: true };
    return result;
  });
}

function parameters(input,recipe){
  assert(Array.isArray(input)&&input.length<=12,'AGENT_PARAMETER_INVALID','最多设置12个查询参数。');
  const names=new Set(),indices=new Set();
  return input.map(entry=>{
    fields(entry,['name','stepIndex','label','defaultValue']);
    assert(typeof entry.name==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(entry.name)&&!['constructor','prototype','__proto__'].includes(entry.name)&&!names.has(entry.name),'AGENT_PARAMETER_INVALID','参数名称须为唯一的小写英文标识。');
    const step=recipe[entry.stepIndex];
    assert(Number.isSafeInteger(entry.stepIndex)&&entry.stepIndex>=0&&step&&['fill','select'].includes(step.tool)&&!indices.has(entry.stepIndex),'AGENT_PARAMETER_INVALID','参数只能绑定成功步骤中的唯一查询或筛选值。');
    const label=text(entry.label,80).trim();assert(label,'AGENT_PARAMETER_INVALID','参数说明不能为空。');
    names.add(entry.name);indices.add(entry.stepIndex);
    return {name:entry.name,stepIndex:entry.stepIndex,label,defaultValue:text(entry.defaultValue??step.value,200,0)};
  });
}
export function resolveSkillParameters(skill,input={}){
  const definitions=parameters(skill.template.parameters??[],skill.template.recipe);
  fields(input,definitions.map(entry=>entry.name));
  return Object.fromEntries(definitions.map(entry=>[entry.name,text(Object.hasOwn(input,entry.name)?input[entry.name]:entry.defaultValue,200,0)]));
}
export function instantiateSkillRecipe(skill,values){
  const resolved=resolveSkillParameters(skill,values),recipe=clone(skill.template.recipe);
  for(const entry of skill.template.parameters??[])recipe[entry.stepIndex].value=resolved[entry.name];
  return trace(recipe,skill.template.siteBindings);
}

function taskView(task) {
  const result = clone(task);
  delete result.sessionId;
  return result;
}
/** Trusted runtime preflight: reject non-replayable inputs before acting on a page. */
export function validateAgentTrace(input, siteBindings) { return trace(input, siteBindings); }
function validateTask(task) {
  fields(task, ['id', 'kind', 'goal', 'mode', 'skillId','skillVersion','parameterValues', 'status', 'steps', 'message', 'error', 'awaitingSiteId', 'trace', 'siteBindings', 'createdAt', 'updatedAt', 'finishedAt', 'sessionId', 'attempt']);
  identifier(task.id);
  assert(task.kind === 'browser' && STATUSES.has(task.status) && MODES.has(task.mode)
    && Number.isSafeInteger(task.attempt) && task.attempt >= 1, 'AGENT_STORE_INVALID', '浏览器任务类型或状态无效。');
  text(task.goal, 2000);
  const siteBindings = bindings(task.siteBindings, task.mode);
  steps(task.steps);
  trace(task.trace, siteBindings);
  for (const key of ['createdAt', 'updatedAt', 'sessionId']) text(task[key], 80);
  if (task.finishedAt !== undefined) text(task.finishedAt, 80);
  if (task.skillId !== undefined) identifier(task.skillId);
  if(task.skillVersion!==undefined)assert(task.skillId&&Number.isSafeInteger(task.skillVersion)&&task.skillVersion>=1,'AGENT_STORE_INVALID','工作流运行版本无效。');
  if(task.parameterValues!==undefined){
    assert(task.skillId&&plain(task.parameterValues)&&Object.keys(task.parameterValues).length<=12,'AGENT_STORE_INVALID','工作流运行参数无效。');
    for(const [name,value]of Object.entries(task.parameterValues)){assert(/^[a-z][a-z0-9_]{0,31}$/.test(name)&&!['constructor','prototype','__proto__'].includes(name));text(value,200,0);}
  }
  if (task.message !== undefined) text(task.message, 2000, 0);
  if (task.error !== undefined) {
    fields(task.error, ['code', 'message']);
    identifier(task.error.code);
    text(task.error.message, 1000);
  }
  if (task.awaitingSiteId !== undefined) {
    assert(task.status === 'awaiting_user' && siteBindings.some((site) => site.id === task.awaitingSiteId), 'AGENT_STORE_INVALID', '待接管站点不属于任务。');
  }
}
function validateSkill(skill) {
  fields(skill, ['id', 'kind', 'name', 'pinned', 'version', 'template', 'source', 'createdAt', 'updatedAt']);
  identifier(skill.id);
  assert(skill.kind === 'browser' && Number.isSafeInteger(skill.version)&&skill.version>=1 && typeof skill.pinned === 'boolean', 'AGENT_STORE_INVALID', '浏览器技能格式无效。');
  assert(text(skill.name, 100).trim(), 'AGENT_STORE_INVALID', '技能名称不能为空。');
  fields(skill.template, ['goalTemplate', 'siteBindings', 'recipe','parameters']);
  text(skill.template.goalTemplate, 2000);
  // HTTP is accepted only for literal loopback synthetic templates; execution must revalidate the current site registry.
  const siteBindings = bindings(skill.template.siteBindings, 'mock_browser');
  assert(Array.isArray(skill.template.recipe) && skill.template.recipe.length > 0, 'AGENT_STORE_INVALID', '技能缺少可回放的操作。');
  trace(skill.template.recipe, siteBindings);
  if(skill.template.parameters!==undefined)parameters(skill.template.parameters,skill.template.recipe);
  fields(skill.source, ['taskId']);
  identifier(skill.source.taskId);
  text(skill.createdAt, 80);
  text(skill.updatedAt, 80);
}

async function directory(target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'AGENT_UNSAFE_PATH', '任务存储目录不安全。');
}
async function readJSON(file) {
  try {
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 5_000_000, 'AGENT_UNSAFE_PATH', '任务存储文件不安全。');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'AGENT_UNSAFE_PATH') throw error;
    fail('AGENT_STORE_INVALID', '浏览器任务存储无法读取。');
  }
}
async function atomicJSON(file, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(encoded) <= 5_000_000, 'AGENT_STORE_LIMIT', '本机任务存储已达大小上限。');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
function rootFor(dataDir) {
  assert(typeof dataDir === 'string' && path.isAbsolute(dataDir), 'AGENT_UNSAFE_PATH', '任务数据目录必须为仓库外绝对路径。');
  const resolved = path.resolve(dataDir);
  assert(!within(REPOSITORY, resolved), 'AGENT_UNSAFE_PATH', '任务数据必须保存在代码仓库外。');
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (!ROOTS.has(key)) ROOTS.set(key, { directory: resolved, sessionId: randomUUID(), tail: Promise.resolve(), ready: undefined });
  return ROOTS.get(key);
}
async function initialize(root) {
  await directory(root.directory);
  root.directory = await fs.realpath(root.directory);
  assert(!within(REPOSITORY, root.directory), 'AGENT_UNSAFE_PATH', '任务数据必须保存在代码仓库外。');
  const lockPath = path.join(root.directory, '.agent-store.lock');
  const existing = await readJSON(lockPath);
  if (existing) {
    assert(Number.isSafeInteger(existing.pid) && existing.pid > 0, 'AGENT_STORE_LOCKED', '任务存储锁无效。');
    let alive = true;
    try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    assert(!alive, 'AGENT_STORE_LOCKED', '任务存储正由其他进程使用。');
    await fs.rm(lockPath);
  }
  try {
    const handle = await fs.open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, sessionId: root.sessionId })); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'EEXIST') fail('AGENT_STORE_LOCKED', '任务存储正由其他进程使用。');
    throw error;
  }
}

/** Trusted main-process API. Site bindings and trace must be built from verified registry/browser output, never IPC payloads. */
export function createAgentStore({ dataDir, identity: inputIdentity } = {}) {
  const identity = identityView(inputIdentity);
  const root = rootFor(dataDir);
  const operation = (callback) => {
    const result = root.tail.then(async () => {
      root.ready ??= initialize(root);
      await root.ready;
      let current = root.directory;
      for (const part of ['agents', identity.companyId, identity.userId]) { current = path.join(current, part); await directory(current); }
      assert(await fs.realpath(current) === current, 'AGENT_UNSAFE_PATH', '个人任务目录不安全。');
      const file = path.join(current, 'state.json');
      const state = await readJSON(file) ?? { schemaVersion: 1, companyId: identity.companyId, userId: identity.userId, tasks: [], skills: [] };
      try {
        fields(state, ['schemaVersion', 'companyId', 'userId', 'tasks', 'skills']);
        assert(state.schemaVersion === 1 && state.companyId === identity.companyId && state.userId === identity.userId
          && Array.isArray(state.tasks) && state.tasks.length <= 1000 && Array.isArray(state.skills) && state.skills.length <= 1000);
        state.tasks.forEach(validateTask);
        state.skills.forEach(validateSkill);
        for (const key of ['tasks', 'skills']) assert(new Set(state[key].map((entry) => entry.id)).size === state[key].length);
        for (const skill of state.skills) assert(state.tasks.some((task) => task.id === skill.source.taskId && task.status === 'completed'), 'AGENT_STORE_INVALID', '技能缺少本人已完成任务来源。');
      } catch (error) {
        if (error.code === 'AGENT_UNSAFE_PATH') throw error;
        fail('AGENT_STORE_INVALID', '浏览器任务存储无法验证。');
      }
      let interrupted = false;
      for (const task of state.tasks) {
        if (task.status === 'running' && task.sessionId !== root.sessionId) {
          Object.assign(task, { status: 'interrupted', message: '上次浏览器任务被中断，请由用户选择继续。', updatedAt: now() });
          task.finishedAt = task.updatedAt;
          interrupted = true;
        }
      }
      if (interrupted) await atomicJSON(file, state);
      return callback(state, () => atomicJSON(file, state));
    });
    root.tail = result.catch(() => {});
    return result;
  };
  const taskById = (state, id) => {
    identifier(id);
    const task = state.tasks.find((entry) => entry.id === id);
    assert(task, 'AGENT_TASK_NOT_FOUND', '当前身份没有此浏览器任务。');
    return task;
  };
  const skillById = (state, id) => {
    identifier(id);
    const skill = state.skills.find((entry) => entry.id === id);
    assert(skill, 'AGENT_SKILL_NOT_FOUND', '当前身份没有此浏览器技能。');
    return skill;
  };
  return Object.freeze({
    listTasks() { return operation((state) => state.tasks.map(taskView).reverse()); },
    listSkills() { return operation((state) => clone(state.skills).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))); },
    createTask(input) {
      return operation(async (state, save) => {
        fields(input, ['goal', 'siteBindings', 'mode', 'skillId','skillVersion','values']);
        assert(MODES.has(input.mode), 'AGENT_INPUT_INVALID', '浏览器任务运行模式无效。');
        const goal = text(input.goal, 2000).trim();
        assert(goal, 'AGENT_INPUT_INVALID', '请说明浏览器任务目标。');
        const siteBindings = bindings(input.siteBindings, input.mode);
        if (input.skillId !== undefined) {
          const skill = skillById(state, input.skillId);
          if(input.skillVersion!==undefined)assert(skill.version===input.skillVersion,'AGENT_SKILL_VERSION_CHANGED','工作流已修订，请重新确认参数后运行。');
          assert(JSON.stringify(skill.template.siteBindings) === JSON.stringify(siteBindings), 'AGENT_BINDINGS_CHANGED', '技能绑定的站点来源或版本已变化，请重新确认。');
        }else assert(input.skillVersion===undefined&&input.values===undefined,'AGENT_PARAMETER_INVALID','参数只能用于已保存的工作流。');
        assert(state.tasks.length < 1000, 'AGENT_STORE_LIMIT', '本机浏览器任务数量已达上限。');
        assert(!state.tasks.some((task) => task.status === 'running' || task.status === 'awaiting_user'), 'AGENT_TASK_ACTIVE', '当前身份已有未结束的浏览器任务。');
        const timestamp = now();
        const task = { id: randomUUID(), kind: 'browser', goal, mode: input.mode, siteBindings,
          status: 'running', steps: [], trace: [], attempt: 1, createdAt: timestamp, updatedAt: timestamp, sessionId: root.sessionId };
        if (input.skillId !== undefined){const skill=skillById(state,input.skillId);task.skillId=input.skillId;task.skillVersion=skill.version;task.parameterValues=resolveSkillParameters(skill,input.values);}
        state.tasks.push(task);
        await save();
        return taskView(task);
      });
    },
    updateTask(id, patch) {
      return operation(async (state, save) => {
        fields(patch, ['status', 'steps', 'message', 'error', 'awaitingSiteId', 'trace', 'expectedAttempt']);
        const task = taskById(state, id);
        assert(!STOPPED.has(task.status), 'AGENT_TASK_TERMINAL', '已停止任务不能接收迟到结果，请由用户显式继续。');
        if (patch.expectedAttempt !== undefined) assert(patch.expectedAttempt === task.attempt, 'AGENT_TASK_STALE', '此结果来自旧一轮任务。');
        assert(STATUSES.has(patch.status), 'AGENT_INPUT_INVALID', '浏览器任务状态无效。');
        assert(task.status === 'running' || patch.status === 'cancelled', 'AGENT_TASK_RESUME_REQUIRED', '人工接管后必须由用户选择继续。');
        const next = clone(task);
        next.status = patch.status;
        if (patch.steps !== undefined) next.steps = steps(patch.steps);
        if (patch.message !== undefined) next.message = text(patch.message, 2000, 0);
        if (patch.trace !== undefined) next.trace = trace(patch.trace, task.siteBindings);
        if (patch.error !== undefined) {
          assert(['failed', 'cancelled', 'interrupted'].includes(patch.status), 'AGENT_INPUT_INVALID', '仅失败或中断任务可以记录错误。');
          fields(patch.error, ['code', 'message']);
          next.error = { code: identifier(patch.error.code), message: text(patch.error.message, 1000) };
        }
        if (patch.awaitingSiteId !== undefined) {
          assert(patch.status === 'awaiting_user' && task.siteBindings.some((site) => site.id === patch.awaitingSiteId), 'AGENT_INPUT_INVALID', '待接管站点不属于任务。');
          next.awaitingSiteId = patch.awaitingSiteId;
        } else if (patch.status !== 'awaiting_user') delete next.awaitingSiteId;
        next.updatedAt = now();
        if (STOPPED.has(next.status)) next.finishedAt = next.updatedAt;
        validateTask(next);
        Object.assign(task, next);
        // Object.assign does not remove optional fields that were deliberately cleared.
        if (next.awaitingSiteId === undefined) delete task.awaitingSiteId;
        await save();
        return taskView(task);
      });
    },
    resumeTask(id) {
      return operation(async (state, save) => {
        const task = taskById(state, id);
        assert(['awaiting_user', 'interrupted', 'failed'].includes(task.status), 'AGENT_TASK_NOT_RESUMABLE', '此任务不能继续。');
        if(task.skillId){const skill=skillById(state,task.skillId);assert((task.skillVersion??1)===skill.version,'AGENT_SKILL_VERSION_CHANGED','工作流已修订，旧运行不能使用新模板继续。');resolveSkillParameters(skill,task.parameterValues);}
        assert(!state.tasks.some((entry) => entry.id !== id && ['running', 'awaiting_user'].includes(entry.status)), 'AGENT_TASK_ACTIVE', '请先结束当前浏览器任务。');
        task.status = 'running';
        task.attempt += 1;
        task.sessionId = root.sessionId;
        task.updatedAt = now();
        delete task.finishedAt;
        delete task.error;
        delete task.awaitingSiteId;
        delete task.message;
        await save();
        return taskView(task);
      });
    },
    saveSkill(input) {
      return operation(async (state, save) => {
        fields(input, ['taskId', 'name', 'pinned']);
        const task = taskById(state, input.taskId);
        assert(task.status === 'completed', 'AGENT_TASK_NOT_COMPLETED', '只有本人已完成的浏览器任务可以保存为技能。');
        const name = text(input.name, 100).trim();
        assert(name && (input.pinned === undefined || typeof input.pinned === 'boolean'), 'AGENT_INPUT_INVALID', '技能名称或置顶状态无效。');
        assert(task.trace.length > 0, 'AGENT_TRACE_REQUIRED', '此任务缺少可安全回放的操作，不能保存为技能。');
        assert(state.skills.length < 1000, 'AGENT_STORE_LIMIT', '本机浏览器技能数量已达上限。');
        const timestamp = now();
        const skill = { id: randomUUID(), kind: 'browser', name, pinned: input.pinned ?? false, version: 1,
          template: { goalTemplate: task.goal, siteBindings: clone(task.siteBindings), recipe: trace(task.trace, task.siteBindings) },
          source: { taskId: task.id }, createdAt: timestamp, updatedAt: timestamp };
        validateSkill(skill);
        state.skills.push(skill);
        await save();
        return clone(skill);
      });
    },
    setSkillPinned(id, pinned) {
      return operation(async (state, save) => {
        assert(typeof pinned === 'boolean', 'AGENT_INPUT_INVALID', '置顶状态必须为布尔值。');
        const skill = skillById(state, id);
        skill.pinned = pinned;
        skill.updatedAt = now();
        await save();
        return clone(skill);
      });
    },
    editSkill(input){
      return operation(async(state,save)=>{
        fields(input,['id','name','parameters','expectedVersion']);
        const skill=skillById(state,input.id);
        assert(input.expectedVersion===skill.version,'AGENT_SKILL_VERSION_CHANGED','工作流已修订，请刷新后修改。');
        assert(input.name!==undefined||input.parameters!==undefined,'AGENT_INPUT_INVALID','请填写要修改的内容。');
        const next=clone(skill);
        if(input.name!==undefined){next.name=text(input.name,100).trim();assert(next.name,'AGENT_INPUT_INVALID','技能名称不能为空。');}
        if(input.parameters!==undefined)next.template.parameters=parameters(input.parameters,next.template.recipe);
        next.version++;next.updatedAt=now();validateSkill(next);
        state.skills[state.skills.indexOf(skill)]=next;await save();return clone(next);
      });
    },
    deleteSkill(id) {
      return operation(async (state, save) => {
        const skill = skillById(state, id);
        state.skills.splice(state.skills.indexOf(skill), 1);
        await save();
        return { deleted: true, id };
      });
    },
  });
}
