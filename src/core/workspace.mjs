import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecipeCatalog, validateWorkflowTemplate } from './recipe-catalog.mjs';
import {isAccountIdentity} from '../product/client.mjs';

const SCHEMA_VERSION = 2;
const SHARED_SCHEMA_VERSION = 1;
const TEMPLATE_VERSION = 1;
const RECIPE_ID = 'purchase-monthly';
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = new Map();
const IDENTITIES = { alice: 'mock-acme', bob: 'mock-acme', outsider: 'mock-other' };
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const SECRET_KEY = /password|passwd|cipher|token|secret|credential|authorization|cookie/i;
const SUMMARY_FIELDS = ['month', 'orderCount', 'receiptCount', 'orderedCents', 'receivedCents', 'outstandingCents',
  'unmatchedCount', 'partialCount', 'overReceivedCount', 'excludedOrderCount', 'ignoredReceiptCount'];

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assert(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fields(value, allowed) {
  assert(plain(value), 'INVALID_INPUT', '输入必须为普通对象。');
  assert(Object.keys(value).every((key) => allowed.includes(key)), 'INVALID_INPUT', '输入包含不支持的字段。');
}

function string(value, max = 200, min = 1) {
  assert(typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value),
    'INVALID_INPUT', '字符串格式不正确。');
  return value;
}

function identifier(value) {
  string(value, 100);
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value), 'INVALID_INPUT', '标识格式不正确。');
  return value;
}

function month(value) {
  assert(typeof value === 'string' && /^(20\d\d)-(0[1-9]|1[0-2])$/.test(value), 'INVALID_MONTH', '月份格式应为 YYYY-MM。');
  return value;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function clone(value) { return structuredClone(value); }
function now() { return new Date().toISOString(); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeMetadata(value, depth = 0) {
  assert(depth <= 7, 'INVALID_INPUT', '元数据层级过多。');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'INVALID_INPUT', '元数据数字无效。');
    return value;
  }
  if (typeof value === 'string') return string(value, 3000, 0);
  if (Array.isArray(value)) {
    assert(value.length <= 100, 'INVALID_INPUT', '元数据项目过多。');
    return value.map((item) => safeMetadata(item, depth + 1));
  }
  assert(plain(value), 'INVALID_INPUT', '元数据格式不正确。');
  assert(Object.keys(value).length <= 60, 'INVALID_INPUT', '元数据字段过多。');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    assert(!SECRET_KEY.test(key) && !['__proto__', 'constructor', 'prototype', 'rows'].includes(key),
      'SENSITIVE_METADATA', '元数据不能包含凭据或原始数据。');
    string(key, 100);
    result[key] = safeMetadata(entry, depth + 1);
  }
  assert(JSON.stringify(result).length <= 30_000, 'INVALID_INPUT', '元数据过大。');
  return result;
}

function validateIdentity(identity) {
  fields(identity, ['companyId', 'userId', 'displayName', 'provider']);
  assert(isAccountIdentity(identity) || identity.provider === 'mock' && Object.hasOwn(IDENTITIES,identity.userId) && IDENTITIES[identity.userId] === identity.companyId,
    'INVALID_IDENTITY', '仅允许已配置的 Mock 演示身份。');
  return Object.freeze({ companyId: identity.companyId, userId: identity.userId,
    displayName: string(identity.displayName, 80), provider: identity.provider });
}

function validateSystems(systems) {
  assert(plain(systems) && Object.keys(systems).length > 0, 'INVALID_SYSTEM', '系统白名单不能为空。');
  const result = Object.create(null);
  for (const [key, value] of Object.entries(systems)) {
    identifier(key);
    assert(plain(value) && value.id === key, 'INVALID_SYSTEM', '系统标识与白名单不一致。');
    let url;
    try { url = new URL(value.origin); } catch { throw failure('INVALID_SYSTEM', '系统来源无效。'); }
    assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && value.origin === url.origin, 'INVALID_SYSTEM', '系统来源必须为固定 HTTP 来源。');
    result[key] = Object.freeze({ id: key, label: string(value.label, 100), origin: url.origin });
  }
  return Object.freeze(result);
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH', '工作区目录不安全。');
}

async function trustedFile(filename, maxSize = 5_000_000) {
  const stat = await fs.lstat(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxSize, 'UNSAFE_PATH', '工作区文件不安全。');
  return stat;
}

async function readJSON(filename) {
  try {
    await trustedFile(filename);
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'UNSAFE_PATH') throw error;
    throw failure('STORE_INVALID', '工作区数据无法验证，请保留原文件后检查。');
  }
}

