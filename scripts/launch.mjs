import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let binary = process.env.YUANYU_ELECTRON_PATH;
if (!binary) {
  try { binary = require('electron'); } catch { /* explicit error below */ }
}
if (!binary || !existsSync(binary)) {
  process.stderr.write('请运行 npm install 安装独立依赖，或设置 YUANYU_ELECTRON_PATH 为本机已有 Electron 可执行文件。\n');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env, windowsHide: process.argv.includes('--smoke') });
const timeout=process.argv.includes('--smoke') ? setTimeout(()=>{process.stderr.write('桌面集成验证超时，已停止本次测试进程。\n');child.kill();process.exitCode=1;},120000) : null;
child.on('error', () => {if(timeout)clearTimeout(timeout);process.stderr.write('Electron 启动失败。\n'); process.exitCode = 1; });
child.on('exit', code => {if(timeout)clearTimeout(timeout);process.exitCode = code ?? 1; });
