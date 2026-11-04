/**
 * 探针：确认 Cordis 裸包名在【运行时】的真实解析根。
 *
 * 背景：DSH Desktop 启动预检（updater-backend.js preflightBareNameResolution）
 * 只从 dsh-home\profiles\* 向上找 node_modules，判定 @deepseek-ai/dsh-mcp-client
 * "冷启动必然失败"并自动禁用（2026-10-20 19:59 误伤）。
 *
 * 本探针不猜，直接问运行时的 ESM 解析器：
 *   1. cordis-plugin-loader 的 `loader.internal` 在本机后端是否可得
 *      （决定裸名走 internal.import(specifier, ctx.baseUrl) 还是裸 import(specifier)）；
 *   2. 同��个包名在两种父路径下的解析结果：
 *      A. loader 模块所在目录（backend\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\lib\config\tree.js）
 *      B. 家级补丁所在目录（dsh-home\profiles\web）
 *
 * 用法：<node.exe> probe-bare-resolution.mjs
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const BACKEND_DSH = 'C:\\Users\\<user>\\AppData\\Roaming\\DSH Desktop\\backend\\dsh';
const LOADER_TREE = path.join(
  BACKEND_DSH, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'config', 'tree.js'
);
const PROFILE_DIR = 'C:\\Users\\<user>\\AppData\\Roaming\\DSH Desktop\\dsh-home\\profiles\\web';
const PKG = '@deepseek-ai/dsh-mcp-client';

const require = createRequire(pathToFileURL(path.join(BACKEND_DSH, 'noop.js')));

console.log('node:', process.version, 'execArgv:', JSON.stringify(process.execArgv));

// ── 1. loader.internal 可得性 ────────────────────────────────────────────
let internal = null;
try {
  const mod = require('node-addon-require-builtin');
  internal = mod.requireBuiltin('internal/modules/esm/loader');
  console.log('[1] requireBuiltin("internal/modules/esm/loader") => OK',
    'getOrCreateModuleJob:', typeof internal?.getOrCreateModuleJob,
    'getModuleJobForImport:', typeof internal?.getModuleJobForImport);
} catch (e) {
  console.log('[1] requireBuiltin FAILED:', e && e.message);
}
if (internal) {
  const raw = internal.getOrInitializeCascadedLoader?.();
  console.log('[1b] getOrInitializeCascadedLoader =>', raw ? 'OK' : 'undefined');
  const shaped = internal.getOrCreateModuleJob ? 'v2' : internal.getModuleJobForImport ? 'v1' : 'unknown';
  console.log('[1c] loader.internal shape =>', shaped, '→ 裸名走 internal.import(specifier, ctx.baseUrl)');
}

// ── 2. 同一包名、两种父路径的解析结果 ────────────────────────────────────
async function tryImport(label, parentUrl) {
  if (!internal) { console.log(`[2${label}] 无 internal，跳过`); return; }
  try {
    const mod = await internal.import(PKG, parentUrl, {});
    console.log(`[2${label}] OK  ${parentUrl}\n        exports: ${Object.keys(mod).slice(0, 6).join(', ')}`);
  } catch (e) {
    console.log(`[2${label}] FAIL ${parentUrl}\n        ${e && e.code ? e.code : ''} ${String(e && e.message).slice(0, 240)}`);
  }
}

await tryImport('A', pathToFileURL(LOADER_TREE).href);   // 裸 import(specifier) 的等效父路径
await tryImport('B', pathToFileURL(PROFILE_DIR).href + '/'); // internal.import(specifier, ctx.baseUrl)

// ── 3. 目录存在性（与解析器无关的客观事实）────────────────────────────────
for (const p of [
  path.join(BACKEND_DSH, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'),
  path.join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'),
  path.join(PROFILE_DIR, 'node_modules', '@luchenglong', 'cli-bridge'),
  'C:\\Users\\<user>\\AppData\\Roaming\\DSH Desktop\\dsh-home\\node_modules'
]) {
  let isDir = false;
  try { isDir = (await import('node:fs')).statSync(p).isDirectory(); } catch {}
  console.log(`[3] ${isDir ? 'DIR ' : 'MISS'} ${p}`);
}
