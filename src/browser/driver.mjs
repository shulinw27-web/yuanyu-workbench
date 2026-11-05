import { randomUUID } from 'node:crypto';
import { assertMonth, isAllowedSystemUrl, SYSTEM_FIELDS, SYSTEM_PATHS, validateReadResult, validateSystem } from './policy.mjs';

const TIMEOUT_MS = 15000;
const cancelledError = () => Object.assign(new Error('浏览器执行已取消。'), { code: 'CANCELLED' });
const browserError = (message) => Object.assign(new Error(message), { code: 'BROWSER_READ_FAILED' });

// All executable code is owned by this module. Callers supply validated data, never scripts.
const loginScript = (payload) => `(${function login(data) {
  if (location.origin !== data.origin || !['/', '/login'].includes(location.pathname)) throw new Error('Unexpected login origin');
  const form = document.querySelector('form#login-form');
  const username = form?.querySelector('input[name="username"]');
  const password = form?.querySelector('input[name="password"]');
  if (!form || !username || !password || form.method !== 'post' || new URL(form.action).origin !== data.origin || new URL(form.action).pathname !== '/login') throw new Error('Login form mismatch');
  username.value = data.username;
  password.value = data.password;
  form.requestSubmit();
  return true;
}.toString()})(${JSON.stringify(payload)})`;

const filterScript = (payload) => `(${function filter(data) {
  if (location.origin !== data.origin || location.pathname !== data.path || !document.querySelector('[data-authenticated="true"]')) throw new Error('Login not established');
  const form = document.querySelector('form#month-filter');
  const select = form?.querySelector('select[name="month"]');
  if (!form || !select || form.method !== 'get' || new URL(form.action).origin !== data.origin || new URL(form.action).pathname !== data.path || ![...select.options].some((option) => option.value === data.month)) throw new Error('Filter form mismatch');
  select.value = data.month;
  form.requestSubmit();
  return true;
}.toString()})(${JSON.stringify(payload)})`;

const readScript = (payload) => `(${function read(data) {
  if (location.origin !== data.origin || location.pathname !== data.path || new URL(location.href).searchParams.get('month') !== data.month || !document.querySelector('[data-authenticated="true"]')) throw new Error('Unexpected business page');
  const table = document.querySelector('table#business-data');
  if (!table || table.dataset.system !== data.systemId || table.dataset.month !== data.month || table.dataset.schema !== '1' || document.querySelector('#dataset-month')?.textContent !== data.month) throw new Error('Dataset identity mismatch');
  const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.dataset.field);
  if (JSON.stringify(headers) !== JSON.stringify(data.fields)) throw new Error('Unexpected table fields');
  const rows = [...table.querySelectorAll('tbody tr')].map((row) => {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length !== data.fields.length || cells.some((cell, index) => cell.dataset.field !== data.fields[index])) throw new Error('Unexpected row fields');
    return Object.fromEntries(cells.map((cell, index) => {
      const text = cell.textContent;
      if (data.fields[index] === 'amountCents') {
        if (!/^\d+$/.test(text)) throw new Error('Invalid integer amount');
        return [data.fields[index], Number(text)];
      }
      return [data.fields[index], text];
    }));
  });
  return { rows, source: { systemId: data.systemId, url: location.href, month: data.month, readAt: new Date().toISOString() } };
}.toString()})(${JSON.stringify(payload)})`;

function guarded(promise, signal, timeout = TIMEOUT_MS) {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, browserError('Mock网页响应超时。')), timeout);
    const onAbort = () => finish(reject, cancelledError());
    const finish = (callback, value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); callback(value); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => signal.aborted ? finish(reject, cancelledError()) : finish(resolve, value), (error) => finish(reject, error));
  });
}

