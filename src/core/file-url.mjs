// 本机文件 URL 比对：Windows 下盘符大小写不影响同一文件，Electron 加载后返回的 URL
// 可能把路径规范化为大写盘符（file:///D:/...），而 pathToFileURL 由 import.meta.url 推导时
// 可能保留小写（file:///d:/...）。只规范化本地文件 URL，远程 URL 一律不匹配。
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export function isSameFileUrl(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  try {
    if (!/^file:\/\//i.test(actual) || !/^file:\/\//i.test(expected)) return false;
    return normalize(fileURLToPath(actual)) === normalize(fileURLToPath(expected));
  } catch {
    return false;
  }
}
