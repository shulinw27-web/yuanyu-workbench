import path from 'node:path';
import { mkdir, lstat, realpath, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { assertMonth, validateReadResult } from '../browser/policy.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeAdd = (left, right) => {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error('累计金额超出安全整数范围。');
  return value;
};
const money = (value) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;

export function csvCell(value) {
  let text = String(value ?? '');
  // Excel may ignore leading whitespace/control characters when detecting a formula.
  if (/^[\s\u0000-\u0020\u007f-\u009f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function aggregateMonthlyRows({ procurement, warehouse, month }) {
  assertMonth(month);
  const orders = validateReadResult(procurement, 'procurement', month);
  const receipts = validateReadResult(warehouse, 'warehouse', month);
  if (new URL(orders.source.url).origin === new URL(receipts.source.url).origin) throw new Error('采购和仓储必须来自不同Mock站点。');
  const approved = orders.rows.filter((order) => order.status === '已审核');
  const orderIds = new Set(approved.map((order) => order.poNumber));
  const accepted = receipts.rows.filter((receipt) => receipt.status === '已入库' && orderIds.has(receipt.poNumber));
  const receiptsByOrder = new Map();
  for (const receipt of accepted) {
    const entry = receiptsByOrder.get(receipt.poNumber) ?? { amountCents: 0, receiptNumbers: [] };
    entry.amountCents = safeAdd(entry.amountCents, receipt.amountCents);
    entry.receiptNumbers.push(receipt.receiptNumber);
    receiptsByOrder.set(receipt.poNumber, entry);
  }
  const summary = { month, orderCount: approved.length, receiptCount: accepted.length, orderedCents: 0, receivedCents: 0, outstandingCents: 0, unmatchedCount: 0, partialCount: 0, overReceivedCount: 0, excludedOrderCount: orders.rows.length - approved.length, ignoredReceiptCount: receipts.rows.length - accepted.length };
  const rows = approved.map((order) => {
    const entry = receiptsByOrder.get(order.poNumber);
    const receivedCents = entry?.amountCents ?? 0;
    const outstandingCents = Math.max(0, order.amountCents - receivedCents);
    let matchStatus;
    if (!entry) { matchStatus = '缺少入库记录，待核实'; summary.unmatchedCount++; }
    else if (receivedCents < order.amountCents) { matchStatus = '部分入库，差额待核实'; summary.partialCount++; }
    else if (receivedCents > order.amountCents) { matchStatus = '入库金额超过采购，待核实'; summary.overReceivedCount++; }
    else matchStatus = '金额匹配（不代表财务确认）';
    summary.orderedCents = safeAdd(summary.orderedCents, order.amountCents);
    summary.receivedCents = safeAdd(summary.receivedCents, receivedCents);
    summary.outstandingCents = safeAdd(summary.outstandingCents, outstandingCents);
    return { poNumber: order.poNumber, supplier: order.supplier, orderDate: order.orderDate, orderStatus: order.status, orderedCents: order.amountCents, receivedCents, outstandingCents, receiptNumbers: entry?.receiptNumbers.join('；') ?? '', matchStatus };
  });
  return { rows, summary, sources: { procurement: orders.source, warehouse: receipts.source }, sourceCounts: { procurement: orders.rows.length, warehouse: receipts.rows.length }, inputHashes: { procurement: digest(JSON.stringify(orders)), warehouse: digest(JSON.stringify(receipts)) } };
}

export function resolveArtifactPath(outputDir, filename) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) throw new Error('输出目录必须是主进程授权的绝对路径。');
  if (typeof filename !== 'string' || path.basename(filename) !== filename || filename.includes('\0') || filename === '.' || filename === '..') throw new Error('产物文件名无效。');
  const base = path.resolve(outputDir);
  const target = path.resolve(base, filename);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('产物路径越过授权输出目录。');
  return target;
}

async function prepareOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) throw new Error('输出目录必须是主进程授权的绝对路径。');
  const absolute = path.resolve(outputDir);
  // Reject symlinks/junctions before creating directories or writing anything.
  for (let current = absolute; ; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('授权输出目录不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const directory = await lstat(absolute);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('输出目录真实路径与授权路径不一致。');
  // realpath also expands Windows 8.3 aliases; the ancestry check above rejects redirection.
  return await realpath(absolute);
}

async function writeExclusive(filename, content) {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export async function buildMonthlyReport({ procurement, warehouse, month, outputDir }) {
  const data = aggregateMonthlyRows({ procurement, warehouse, month });
  const base = await prepareOutputDir(outputDir);
  const stem = `purchase-monthly-${month}-${randomUUID()}`;
  const name = `${stem}.csv`;
  const csvPath = resolveArtifactPath(base, name);
  const sourcePath = resolveArtifactPath(base, `${stem}.sources.json`);
  const header = ['业务月份', '采购单号', '合成供应商', '订单日期', '审核状态', '采购金额（元）', '入库金额（元）', '未入库差额（元）', '关联入库单号', '核对状态', '资料性质'];
  const records = data.rows.map((row) => [month, row.poNumber, row.supplier, row.orderDate, row.orderStatus, money(row.orderedCents), money(row.receivedCents), money(row.outstandingCents), row.receiptNumbers, row.matchStatus, 'Mock业务月报资料草稿，非正式财务报表']);
  const csv = Buffer.from(`\uFEFF${[header, ...records].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
  const csvHash = digest(csv);
  const sourceDocument = {
    schemaVersion: 1, classification: 'Mock业务月报资料草稿，非正式财务报表', month, createdAt: new Date().toISOString(),
    method: '受控浏览器分别登录两个本机Mock网页，按月份筛选并读取可见表格。仅纳入已审核采购单，以采购单号关联已入库记录。全部金额以整数分汇总。',
    limitations: ['仅包含合成演示数据，未访问真实企业系统。', '采购金额与入库金额核对不代表发票、税额、付款或总账确认。', '缺少入库记录、部分入库及超额入库均需人工核实。', '未审核采购单和未关联到已审核采购单的入库记录不计入合计。'],
    sources: data.sources, sourceRowCounts: data.sourceCounts, sourceDataSha256: data.inputHashes, summary: data.summary,
    csv: { name, bytes: csv.length, sha256: csvHash, encoding: 'UTF-8 BOM', formulaInjectionProtection: 'CSV单元格双引号转义；公式前缀单元格添加单引号。' },
  };
  const created = [];
  try {
    await writeExclusive(csvPath, csv); created.push(csvPath);
    await writeExclusive(sourcePath, `${JSON.stringify(sourceDocument, null, 2)}\n`); created.push(sourcePath);
    const actual = await readFile(csvPath);
    const actualSources = JSON.parse(await readFile(sourcePath, 'utf8'));
    if (actual.length !== csv.length || digest(actual) !== csvHash || actualSources.csv.sha256 !== csvHash || actualSources.csv.bytes !== actual.length || actualSources.month !== month || JSON.stringify(actualSources.summary) !== JSON.stringify(data.summary)) throw new Error('产物落盘后完整性校验失败。');
    return { artifact: { path: csvPath, name, mime: 'text/csv', bytes: actual.length, sha256: csvHash, sourcePath }, summary: data.summary };
  } catch (error) {
    await Promise.allSettled(created.map((filename) => unlink(filename)));
    throw error;
  }
}