async function atomicJSON(filename, value) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function initializeRoot(root) {
  await ensureDirectory(root.directory);
  root.directory = await fs.realpath(root.directory);
  assert(!within(REPOSITORY, root.directory), 'UNSAFE_PATH', '运行数据必须保存在代码仓库外。');
  const lockPath = path.join(root.directory, '.workspace.lock');
  try {
    const existing = await readJSON(lockPath);
    if (existing) {
      assert(Number.isInteger(existing.pid) && existing.pid > 0, 'WORKSPACE_LOCKED', '工作区锁无法验证。');
      let alive = true;
      try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      assert(!alive, 'WORKSPACE_LOCKED', '此工作区已由其他实例打开。');
      await fs.rm(lockPath);
    }
    const lock = await fs.open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, sessionId: root.sessionId }));
    await lock.close();
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('WORKSPACE_LOCKED', '此工作区已由其他实例打开。');
    throw error;
  }
  const keyPath = path.join(root.directory, '.publication-key');
  try {
    const handle = await fs.open(keyPath, 'wx', 0o600);
    await handle.writeFile(randomBytes(32));
    await handle.sync();
    await handle.close();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await trustedFile(keyPath, 32);
  root.key = await fs.readFile(keyPath);
  assert(root.key.length === 32, 'STORE_INVALID', '模板来源校验密钥无效。');
  await ensureDirectory(path.join(root.directory, 'companies'));
}

function getRoot(directory) {
  assert(typeof directory === 'string' && path.isAbsolute(directory), 'UNSAFE_PATH', 'dataDir 必须为仓库外的绝对路径。');
  const resolved = path.resolve(directory);
  assert(!within(REPOSITORY, resolved), 'UNSAFE_PATH', '运行数据必须保存在代码仓库外。');
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (!roots.has(key)) roots.set(key, { directory: resolved, tail: Promise.resolve(), sessionId: randomUUID(), ready: undefined });
  return roots.get(key);
}

function enqueue(root, operation) {
  const result = root.tail.then(async () => {
    root.ready ??= initializeRoot(root);
    await root.ready;
    return operation();
  });
  root.tail = result.catch(() => {});
  return result;
}

function signature(root, payload) { return createHmac('sha256', root.key).update(canonical(payload)).digest('hex'); }

function verifyPublication(root, publication, companyId) {
  try {
    fields(publication, ['id', 'version', 'companyId', 'publisher', 'workflowId', 'workflowVersion', 'publishedAt', 'template', 'signature']);
    identifier(publication.id);
    identifier(publication.workflowId);
    if (publication.workflowVersion !== undefined) revisionNumber(publication.workflowVersion);
    assert(publication.version === TEMPLATE_VERSION && publication.companyId === companyId,
      'INVALID_PUBLICATION', '模板版本或公司来源无效。');
    fields(publication.publisher, ['userId', 'displayName', 'provider']);
    assert(publication.publisher.provider === 'mock' && IDENTITIES[publication.publisher.userId] === companyId,
      'INVALID_PUBLICATION', '发布者身份无效。');
    string(publication.publisher.displayName, 80);
    string(publication.publishedAt, 40);
    validateWorkflowTemplate(publication.template);
    assert(publication.template.version === TEMPLATE_VERSION, 'INVALID_PUBLICATION', '模板格式版本无效。');
    assert(typeof publication.signature === 'string' && /^[a-f0-9]{64}$/.test(publication.signature),
      'INVALID_PUBLICATION', '模板来源签名无效。');
    const { signature: actual, ...payload } = publication;
    assert(timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(signature(root, payload), 'hex')),
      'INVALID_PUBLICATION', '模板来源签名无法验证。');
    return publication;
  } catch (error) {
    if (error.code === 'INVALID_PUBLICATION') throw error;
    throw failure('INVALID_PUBLICATION', '模板内容或来源无法验证。');
  }
}

function credentialView(credential, systems) {
  const system = systems[credential.systemId];
  return { id: credential.id, systemId: credential.systemId, label: system.label,
    usernameMasked: credential.usernameMasked, username: credential.usernameMasked,
    origin: credential.origin, needsRebind: credential.origin !== system.origin, updatedAt: credential.updatedAt };
}

function summaryMetadata(input, runMonth) {
  fields(input, SUMMARY_FIELDS);
  assert(input.month === runMonth, 'INVALID_INPUT', '汇总月份与运行不一致。');
  const result = { month: runMonth };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'month') continue;
    assert(Number.isSafeInteger(value) && value >= 0, 'INVALID_INPUT', '运行汇总只能保存非负整数统计。');
    result[key] = value;
  }
  return result;
}

function storedArtifact(input, root, identity) {
  fields(input, ['id', 'path', 'name', 'mime', 'bytes', 'sha256', 'sourcePath']);
  const outputDirectory = path.join(root.directory, 'outputs', identity.companyId, identity.userId);
  for (const key of ['path', 'sourcePath']) {
    if (input[key] === undefined && key === 'sourcePath') continue;
    string(input[key], 2000);
    assert(path.isAbsolute(input[key]) && within(outputDirectory, path.resolve(input[key])), 'UNSAFE_ARTIFACT', '产物不属于当前用户输出目录。');
  }
  assert(input.name === path.basename(input.path) && input.mime === 'text/csv'
    && Number.isSafeInteger(input.bytes) && input.bytes >= 0
    && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256), 'STORE_INVALID', '产物元数据无效。');
  if (input.id !== undefined) identifier(input.id);
  return clone(input);
}

