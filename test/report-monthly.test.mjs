import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { aggregateMonthlyRows, buildMonthlyReport, csvCell, resolveArtifactPath } from '../src/runtime/report.mjs';

function inputs() {
  const source = (systemId, port, route) => ({ systemId, url: `http://127.0.0.1:${port}/${route}?month=2026-10`, month: '2026-10', readAt: '2026-11-05T00:00:00.000Z' });
  return {
    month: '2026-10',
    procurement: { source: source('procurement', 15331, 'orders'), rows: [
      { poNumber: 'PO-1', supplier: '=HYPERLINK("https://example.com")', orderDate: '2026-10-02', status: '已审核', amountCents: 101 },
      { poNumber: 'PO-2', supplier: '第二供应商', orderDate: '2026-10-03', status: '已审核', amountCents: 299 },
      { poNumber: 'PO-3', supplier: '第三供应商', orderDate: '2026-10-04', status: '已审核', amountCents: 500 },
      { poNumber: 'PO-4', supplier: '待审供应商', orderDate: '2026-10-05', status: '待审核', amountCents: 10000 },
    ] },
    warehouse: { source: source('warehouse', 15332, 'receipts'), rows: [
      { receiptNumber: 'GR-1', poNumber: 'PO-1', receivedDate: '2026-10-08', status: '已入库', amountCents: 101 },
      { receiptNumber: 'GR-2', poNumber: 'PO-2', receivedDate: '2026-10-09', status: '已入库', amountCents: 100 },
      { receiptNumber: 'GR-3', poNumber: 'PO-4', receivedDate: '2026-10-10', status: '已入库', amountCents: 10000 },
    ] },
  };
}

test('integer-cent aggregation matches only approved PO and flags partial and missing receipt', () => {
  const result = aggregateMonthlyRows(inputs());
  assert.deepEqual(result.summary, { month: '2026-10', orderCount: 3, receiptCount: 2, orderedCents: 900, receivedCents: 201, outstandingCents: 699, unmatchedCount: 1, partialCount: 1, overReceivedCount: 0, excludedOrderCount: 1, ignoredReceiptCount: 1 });
  assert.match(result.rows[2].matchStatus, /缺少入库记录/);
  const wrongMonth = inputs(); wrongMonth.warehouse.source.month = '2026-09';
  assert.throws(() => aggregateMonthlyRows(wrongMonth));
  const duplicate = inputs(); duplicate.warehouse.rows.push(duplicate.warehouse.rows[0]);
  assert.throws(() => aggregateMonthlyRows(duplicate));
  const overflow = inputs(); overflow.procurement.rows[0].amountCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => aggregateMonthlyRows(overflow), /安全整数/);
});

test('CSV neutralizes spreadsheet formulas including whitespace and quotes cells', () => {
  for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(1)', ' \t=HYPERLINK("x")', '\r\n@x']) assert.match(csvCell(value), /^"'/);
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell('1.01'), '"1.01"');
});

test('report emits unique files, declared sources, exact decimal amounts and verified digest', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'yuanyu-report-test-'));
  try {
    const first = await buildMonthlyReport({ ...inputs(), outputDir });
    const second = await buildMonthlyReport({ ...inputs(), outputDir });
    assert.notEqual(first.artifact.path, second.artifact.path);
    assert.equal(path.dirname(first.artifact.path), await realpath(outputDir));
    assert.equal(path.dirname(first.artifact.sourcePath), await realpath(outputDir));
    const csv = await readFile(first.artifact.path);
    assert.equal(first.artifact.sha256, createHash('sha256').update(csv).digest('hex'));
    assert.equal(first.artifact.bytes, csv.length);
    const text = csv.toString('utf8');
    assert.match(text, /"1\.01"/); assert.match(text, /"2\.99"/); assert.match(text, /"'=/); assert.doesNotMatch(text, /待审供应商/);
    const sources = JSON.parse(await readFile(first.artifact.sourcePath, 'utf8'));
    assert.match(sources.classification, /非正式财务报表/);
    assert.equal(sources.csv.sha256, first.artifact.sha256);
    assert.equal(sources.sources.warehouse.month, '2026-10');
    assert.deepEqual(sources.summary, first.summary);
    assert.doesNotMatch(JSON.stringify(sources), /password|demo123/);
    assert.throws(() => resolveArtifactPath(outputDir, '../outside.csv'));
    assert.throws(() => resolveArtifactPath('relative', 'result.csv'));
    const linked = path.join(outputDir, 'linked');
    const real = path.join(outputDir, 'real'); await mkdir(real);
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildMonthlyReport({ ...inputs(), outputDir: path.join(linked, 'nested') }), /符号链接|目录联接/);
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
