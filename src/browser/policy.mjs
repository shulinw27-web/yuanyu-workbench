export const SUPPORTED_MONTHS = Object.freeze(['2026-09', '2026-10']);
export const SYSTEM_FIELDS = Object.freeze({
  procurement: Object.freeze(['poNumber', 'supplier', 'orderDate', 'status', 'amountCents']),
  warehouse: Object.freeze(['receiptNumber', 'poNumber', 'receivedDate', 'status', 'amountCents']),
});
export const SYSTEM_PATHS = Object.freeze({ procurement: '/orders', warehouse: '/receipts' });

export function assertMonth(month) {
  if (!SUPPORTED_MONTHS.includes(month)) throw new Error('仅支持2026-09或2026-10的Mock演示月份。');
  return month;
}

export function validateSystem(systemId, system) {
  if (!Object.hasOwn(SYSTEM_FIELDS, systemId) || !system || system.id !== systemId) throw new Error('未知Mock系统。');
  let origin;
  try { origin = new URL(system.origin); } catch { throw new Error('Mock系统来源无效。'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.origin !== system.origin) throw new Error('仅允许固定本机Mock来源。');
  if (system.url !== `${origin.origin}/`) throw new Error('Mock入口地址无效。');
  return { id: systemId, label: String(system.label ?? ''), origin: origin.origin, url: system.url };
}

export function isAllowedSystemUrl(rawUrl, systemId, origin) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== origin || url.username || url.password || url.hash) return false;
    if (!['/', '/login', SYSTEM_PATHS[systemId]].includes(url.pathname)) return false;
    if (url.pathname !== SYSTEM_PATHS[systemId]) return url.search === '';
    const keys = [...url.searchParams.keys()];
    return keys.length === 0 || (keys.length === 1 && keys[0] === 'month' && SUPPORTED_MONTHS.includes(url.searchParams.get('month')));
  } catch { return false; }
}

function assertText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label}字段无效。`);
}

function assertDate(value, month) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(`${month}-`)) throw new Error('数据日期与月份不一致。');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('数据日期无效。');
}

export function validateRows(systemId, rows, month) {
  assertMonth(month);
  const fields = SYSTEM_FIELDS[systemId];
  if (!fields || !Array.isArray(rows) || rows.length > 10000) throw new Error('数据集结构无效。');
  const identifiers = new Set();
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field))) throw new Error('表格字段与固定数据结构不匹配。');
    const normalized = Object.fromEntries(fields.map((field) => [field, row[field]]));
    for (const field of fields.filter((field) => field !== 'amountCents')) assertText(normalized[field], field);
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0) throw new Error('金额必须为非负安全整数分。');
    const id = systemId === 'procurement' ? row.poNumber : row.receiptNumber;
    if (identifiers.has(id)) throw new Error('数据集存在重复单号。');
    identifiers.add(id);
    assertDate(systemId === 'procurement' ? row.orderDate : row.receivedDate, month);
    if (!(systemId === 'procurement' ? ['已审核', '待审核', '已作废'] : ['已入库', '待入库', '已作废']).includes(row.status)) throw new Error('业务状态不在允许范围。');
    return normalized;
  });
}

export function validateReadResult(result, systemId, month, expectedOrigin) {
  assertMonth(month);
  if (!result || result.source?.systemId !== systemId || result.source.month !== month) throw new Error('读取来源或月份不匹配。');
  let url;
  try { url = new URL(result.source.url); } catch { throw new Error('读取来源URL无效。'); }
  const origin = expectedOrigin ?? url.origin;
  validateSystem(systemId, { id: systemId, origin, url: `${origin}/` });
  if (!isAllowedSystemUrl(url.href, systemId, origin) || url.pathname !== SYSTEM_PATHS[systemId] || url.searchParams.get('month') !== month) throw new Error('读取来源不是指定月份的业务页面。');
  if (typeof result.source.readAt !== 'string' || !Number.isFinite(Date.parse(result.source.readAt))) throw new Error('读取时间无效。');
  return { rows: validateRows(systemId, result.rows, month), source: { systemId, url: url.href, month, readAt: result.source.readAt } };
}