function runView(run) {
  const result = {};
  for (const key of ['id', 'month', 'workflowId', 'workflowVersion', 'status', 'steps', 'createdAt', 'updatedAt', 'finishedAt', 'artifact', 'summary', 'error']) {
    if (run[key] !== undefined) result[key] = clone(run[key]);
  }
  return result;
}

function workflowView(workflow) { return clone(workflow); }

function revisionNumber(value) {
  assert(Number.isSafeInteger(value) && value >= 1, 'INVALID_INPUT', '技能版本必须为正整数。');
  return value;
}

function revision(workflow, change, restoredFrom) {
  const entry = { workflowId: workflow.id, version: workflow.version, name: workflow.name,
    description: workflow.description, recipeId: workflow.recipeId, parameters: clone(workflow.parameters),
    enabled: workflow.enabled, createdAt: workflow.updatedAt, change };
  if (restoredFrom !== undefined) entry.restoredFrom = restoredFrom;
  return entry;
}

function validateRevision(entry) {
  fields(entry, ['workflowId', 'version', 'name', 'description', 'recipeId', 'parameters', 'enabled', 'createdAt', 'change', 'restoredFrom']);
  identifier(entry.workflowId);
  revisionNumber(entry.version);
  validateWorkflowTemplate({ name: entry.name, description: entry.description, recipeId: entry.recipeId, parameters: entry.parameters });
  assert(typeof entry.enabled === 'boolean' && ['created', 'imported', 'migrated', 'edited', 'restored', 'enabled', 'disabled'].includes(entry.change),
    'STORE_INVALID', '技能历史记录无效。');
  string(entry.createdAt, 40);
  if (entry.restoredFrom !== undefined) {
    revisionNumber(entry.restoredFrom);
    assert(entry.change === 'restored' && entry.restoredFrom < entry.version, 'STORE_INVALID', '恢复来源版本无效。');
  }
}

function sameRevision(workflow, entry) {
  return ['name', 'description', 'recipeId', 'enabled', 'version'].every((key) => workflow[key] === entry[key])
    && canonical(workflow.parameters) === canonical(entry.parameters);
}

function validateWorkflow(root, workflow, companyId) {
  fields(workflow, ['id', 'name', 'description', 'recipeId', 'parameters', 'pinned', 'enabled', 'version', 'verified', 'createdAt', 'updatedAt', 'verifiedAt', 'source']);
  identifier(workflow.id);
  string(workflow.name, 100);
  assert(workflow.name.trim().length > 0, 'STORE_INVALID', '技能名称不能为空。');
  string(workflow.description, 2000, 0);
  fields(workflow.parameters, ['month']);
  month(workflow.parameters.month);
  revisionNumber(workflow.version);
  assert(workflow.recipeId === RECIPE_ID && typeof workflow.enabled === 'boolean'
    && typeof workflow.pinned === 'boolean' && typeof workflow.verified === 'boolean'
    && (!workflow.verified || workflow.enabled), 'STORE_INVALID', '个人技能版本无效。');
  string(workflow.createdAt, 40);
  string(workflow.updatedAt, 40);
  if (workflow.verifiedAt !== undefined) string(workflow.verifiedAt, 40);
  assert(plain(workflow.source), 'STORE_INVALID', '个人技能来源无效。');
  if (workflow.source.kind === 'completed-run') {
    fields(workflow.source, ['kind', 'runId']);
    identifier(workflow.source.runId);
  } else {
    fields(workflow.source, ['kind', 'publication']);
    assert(workflow.source.kind === 'company-template', 'STORE_INVALID', '个人技能来源无效。');
    verifyPublication(root, workflow.source.publication, companyId);
  }
}

