/**
 * 探针：直接以 MCP 协议（stdio）问一个 MCP server 它提供哪些工具。
 *
 * 用途：2026-10-21 现场核查 —— 家级补丁的 5 条 MCP 条目已被 HMR 热加载挂载
 * （5 个 MCP server 进程在 21:08:53 启动），但 mcp__mimo__* 在当前会话里
 * 报 "unknown tool"。本探针绕开会话，直接问服务器本身，看它到底提供哪些工具名。
 *
 * 用法：node probe-mcp-tools.mjs <server.mjs> [args...]
 */

import { spawn } from 'node:child_process';

const [serverPath, ...serverArgs] = process.argv.slice(2);
if (!serverPath) {
  console.error('用法: node probe-mcp-tools.mjs <server.mjs> [args...]');
  process.exit(2);
}

const child = spawn(process.execPath, [serverPath, ...serverArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let buf = '';
const pending = new Map();
let stderr = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => { stderr += d.toString(); });

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const p = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const timeout = setTimeout(() => {
  console.log('超时退出。stderr 前 400 字：\n' + stderr.slice(0, 400));
  child.kill();
  process.exit(1);
}, 15000);

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0' },
});
console.log('initialize =>', JSON.stringify(init.result?.serverInfo ?? init.error));
notify('notifications/initialized');

const tools = await request('tools/list', {});
const names = (tools.result?.tools || []).map((t) => t.name);
console.log('tools/list =>', names.length ? names.join(', ') : JSON.stringify(tools.error ?? '(空)'));

clearTimeout(timeout);
child.kill();
process.exit(0);
