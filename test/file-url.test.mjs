import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { isSameFileUrl } from '../src/core/file-url.mjs';

const uiPath = join(process.cwd(), 'src', 'ui', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;

// Electron canonicalizes Windows drive letters on load; import.meta.url may keep them lowercase.
test('同一本机文件 URL 的盘符大小写差异视为相同来源', () => {
  if (process.platform !== 'win32') return;
  const canonical = uiUrl.replace(/^file:\/\/\/([a-z]):/i, (_m, drive) => `file:///${drive.toUpperCase()}:`);
  assert.notEqual(canonical, uiUrl);
  assert.equal(isSameFileUrl(canonical, uiUrl), true);
  assert.equal(isSameFileUrl(uiUrl, canonical), true);
});

test('不同本机文件或非 file URL 不视为相同来源', () => {
  assert.equal(isSameFileUrl(pathToFileURL(`${uiPath}.bak`).href, uiUrl), false);
  assert.equal(isSameFileUrl('https://example.test/src/ui/index.html', uiUrl), false);
  assert.equal(isSameFileUrl(null, uiUrl), false);
  assert.equal(isSameFileUrl(uiUrl, undefined), false);
});