async function context(root, identity, systems) {
  const companyDirectory = path.join(root.directory, 'companies', identity.companyId);
  const userDirectory = path.join(companyDirectory, 'users', identity.userId);
  for (const directory of [companyDirectory, path.join(companyDirectory, 'users'), userDirectory]) await ensureDirectory(directory);
  assert(await fs.realpath(userDirectory) === userDirectory, 'UNSAFE_PATH', '个人数据路径不安全。');
  const statePath = path.join(userDirectory, 'state.json');
  const sharedPath = path.join(companyDirectory, 'publications.json');
  const state = await readJSON(statePath) ?? { schemaVersion: SCHEMA_VERSION, companyId: identity.companyId, userId: identity.userId, credentials: [], workflows: [], workflowVersions: [], runs: [] };
  let migrated = false;
  try {
    fields(state, ['schemaVersion', 'companyId', 'userId', 'credentials', 'workflows', 'workflowVersions', 'runs']);
    assert([1, SCHEMA_VERSION].includes(state.schemaVersion) && state.companyId === identity.companyId && state.userId === identity.userId,
      'STORE_INVALID', '个人数据身份或版本不一致。');
    for (const key of ['credentials', 'workflows', 'runs']) assert(Array.isArray(state[key]) && state[key].length <= 10_000, 'STORE_INVALID', '个人数据格式无效。');
    if (state.schemaVersion === 1) {
      assert(state.workflowVersions === undefined, 'STORE_INVALID', '旧版本不能携带自定义历史。');
      for (const workflow of state.workflows) {
        assert(workflow.version === 1 && workflow.description === undefined && workflow.enabled === undefined, 'STORE_INVALID', '旧技能版本无效。');
        Object.assign(workflow, { description: '', enabled: true });
      }
      state.workflowVersions = state.workflows.map((workflow) => revision(workflow, 'migrated'));
      for (const run of state.runs) {
        assert(run.workflowVersion === undefined, 'STORE_INVALID', '旧运行不能携带自定义版本。');
        if (run.workflowId !== undefined) run.workflowVersion = 1;
      }
      state.schemaVersion = SCHEMA_VERSION;
      migrated = true;
    }
    assert(Array.isArray(state.workflowVersions) && state.workflowVersions.length <= 10_000, 'STORE_INVALID', '技能历史格式无效。');
    const systemIds = new Set();
    for (const credential of state.credentials) {
      fields(credential, ['id', 'systemId', 'origin', 'usernameMasked', 'ciphertext', 'updatedAt']);
      identifier(credential.id);
      assert(systems[credential.systemId] && !systemIds.has(credential.systemId), 'STORE_INVALID', '凭据系统来源无效。');
      systemIds.add(credential.systemId);
      const credentialOrigin = new URL(credential.origin);
      assert(['http:', 'https:'].includes(credentialOrigin.protocol) && credentialOrigin.origin === credential.origin,
        'STORE_INVALID', '凭据绑定来源无效。');
      assert(credential.usernameMasked === '••••', 'STORE_INVALID', '凭据显示名称必须保持脱敏。');
      string(credential.ciphertext, 100_000);
      string(credential.updatedAt, 40);
    }
    for (const workflow of state.workflows) validateWorkflow(root, workflow, identity.companyId);
    for (const entry of state.workflowVersions) {
      validateRevision(entry);
      assert(state.workflows.some((workflow) => workflow.id === entry.workflowId), 'STORE_INVALID', '技能历史没有所属技能。');
    }
    for (const run of state.runs) {
      fields(run, ['id', 'month', 'workflowId', 'workflowVersion', 'status', 'steps', 'createdAt', 'updatedAt', 'finishedAt', 'artifact', 'summary', 'error', 'sessionId']);
      identifier(run.id);
      month(run.month);
      if (run.workflowId !== undefined) {
        identifier(run.workflowId);
        revisionNumber(run.workflowVersion);
      } else assert(run.workflowVersion === undefined, 'STORE_INVALID', '运行版本缺少技能标识。');
      string(run.createdAt, 40);
      string(run.updatedAt, 40);
      assert(run.status === 'running' || TERMINAL.has(run.status), 'STORE_INVALID', '运行状态无效。');
      safeMetadata(run.steps);
      if (run.summary !== undefined) summaryMetadata(run.summary, run.month);
      if (run.error !== undefined) safeMetadata(run.error);
      if (run.artifact !== undefined) storedArtifact(run.artifact, root, identity);
    }
    for (const workflow of state.workflows) {
      const history = state.workflowVersions.filter((entry) => entry.workflowId === workflow.id).sort((a, b) => a.version - b.version);
      assert(history.length === workflow.version && history.every((entry, index) => entry.version === index + 1)
        && sameRevision(workflow, history.at(-1)), 'STORE_INVALID', '技能历史与当前版本不一致。');
      if (workflow.source.kind === 'completed-run') {
        assert(state.runs.some((run) => run.id === workflow.source.runId && run.status === 'completed'
          && run.month === history[0].parameters.month), 'STORE_INVALID', '技能缺少本人已完成运行来源。');
      }
      if (workflow.verified && !(workflow.version === 1 && workflow.source.kind === 'completed-run')) {
        assert(state.runs.some((run) => run.workflowId === workflow.id && run.workflowVersion === workflow.version && run.status === 'completed'),
          'STORE_INVALID', '技能当前版本缺少本人完成验证。');
      }
    }
    for (const key of ['credentials', 'workflows', 'runs']) {
      assert(new Set(state[key].map((entry) => entry.id)).size === state[key].length, 'STORE_INVALID', '个人数据标识重复。');
    }
  } catch (error) {
    if (error.code === 'INVALID_PUBLICATION' || error.code === 'STORE_INVALID') throw error;
    throw failure('STORE_INVALID', '个人数据结构无法验证。');
  }
  let interrupted = false;
  for (const run of state.runs) {
    if (run.status === 'running' && run.sessionId !== root.sessionId) {
      run.status = 'failed';
      run.error = { code: 'INTERRUPTED', message: '上次运行被中断，请重新执行。' };
      run.updatedAt = now();
      run.finishedAt = run.updatedAt;
      interrupted = true;
    }
  }
  const shared = await readJSON(sharedPath) ?? { schemaVersion: SHARED_SCHEMA_VERSION, companyId: identity.companyId, publications: [] };
  fields(shared, ['schemaVersion', 'companyId', 'publications']);
  assert(shared.schemaVersion === SHARED_SCHEMA_VERSION && shared.companyId === identity.companyId && Array.isArray(shared.publications), 'STORE_INVALID', '公司模板目录版本或身份无效。');
  for (const publication of shared.publications) verifyPublication(root, publication, identity.companyId);
  assert(new Set(shared.publications.map((entry) => entry.id)).size === shared.publications.length, 'STORE_INVALID', '公司模板标识重复。');
  if (interrupted || migrated) await atomicJSON(statePath, state);
  return { state, shared, save: () => atomicJSON(statePath, state), saveShared: () => atomicJSON(sharedPath, shared) };
}

