// 检查指定任务目录（模糊匹配）下的 session.jsonl.zstd 内容
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const sessRoot = 'C:/Users/lcl/AppData/Roaming/DSH Desktop/dsh-home/sessions';
const needle = process.argv[2];
const dirs = readdirSync(sessRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.includes(needle));
if (!dirs.length) { console.log('no matching session dir for', needle); process.exit(1); }
const dir = join(sessRoot, dirs[0].name);
console.log('dir:', dir);
const buf = readFileSync(join(dir, 'session.jsonl.zstd'));
const text = zstdDecompressSync(buf).toString('utf8');
for (const line of text.trim().split('\n')) {
  if (!line) continue;
  let e;
  try { e = JSON.parse(line); } catch { console.log('[unparsable]', line.slice(0, 200)); continue; }
  const m = e.message ?? e;
  const role = m.role ?? e.type ?? '?';
  let preview = '';
  if (typeof m.content === 'string') preview = m.content;
  else if (Array.isArray(m.content)) preview = m.content.map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'tool_use' || c.type === 'tool-call') return `<tool:${c.name}>`;
    if (c.type === 'tool_result' || c.type === 'tool-result') return `<result:${c.toolCallId?.slice(0, 8) ?? ''}>`;
    return `<${c.type}>`;
  }).join(' | ');
  else preview = JSON.stringify(m).slice(0, 200);
  console.log(`[${role}] ${preview.slice(0, 400)}`);
}
