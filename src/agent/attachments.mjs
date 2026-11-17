// Task file attachments: strict type allowlist (no video), size caps and multimodal message parts.
const fail = code => Object.assign(new Error(code), { code });

// extension(without dot) -> { mediaType, kind }
export const ATTACHMENT_TYPES = Object.freeze({
  png: { mediaType: 'image/png', kind: 'image' },
  jpg: { mediaType: 'image/jpeg', kind: 'image' },
  jpeg: { mediaType: 'image/jpeg', kind: 'image' },
  webp: { mediaType: 'image/webp', kind: 'image' },
  gif: { mediaType: 'image/gif', kind: 'image' },
  bmp: { mediaType: 'image/bmp', kind: 'image' },
  pdf: { mediaType: 'application/pdf', kind: 'document' },
  doc: { mediaType: 'application/msword', kind: 'document' },
  docx: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
  xls: { mediaType: 'application/vnd.ms-excel', kind: 'document' },
  xlsx: { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document' },
  ppt: { mediaType: 'application/vnd.ms-powerpoint', kind: 'document' },
  pptx: { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document' },
  txt: { mediaType: 'text/plain', kind: 'text' },
  md: { mediaType: 'text/markdown', kind: 'text' },
  csv: { mediaType: 'text/csv', kind: 'text' },
  json: { mediaType: 'application/json', kind: 'text' },
  log: { mediaType: 'text/plain', kind: 'text' },
  mp3: { mediaType: 'audio/mpeg', kind: 'audio' },
  wav: { mediaType: 'audio/wav', kind: 'audio' },
  m4a: { mediaType: 'audio/mp4', kind: 'audio' },
  ogg: { mediaType: 'audio/ogg', kind: 'audio' },
});
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', '3gp', 'rmvb']);
export const ATTACHMENT_MAX_FILES = 6;
export const ATTACHMENT_MAX_BYTES_PER_FILE = 3 * 1024 * 1024;
export const ATTACHMENT_MAX_BYTES_TOTAL = 9 * 1024 * 1024;
const TEXT_EXCERPT_CHARS = 20000;

const extensionOf = name => { const index = name.lastIndexOf('.'); return index > 0 ? name.slice(index + 1).toLowerCase() : ''; };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Renderer passes data URLs; decode and verify every claim before anything is persisted or sent. */
export function validateAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > ATTACHMENT_MAX_FILES) throw fail('ATTACHMENT_LIMIT');
  let total = 0;
  const seen = new Set();
  return input.map((entry, index) => {
    if (!plain(entry) || !['name', 'mediaType', 'size', 'data'].every(key => Object.hasOwn(entry, key))) throw fail('ATTACHMENT_INVALID');
    const name = String(entry.name ?? '');
    if (!/^[^\\/:*?"<>|\u0000-\u001F]{1,120}$/.test(name) || name.endsWith('.') || name === '.' || name === '..') throw fail('ATTACHMENT_NAME_INVALID');
    const type = ATTACHMENT_TYPES[extensionOf(name)];
    if (!type) throw fail(VIDEO_EXTENSIONS.has(extensionOf(name)) ? 'ATTACHMENT_VIDEO_UNSUPPORTED' : 'ATTACHMENT_TYPE_UNSUPPORTED');
    if (entry.mediaType !== type.mediaType) throw fail('ATTACHMENT_TYPE_UNSUPPORTED');
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > ATTACHMENT_MAX_BYTES_PER_FILE) throw fail('ATTACHMENT_TOO_LARGE');
    total += entry.size;
    if (total > ATTACHMENT_MAX_BYTES_TOTAL) throw fail('ATTACHMENT_TOO_LARGE');
    if (typeof entry.data !== 'string' || !entry.data.startsWith(`data:${type.mediaType};base64,`)) throw fail('ATTACHMENT_DATA_INVALID');
    let buffer;
    try { buffer = Buffer.from(entry.data.slice(`data:${type.mediaType};base64,`.length), 'base64'); } catch { throw fail('ATTACHMENT_DATA_INVALID'); }
    if (buffer.length !== entry.size || !buffer.length) throw fail('ATTACHMENT_DATA_INVALID');
    if (seen.has(name.toLowerCase())) throw fail('ATTACHMENT_DUPLICATE');
    seen.add(name.toLowerCase());
    return { id: `att-${index + 1}`, name, mediaType: type.mediaType, kind: type.kind, size: entry.size, data: entry.data, buffer };
  });
}

/** Chat Completions content parts for the first user message. Images ride as data URLs; text-like files as bounded excerpts. */
export function buildAttachmentParts(attachments) {
  const parts = [];
  for (const item of attachments) {
    if (item.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: item.data } });
      continue;
    }
    if (item.kind === 'text') {
      // Invalid UTF-8 becomes U+FFFD via toString; the excerpt stays a bounded plain-text block either way.
      const excerpt = item.buffer.toString('utf8').slice(0, TEXT_EXCERPT_CHARS);
      parts.push({ type: 'text', text: `[附件 ${item.name}（${item.mediaType}，${item.size} 字节）]\n${excerpt}` });
      continue;
    }
    parts.push({ type: 'text', text: `[附件 ${item.name}（${item.mediaType}，${item.size} 字节）] 已随任务提供；当前版本不解析其正文，仅登记文件名与类型。]` });
  }
  return parts;
}

/** Metadata persisted on the task record; file bytes stay in the attachment directory. */
export function attachmentRecords(attachments) {
  return attachments.map(item => ({ id: item.id, name: item.name, mediaType: item.mediaType, kind: item.kind, size: item.size }));
}