async function artifactMetadata(root, identity, input) {
  fields(input, ['id', 'path', 'name', 'mime', 'bytes', 'sha256', 'sourcePath']);
  string(input.path, 2000);
  assert(path.isAbsolute(input.path), 'UNSAFE_ARTIFACT', '产物必须为固定输出目录中的绝对路径。');
  const outputDirectory = path.join(root.directory, 'outputs', identity.companyId, identity.userId);
  const realOutput = await fs.realpath(outputDirectory).catch(() => undefined);
  assert(realOutput === outputDirectory, 'UNSAFE_ARTIFACT', '产物输出目录不安全。');
  async function verifyFile(filename) {
    assert(path.isAbsolute(filename), 'UNSAFE_ARTIFACT', '产物必须为绝对路径。');
    const stat = await trustedFile(filename, 20_000_000);
    assert(within(outputDirectory, await fs.realpath(filename)), 'UNSAFE_ARTIFACT', '产物不属于当前用户输出目录。');
    return stat;
  }
  const stat = await verifyFile(input.path);
  const digest = createHash('sha256').update(await fs.readFile(input.path)).digest('hex');
  assert(input.bytes === undefined || input.bytes === stat.size, 'UNSAFE_ARTIFACT', '产物大小与文件不一致。');
  assert(input.sha256 === undefined || input.sha256 === digest, 'UNSAFE_ARTIFACT', '产物校验与文件不一致。');
  assert(input.name === undefined || input.name === path.basename(input.path), 'UNSAFE_ARTIFACT', '产物名称与路径不一致。');
  assert(input.mime === undefined || input.mime === 'text/csv', 'UNSAFE_ARTIFACT', '产物类型不在白名单内。');
  const result = { path: await fs.realpath(input.path), name: path.basename(input.path), mime: 'text/csv', bytes: stat.size, sha256: digest };
  if (input.id !== undefined) result.id = identifier(input.id);
  if (input.sourcePath !== undefined) {
    string(input.sourcePath, 2000);
    await verifyFile(input.sourcePath);
    result.sourcePath = await fs.realpath(input.sourcePath);
  }
  return result;
}

