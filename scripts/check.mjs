import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git','node_modules','output','.playwright-cli'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
const all = await files(root);
for (const path of all.filter(p => ['.mjs','.cjs','.js'].includes(extname(p)))) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path}\n${result.stderr}`);
}
for (const path of all.filter(p => extname(p) === '.md')) {
  const text = await readFile(path,'utf8');
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(match[1])) continue;
    await readFile(resolve(dirname(path), match[1]));
  }
}
console.log(`语法与文档本地链接检查通过：${all.length} 个文件。`);
