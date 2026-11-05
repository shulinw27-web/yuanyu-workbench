import { isIP } from 'node:net';

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SENSITIVE_KEY = /(?:pass(?:word|wd)?|secret|token|authorization|auth|session|credential|api[_-]?key|otp|mfa|code)/i;
const fail = (message, code = 'INVALID_SITE_CONFIG') => Object.assign(new Error(message), { code });
const selector = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

function path(value, origin) {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || /[?#\\\u0000-\u0020\u007f]/.test(value)) throw fail('站点路径必须为精确页面路径。');
  if (new URL(value, origin).pathname !== value) throw fail('站点路径必须为规范路径。');
  return value;
}

export function validateInteractiveSite(site) {
  if (!site || typeof site !== 'object' || !ID.test(site.id)) throw fail('受控站点标识无效。');
  let origin;
  try { origin = new URL(site.origin); } catch { throw fail('受控站点来源无效。'); }
  const hostname = origin.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || ['::1', '::', '0.0.0.0'].includes(hostname) || /^::ffff:7f[0-9a-f]{2}:/i.test(hostname) || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (origin.origin !== site.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw fail('受控站点必须使用精确来源。');
  if (loopback ? site.allowMockLoopback !== true || !['https:', 'http:'].includes(origin.protocol) : origin.protocol !== 'https:') throw fail('受控站点仅支持HTTPS；本机Mock需显式启用。');
  if (site.allowMockLoopback === true && !loopback) throw fail('Mock例外仅适用于回环地址。');
  if (!Array.isArray(site.paths) || !site.paths.length || site.paths.length > 100) throw fail('受控站点需提供有限页面路径。');
  const paths = [...new Set(site.paths.map((value) => path(value, origin.origin)))];
  const entryPath = path(site.entryPath ?? paths[0], origin.origin);
  if (!paths.includes(entryPath)) throw fail('入口不在允许页面路径中。');
  const queryKeys = {};
  if (site.queryKeys !== undefined && (!site.queryKeys || typeof site.queryKeys !== 'object' || Array.isArray(site.queryKeys))) throw fail('查询参数白名单无效。');
  for (const [pathname, keys] of Object.entries(site.queryKeys ?? {})) {
    if (!paths.includes(pathname) || !Array.isArray(keys) || keys.length > 20 || keys.some((key) => typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(key) || SENSITIVE_KEY.test(key))) throw fail('仅允许显式非敏感查询参数。');
    queryKeys[pathname] = Object.freeze([...new Set(keys)]);
  }
  if (site.readOnlyActions !== undefined && !Array.isArray(site.readOnlyActions)) throw fail('只读动作配置无效。');
  const readOnlyActions = (site.readOnlyActions ?? []).map((action) => {
    if (!action || !selector(action.selector) || !['read', 'search', 'filter'].includes(action.kind)) throw fail('只读动作配置无效。');
    return Object.freeze({ selector: action.selector, kind: action.kind });
  });
  if (readOnlyActions.length > 100) throw fail('只读动作配置过多。');
  let credentialForm;
  if (site.credentialForm !== undefined) {
    const form = site.credentialForm;
    if (!form || ![form.selector, form.usernameSelector, form.passwordSelector].every(selector) || (form.method ?? 'post').toLowerCase() !== 'post' || !paths.includes(form.actionPath)) throw fail('可信凭据表单配置无效。');
    credentialForm = Object.freeze({ selector: form.selector, usernameSelector: form.usernameSelector, passwordSelector: form.passwordSelector, actionPath: path(form.actionPath, origin.origin), method: 'post' });
  }
  if (site.manualPostPaths !== undefined && !Array.isArray(site.manualPostPaths)) throw fail('人工登录提交路径无效。');
  const manualPostPaths = [...new Set([...(site.manualPostPaths ?? []), ...(credentialForm ? [credentialForm.actionPath] : [])])];
  if (manualPostPaths.some((value) => !paths.includes(value))) throw fail('人工登录提交路径不在白名单中。');
  return Object.freeze({ id: site.id, label: String(site.label ?? site.id).slice(0, 120), origin: origin.origin, entryPath, paths: Object.freeze(paths), queryKeys: Object.freeze(queryKeys), readOnlyActions: Object.freeze(readOnlyActions), credentialForm, manualPostPaths: Object.freeze(manualPostPaths), manual: site.manual === true, allowMockLoopback: site.allowMockLoopback === true });
}

export function isAllowedInteractiveUrl(raw, site) {
  try {
    const url = new URL(raw);
    if (url.origin !== site.origin || url.username || url.password || url.hash || !site.paths.includes(url.pathname)) return false;
    const keys = [...url.searchParams.keys()];
    return keys.length <= 20 && keys.length === new Set(keys).size && keys.every((key) => site.queryKeys[url.pathname]?.includes(key) && !SENSITIVE_KEY.test(key) && url.searchParams.get(key).length <= 2000);
  } catch { return false; }
}

/** Navigation stays path-scoped; static assets may load only from the same registered origin. */
export function isAllowedInteractiveRequest(details,site,{manual=false}={}) {
  let url;try{url=new URL(details.url);}catch{return false;}
  if(url.origin!==site.origin||url.username||url.password||url.hash||details.resourceType==='subFrame')return false;
  const method=String(details.method??'GET').toUpperCase();
  if(!['GET','HEAD'].includes(method))return manual&&method==='POST'&&isAllowedInteractiveUrl(details.url,site)&&site.manualPostPaths.includes(url.pathname);
  if(['script','stylesheet','image','font','media'].includes(details.resourceType))return url.search.length<=2000&&[...url.searchParams.keys()].every(key=>!SENSITIVE_KEY.test(key));
  return isAllowedInteractiveUrl(details.url,site);
}

export function validateInteractiveAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || !['click', 'fill', 'select'].includes(action.type) || typeof action.ref !== 'string' || !/^r-[a-f0-9-]{36}-\d{1,3}$/.test(action.ref) || Object.keys(action).some((key) => !['type', 'ref', 'value'].includes(key))) throw fail('只能使用观察得到的元素引用和有限动作。', 'INVALID_BROWSER_ACTION');
  if (action.type === 'click' ? action.value !== undefined : typeof action.value !== 'string' || action.value.length > 4096 || /[\u0000]/.test(action.value)) throw fail('交互动作参数无效。', 'INVALID_BROWSER_ACTION');
  return { type: action.type, ref: action.ref, ...(action.value === undefined ? {} : { value: action.value }) };
}

export function sanitizeBrowserText(value, redactions = [], limit = 12000) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of redactions.filter((item) => typeof item === 'string' && item.length).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]');
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => { try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[网址已隐藏]'; } });
  text = text.replace(/\b(?:password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|authorization|session[_-]?id|api[_-]?key|otp|mfa[_ -]?code)\s*[:=]\s*[^\s,;]+/gi, '[敏感字段已隐藏]');
  return text.slice(0, limit);
}