/** A trusted main-process API. Never expose this object or withCredential over IPC. */
export function createWorkspace({ dataDir, cryptoAdapter, identity: inputIdentity, systems: inputSystems } = {}) {
  const root = getRoot(dataDir);
  const identity = validateIdentity(inputIdentity);
  const systems = validateSystems(inputSystems);
  async function available() {
    try { return typeof cryptoAdapter?.available === 'function' && await cryptoAdapter.available() === true; }
    catch { return false; }
  }
  async function requireCrypto() {
    assert(await available() && typeof cryptoAdapter?.encrypt === 'function' && typeof cryptoAdapter?.decrypt === 'function',
      'CRYPTO_UNAVAILABLE', '本机安全加密不可用，未保存或读取任何密码。');
  }
  const operation = (callback) => enqueue(root, async () => callback(await context(root, identity, systems)));
  const lookupSystem = (systemId) => {
    assert(typeof systemId === 'string' && Object.hasOwn(systems, systemId), 'UNKNOWN_SYSTEM', '系统不在可信白名单内。');
    return systems[systemId];
  };
  const findWorkflow = (state, id) => {
    identifier(id);
    const workflow = state.workflows.find((entry) => entry.id === id);
    assert(workflow, 'NOT_FOUND', '当前用户没有此个人技能。');
    validateWorkflow(root, workflow, identity.companyId);
    return workflow;
  };
  const requireVersion = (workflow, expectedVersion) => {
    revisionNumber(expectedVersion);
    assert(workflow.version === expectedVersion, 'VERSION_CONFLICT', '技能已被修改，请刷新后重试。');
  };
  const withdraw = async (context, id) => {
    const active = context.shared.publications.filter((entry) => !(entry.workflowId === id && entry.publisher.userId === identity.userId));
    if (active.length !== context.shared.publications.length) {
      context.shared.publications = active;
      await context.saveShared();
    }
  };
  const appendRevision = (state, workflow, change, restoredFrom) => {
    assert(workflow.version < Number.MAX_SAFE_INTEGER && state.workflowVersions.length < 10_000, 'VERSION_LIMIT', '技能历史已达本机存储上限。');
    workflow.version += 1;
    workflow.updatedAt = now();
    workflow.verified = false;
    delete workflow.verifiedAt;
    state.workflowVersions.push(revision(workflow, change, restoredFrom));
  };
  return Object.freeze({
    recipeCatalog() { return Promise.resolve(listRecipeCatalog()); },
    snapshot() {
      return operation(({ state, shared }) => ({ identity: clone(identity),
        credentials: state.credentials.map((entry) => credentialView(entry, systems)),
        workflows: state.workflows.map(workflowView).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
        runs: state.runs.map(runView).reverse(), shared: clone(shared.publications) }));
    },
    saveCredential(input) {
      return operation(async ({ state, save }) => {
        fields(input, ['systemId', 'username', 'password']);
        lookupSystem(input.systemId);
        const username = string(input.username, 200);
        const password = string(input.password, 16_384);
        await requireCrypto();
        let ciphertext;
        const secret = { username, password, origin: systems[input.systemId].origin, systemId: input.systemId,
          companyId: identity.companyId, userId: identity.userId };
        try { ciphertext = await cryptoAdapter.encrypt(JSON.stringify(secret)); }
        catch { throw failure('CRYPTO_FAILED', '本机加密失败，凭据未保存。'); }
        assert(typeof ciphertext === 'string' && ciphertext.length > 0 && ciphertext.length <= 100_000
          && !ciphertext.includes(JSON.stringify(secret))
          && (password.length < 4 || !ciphertext.includes(password))
          && (username.length < 4 || !ciphertext.includes(username)), 'CRYPTO_FAILED', '本机加密未产生安全密文，凭据未保存。');
        let credential = state.credentials.find((entry) => entry.systemId === input.systemId);
        if (!credential) {
          credential = { id: randomUUID(), systemId: input.systemId };
          state.credentials.push(credential);
        }
        Object.assign(credential, { origin: systems[input.systemId].origin, usernameMasked: '••••', ciphertext, updatedAt: now() });
        await save();
        return credentialView(credential, systems);
      });
    },
    deleteCredential(id) {
      return operation(async ({ state, save }) => {
        identifier(id);
        const index = state.credentials.findIndex((entry) => entry.id === id);
        assert(index >= 0, 'NOT_FOUND', '当前用户没有此凭据。');
        state.credentials.splice(index, 1);
        await save();
        return { deleted: true, id };
      });
    },
    async withCredential(systemId, callback) {
      lookupSystem(systemId);
      assert(typeof callback === 'function', 'INVALID_INPUT', '可信凭据使用回调不能为空。');
      const value = await operation(async ({ state }) => {
        const record = state.credentials.find((entry) => entry.systemId === systemId);
        assert(record, 'CREDENTIAL_REQUIRED', '请先为当前身份配置此系统的登录凭据。');
        assert(record.origin === systems[systemId].origin, 'CREDENTIAL_ORIGIN_MISMATCH', '系统来源已变更，请为当前来源重新保存凭据。');
        await requireCrypto();
        let decrypted;
        try {
          decrypted = JSON.parse(await cryptoAdapter.decrypt(record.ciphertext));
          fields(decrypted, ['username', 'password', 'origin', 'systemId', 'companyId', 'userId']);
          string(decrypted.username, 200);
          string(decrypted.password, 16_384);
          assert(decrypted.origin === record.origin && decrypted.systemId === systemId
            && decrypted.companyId === identity.companyId && decrypted.userId === identity.userId,
          'CRYPTO_FAILED', '凭据与当前身份或系统来源不一致。');
        }
        catch { throw failure('CRYPTO_FAILED', '凭据无法由本机安全存储解密。'); }
        return { username: decrypted.username, password: decrypted.password, origin: systems[systemId].origin };
      });
      try { return await callback(value); }
      finally { value.password = ''; value.username = ''; }
    },
    beginRun(input) {
      return operation(async ({ state, save }) => {
        fields(input, ['month', 'workflowId']);
        month(input.month);
        const workflow = input.workflowId !== undefined ? findWorkflow(state, input.workflowId) : undefined;
        assert(!workflow || workflow.enabled, 'WORKFLOW_DISABLED', '此技能已停用，请先启用后再运行。');
        assert(!state.runs.some((run) => run.status === 'running'), 'RUN_ACTIVE', '当前用户已有运行中的任务。');
        const timestamp = now();
        const run = { id: randomUUID(), month: input.month, status: 'running', steps: [], createdAt: timestamp, updatedAt: timestamp, sessionId: root.sessionId };
        if (workflow) Object.assign(run, { workflowId: workflow.id, workflowVersion: workflow.version });
        state.runs.push(run);
        await save();
        return runView(run);
      });
    },
    updateRun(id, patch) {
      return operation(async ({ state, save }) => {
        identifier(id);
        fields(patch, ['status', 'steps', 'artifact', 'summary', 'error']);
        const run = state.runs.find((entry) => entry.id === id);
        assert(run, 'NOT_FOUND', '当前用户没有此运行。');
        assert(run.status === 'running', 'INVALID_TRANSITION', '已结束运行不能再次修改。');
        const status = patch.status ?? run.status;
        assert(status === 'running' || TERMINAL.has(status), 'INVALID_TRANSITION', '运行状态无效。');
        if (patch.steps !== undefined) {
          assert(Array.isArray(patch.steps) && patch.steps.length <= 100, 'INVALID_INPUT', '运行步骤格式无效。');
          for (const step of patch.steps) {
            fields(step, ['id', 'label', 'status', 'detail']);
            if (step.id !== undefined) identifier(step.id);
            string(step.label, 200);
            assert(['pending', 'running', 'completed', 'failed', 'cancelled'].includes(step.status), 'INVALID_INPUT', '步骤状态无效。');
            if (step.detail !== undefined) string(step.detail, 2000, 0);
          }
          run.steps = safeMetadata(patch.steps);
        }
        assert(patch.artifact === undefined || status === 'completed', 'INVALID_TRANSITION', '只有完成运行可以保存产物。');
        assert(patch.error === undefined || status === 'failed' || status === 'cancelled', 'INVALID_TRANSITION', '运行错误只能附在失败或取消状态。');
        if (patch.artifact !== undefined) run.artifact = await artifactMetadata(root, identity, patch.artifact);
        if (patch.summary !== undefined) {
          run.summary = summaryMetadata(patch.summary, run.month);
        }
        if (patch.error !== undefined) run.error = safeMetadata(patch.error);
        run.status = status;
        run.updatedAt = now();
        if (TERMINAL.has(status)) run.finishedAt = run.updatedAt;
        if (status === 'completed' && run.workflowId) {
          const workflow = state.workflows.find((entry) => entry.id === run.workflowId);
          if (workflow?.enabled && workflow.version === run.workflowVersion) {
            Object.assign(workflow, { verified: true, verifiedAt: run.updatedAt, updatedAt: run.updatedAt });
          }
        }
        await save();
        return runView(run);
      });
    },
    saveWorkflowFromRun(input) {
      return operation(async ({ state, save }) => {
        fields(input, ['runId', 'name', 'pinned']);
        identifier(input.runId);
        const run = state.runs.find((entry) => entry.id === input.runId);
        assert(run, 'NOT_FOUND', '当前用户没有此运行。');
        assert(run.status === 'completed', 'RUN_NOT_COMPLETED', '只有本人已完成运行可以保存为个人技能。');
        const name = string(input.name, 100).trim();
        assert(name, 'INVALID_INPUT', '个人技能名称不能为空。');
        assert(input.pinned === undefined || typeof input.pinned === 'boolean', 'INVALID_INPUT', '置顶状态必须为布尔值。');
        const timestamp = now();
        const workflow = { id: randomUUID(), name, description: '', recipeId: RECIPE_ID, parameters: { month: run.month },
          pinned: input.pinned ?? false, enabled: true, version: 1, verified: true, createdAt: timestamp,
          updatedAt: timestamp, verifiedAt: timestamp, source: { kind: 'completed-run', runId: run.id } };
        state.workflows.push(workflow);
        state.workflowVersions.push(revision(workflow, 'created'));
        await save();
        return workflowView(workflow);
      });
    },
    setPinned(id, pinned) {
      return operation(async ({ state, save }) => {
        assert(typeof pinned === 'boolean', 'INVALID_INPUT', '置顶状态必须为布尔值。');
        const workflow = findWorkflow(state, id);
        Object.assign(workflow, { pinned, updatedAt: now() });
        await save();
        return workflowView(workflow);
      });
    },
    editWorkflow(input) {
      return operation(async (context) => {
        const { state, save } = context;
        fields(input, ['id', 'name', 'description', 'month', 'expectedVersion']);
        const workflow = findWorkflow(state, input.id);
        requireVersion(workflow, input.expectedVersion);
        assert(['name', 'description', 'month'].some((key) => Object.hasOwn(input, key)), 'INVALID_INPUT', '请指定需要编辑的技能字段。');
        const name = input.name === undefined ? workflow.name : string(input.name, 100).trim();
        assert(name.length > 0, 'INVALID_INPUT', '个人技能名称不能为空。');
        const description = input.description === undefined ? workflow.description : string(input.description, 2000, 0).trim();
        const nextMonth = input.month === undefined ? workflow.parameters.month : month(input.month);
        if (name === workflow.name && description === workflow.description && nextMonth === workflow.parameters.month) return workflowView(workflow);
        Object.assign(workflow, { name, description, parameters: { month: nextMonth } });
        appendRevision(state, workflow, 'edited');
        await withdraw(context, workflow.id);
        await save();
        return workflowView(workflow);
      });
    },
    workflowVersions(id) {
      return operation(({ state }) => {
        findWorkflow(state, id);
        return clone(state.workflowVersions.filter((entry) => entry.workflowId === id).sort((a, b) => b.version - a.version));
      });
    },
    restoreWorkflow(input) {
      return operation(async (context) => {
        const { state, save } = context;
        fields(input, ['id', 'version', 'expectedVersion']);
        const workflow = findWorkflow(state, input.id);
        requireVersion(workflow, input.expectedVersion);
        revisionNumber(input.version);
        const previous = state.workflowVersions.find((entry) => entry.workflowId === workflow.id && entry.version === input.version);
        assert(previous, 'NOT_FOUND', '此技能没有指定的历史版本。');
        Object.assign(workflow, { name: previous.name, description: previous.description, parameters: clone(previous.parameters) });
        appendRevision(state, workflow, 'restored', previous.version);
        await withdraw(context, workflow.id);
        await save();
        return workflowView(workflow);
      });
    },
    setWorkflowEnabled(input) {
      return operation(async (context) => {
        const { state, save } = context;
        fields(input, ['id', 'enabled', 'expectedVersion']);
        assert(typeof input.enabled === 'boolean', 'INVALID_INPUT', '启用状态必须为布尔值。');
        const workflow = findWorkflow(state, input.id);
        requireVersion(workflow, input.expectedVersion);
        if (workflow.enabled === input.enabled) return workflowView(workflow);
        workflow.enabled = input.enabled;
        appendRevision(state, workflow, input.enabled ? 'enabled' : 'disabled');
        await withdraw(context, workflow.id);
        await save();
        return workflowView(workflow);
      });
    },
    deleteWorkflow(id) {
      return operation(async ({ state, shared, save, saveShared }) => {
        const workflow = findWorkflow(state, id);
        assert(!state.runs.some((run) => run.status === 'running' && run.workflowId === id), 'RUN_ACTIVE', '运行中的技能暂不能删除。');
        state.workflows.splice(state.workflows.indexOf(workflow), 1);
        state.workflowVersions = state.workflowVersions.filter((entry) => entry.workflowId !== id);
        const active = shared.publications.filter((publication) => !(publication.workflowId === id && publication.publisher.userId === identity.userId));
        if (active.length !== shared.publications.length) { shared.publications = active; await saveShared(); }
        await save();
        return { deleted: true, id };
      });
    },
    publishWorkflow(id) {
      return operation(async ({ state, shared, saveShared }) => {
        const workflow = findWorkflow(state, id);
        assert(workflow.enabled, 'WORKFLOW_DISABLED', '停用的技能不能发布。');
        assert(workflow.verified, 'UNVERIFIED_WORKFLOW', '请先用当前身份成功执行此技能，再发布到公司目录。');
        const previous = shared.publications.find((publication) => publication.workflowId === id && publication.publisher.userId === identity.userId);
        if (previous && (previous.workflowVersion ?? 1) === workflow.version) return clone(previous);
        const template = { name: workflow.name, recipeId: RECIPE_ID,
          parameters: { month: workflow.parameters.month }, version: TEMPLATE_VERSION };
        if (workflow.description) template.description = workflow.description;
        validateWorkflowTemplate(template);
        const payload = { id: randomUUID(), version: TEMPLATE_VERSION, companyId: identity.companyId,
          publisher: { userId: identity.userId, displayName: identity.displayName, provider: 'mock' },
          workflowId: workflow.id, workflowVersion: workflow.version, publishedAt: now(), template };
        const publication = { ...payload, signature: signature(root, payload) };
        shared.publications = shared.publications.filter((entry) => !(entry.workflowId === id && entry.publisher.userId === identity.userId));
        shared.publications.push(publication);
        await saveShared();
        return clone(publication);
      });
    },
    importWorkflow(publicationId) {
      return operation(async ({ state, shared, save }) => {
        identifier(publicationId);
        const publication = shared.publications.find((entry) => entry.id === publicationId);
        assert(publication, 'NOT_FOUND', '当前公司没有此可导入模板。');
        verifyPublication(root, publication, identity.companyId);
        const timestamp = now();
        const template = validateWorkflowTemplate(publication.template);
        const workflow = { id: randomUUID(), name: template.name, description: template.description, recipeId: RECIPE_ID,
          parameters: clone(template.parameters), pinned: false, enabled: true, version: 1,
          verified: false, createdAt: timestamp, updatedAt: timestamp,
          source: { kind: 'company-template', publication: clone(publication) } };
        state.workflows.push(workflow);
        state.workflowVersions.push(revision(workflow, 'imported'));
        await save();
        return workflowView(workflow);
      });
    },
    revokePublication(id) {
      return operation(async ({ shared, saveShared }) => {
        identifier(id);
        const index = shared.publications.findIndex((entry) => entry.id === id);
        assert(index >= 0, 'NOT_FOUND', '当前公司没有此发布。');
        assert(shared.publications[index].publisher.userId === identity.userId, 'FORBIDDEN', '只有发布者可以撤回此模板。');
        shared.publications.splice(index, 1);
        await saveShared();
        return { revoked: true, id };
      });
    },
  });
}