function nextLoad(contents, signal) {
  let dispose;
  const promise = new Promise((resolve, reject) => {
    const loaded = () => { dispose(); resolve(); };
    const failed = (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { dispose(); reject(browserError('Mock页面加载失败。')); } };
    const destroyed = () => { dispose(); reject(cancelledError()); };
    dispose = () => { contents.removeListener('did-finish-load', loaded); contents.removeListener('did-fail-load', failed); contents.removeListener('destroyed', destroyed); };
    contents.once('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    contents.once('destroyed', destroyed);
  });
  const wait = guarded(promise, signal);
  // Attach a handler before executing the submit action to avoid unhandled rejection on close.
  wait.catch(() => {});
  return { wait, dispose };
}

export function createBrowserDriver({ BrowserWindow, systems, show = true }) {
  if (typeof BrowserWindow !== 'function') throw new Error('缺少受控浏览器运行时。');
  const dictionary = Object.fromEntries(['procurement', 'warehouse'].map((id) => [id, validateSystem(id, systems?.[id])]));
  if (dictionary.procurement.origin === dictionary.warehouse.origin) throw new Error('Mock系统必须使用不同来源。');
  const active = new Set();
  let closed = false;
  return {
    async readSystem(systemId, { month, credential, signal: callerSignal } = {}) {
      if (closed || callerSignal?.aborted) throw cancelledError();
      assertMonth(month);
      const system = dictionary[systemId];
      if (!system) throw browserError('未知Mock系统。');
      if (!credential || typeof credential.username !== 'string' || typeof credential.password !== 'string' || !credential.username || !credential.password || credential.username.length > 512 || credential.password.length > 512 || (credential.origin !== undefined && credential.origin !== system.origin)) throw browserError('缺少对应Mock来源的有效凭据。');
      const controller = new AbortController();
      const abort = () => controller.abort();
      callerSignal?.addEventListener('abort', abort, { once: true });
      const entry = { controller, window: null };
      active.add(entry);
      const actions = [];
      let securityViolation = false;
      let stage = 'navigate';
      let mainHttpStatus;
      try {
        const window = new BrowserWindow({
          width: 1100, height: 780, show: Boolean(show), title: system.label, autoHideMenuBar: true,
          webPreferences: { partition: `mock-workbench-${randomUUID()}`, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false },
        });
        entry.window = window;
        const contents = window.webContents;
        contents.on('did-navigate', (_event, _url, responseCode) => { if (Number.isInteger(responseCode)) mainHttpStatus = responseCode; });
        const allowed = (url) => isAllowedSystemUrl(url, systemId, system.origin);
        const blockNavigation = (event, target) => {
          const url = typeof target === 'string' ? target : target?.url ?? event.url;
          if (!allowed(url)) { event.preventDefault(); securityViolation = true; controller.abort(); }
        };
        contents.on('will-navigate', blockNavigation);
        contents.on('will-redirect', blockNavigation);
        contents.on('will-frame-navigate', blockNavigation);
        contents.on('will-attach-webview', (event) => event.preventDefault());
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        contents.session.setPermissionCheckHandler(() => false);
        contents.session.on('will-download', (event) => event.preventDefault());
        contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }));
        window.once('closed', abort);
        const checkLocation = () => {
          if (closed || controller.signal.aborted || window.isDestroyed()) throw cancelledError();
          if (securityViolation || !allowed(contents.getURL())) throw browserError('网页已离开允许的Mock来源。');
        };
        await guarded(window.loadURL(system.url), controller.signal);
        checkLocation();
        actions.push({ type: 'navigate', systemId, url: system.url });
        const submit = async (script) => {
          checkLocation();
          const pending = nextLoad(contents, controller.signal);
          try {
            await guarded(contents.executeJavaScript(script, true), controller.signal);
            await pending.wait;
          } finally { pending.dispose(); }
          checkLocation();
        };
        stage = 'login';
        await submit(loginScript({ origin: system.origin, username: credential.username, password: credential.password }));
        actions.push({ type: 'login', systemId, status: 'submitted' });
        if (new URL(contents.getURL()).pathname !== SYSTEM_PATHS[systemId]) throw browserError('Mock登录失败；请检查演示凭据。');
        stage = 'filter';
        await submit(filterScript({ origin: system.origin, path: SYSTEM_PATHS[systemId], month }));
        actions.push({ type: 'filter', systemId, month });
        checkLocation();
        stage = 'read';
        const result = await guarded(contents.executeJavaScript(readScript({ origin: system.origin, path: SYSTEM_PATHS[systemId], systemId, month, fields: SYSTEM_FIELDS[systemId] }), true), controller.signal);
        checkLocation();
        stage = 'validate';
        const validated = validateReadResult(result, systemId, month, system.origin);
        if (new URL(contents.getURL()).href !== validated.source.url) throw browserError('读取前后页面来源发生变化。');
        actions.push({ type: 'read-table', systemId, month, rowCount: validated.rows.length });
        return { ...validated, actions };
      } catch (error) {
        if (closed || controller.signal.aborted || error?.code === 'CANCELLED') throw securityViolation ? browserError('已阻止离开Mock来源的导航。') : cancelledError();
        const safe = error?.code === 'BROWSER_READ_FAILED' ? error : browserError('Mock页面登录、筛选或表格校验失败。');
        safe.stage = stage;
        if (Number.isInteger(mainHttpStatus)) safe.httpStatus = mainHttpStatus;
        throw safe;
      } finally {
        callerSignal?.removeEventListener('abort', abort);
        active.delete(entry);
        if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
      }
    },
    async close() {
      closed = true;
      for (const entry of active) { entry.controller.abort(); if (entry.window && !entry.window.isDestroyed()) entry.window.destroy(); }
      active.clear();
    },
  };
}
