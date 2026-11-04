'use strict';

/**
 * H-06 静态结构门禁：设置窗「外部字符串 → DOM」注入面 + CSP + 桥白名单。
 *
 * 为什么存在：H-06 的验收依据是「注入路径自检清单」必须覆盖全部位置（漏一处即失败）。
 * 本脚本把清单做成可执行断言，任何人往设置窗新增一处 DOM 写入，都能立刻在这里看到。
 *
 * 断言：
 *   A. settings.html：CSP 串精确符合、无内联 <script>、无 on* 内联属性、无 innerHTML。
 *   B. settings-renderer.js：无 innerHTML/outerHTML/insertAdjacentHTML/document.write/eval；
 *      无「选择器拼接变量」；引用的 DOM id 全部存在于 settings.html。
 *   C. settings-preload.js：invoke 通道全部命中白名单；不暴露通用 invoke；
 *      每个通道在主进程侧都经 handleIpc（sender 校验）注册。
 *   D. 注入路径自检清单文档存在，且逐个点名全部汇点 id。
 *
 * 用法：node scripts/test-h06-settings-dom.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调），超时立即退出并打印卡死位置。
 */

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-h06] 超时 ${TIMEOUT_MS}ms，卡在最后一步断言之前，强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);
watchdog.unref();

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'settings.html');
const RENDERER_PATH = path.join(ROOT, 'settings-renderer.js');
const PRELOAD_PATH = path.join(ROOT, 'settings-preload.js');
const MAIN_PATH = path.join(ROOT, 'main.js');
const CHECKLIST_PATH = path.join(ROOT, '修复与借鉴_2026-11-04', '04_方案与审计', 'H06_注入路径自检清单.md');

const CSP_REQUIRED = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

/**
 * 设置窗全部「外部字符串 → DOM」汇点（＝H-06 验收清单，漏一处即失败）。
 * 每个 id 都必须在 settings.html 里存在，并在自检清单文档里被点名。
 */
const DOM_SINKS = [
  'vShell',          // shellVersion / shellUpdateVersion
  'vCurrent',        // versions.dsh / versions.node
  'vLatest',         // updateStatus.latest
  'vStatus',         // updateStatus.message
  'routeNote',       // registry.label / registry.url
  'vNodeReq',        // nodeGate.required / nodeGate.current
  'msg',             // 更新/检查/安装等回包文案
  'ndNote',          // nodeDist.label / nodeDist.url
  'nCurrent',        // versions.node
  'nLatest',         // checkNode().latest
  'nStaged',         // checkNode().staged
  'nReqNote',        // required / pinnedMajor
  'nVersions',       // available[] / current（option 文本）
  'bCount',          // 后端版本总数
  'bCurrent',        // 当前后端版本
  'bLatest',         // 最新后端版本
  'bStaged',         // 暂存后端版本
  'bVersions',       // all[] / current / latest（option 文本）
  'compatBox',       // 插件名 / reason / installed.version / nodeEngine
  'pLog',            // plugins:log 原始行
  'tHome',           // 桌面版 Home 路径
  'tEnv',            // DSH_HOME 现值 / legacyHome
  'tEnvNote',        // legacyHome
  'tPath',           // 包装器目录
  'tCmdWrapper',     // 包装器命令文本
  'tCmdPwsh',        // PowerShell 命令文本
  'legacyBox',       // 旧 Home 路径 / 孤儿插件 name / version / 导入结果 name / reason
  'safeModeState'    // safeMode 布尔
];

/** 选择器注入面：外部值不得拼进 CSS 选择器，只允许白名单查表。 */
const SELECTOR_TABLES = ['ROUTE_RADIO_IDS', 'NDIST_RADIO_IDS', 'pickRadio'];

const results = [];
function check(name, ok, detail) {
  // 通过时只回显「实际：…」这类观测值；失败时把「缺失/未找到」等诊断也打出来
  const showDetail = detail && (!ok || detail.startsWith('实际'));
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`[${tag}] ${name}${showDetail ? ' — ' + detail : ''}\n`);
  return ok;
}

/**
 * 去掉注释（// 与 /* *\/），只留可执行代码，再去断言禁用 API。
 * 为什么需要：文件头注释里会写「本文件禁止 innerHTML」这类字样，按裸词扫描会误报。
 * 该扫描器只处理字符串与注释，不处理正则字面量 —— 被扫的两个文件都不含正则字面量。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'template'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') { if (ch === '\n') { state = 'code'; out += ch; } i += 1; continue; }
    if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i += 2; } else { i += 1; } continue; }
    // 字符串态：原样保留，处理转义与结束引号
    out += ch;
    if (ch === '\\') { out += src[i + 1] || ''; i += 2; continue; }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
      state = 'code';
    }
    i += 1;
  }
  return out;
}

function readFileOrFail(file) {
  if (!fs.existsSync(file)) {
    check('文件存在：' + path.relative(ROOT, file), false, '文件缺失');
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

// ── A. settings.html ───────────────────────────────────────────────────────
const html = readFileOrFail(HTML_PATH);
let htmlOk = !!html;
if (html) {
  const cspMatch = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/.exec(html);
  const csp = cspMatch ? cspMatch[1] : '(无 CSP meta)';
  htmlOk = check('A1 CSP meta 存在且串完全一致', csp === CSP_REQUIRED, '实际：' + csp) && htmlOk;

  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  htmlOk = check('A2 无内联 <script>', inlineScripts.length === 0, '实际命中：' + JSON.stringify(inlineScripts)) && htmlOk;

  const externalScripts = html.match(/<script\b[^>]*src="settings-renderer\.js"[^>]*>\s*<\/script>/gi) || [];
  htmlOk = check('A3 引用外提脚本 settings-renderer.js', externalScripts.length === 1, '实际命中：' + externalScripts.length) && htmlOk;

  const inlineHandlers = html.match(/\son[a-z]+\s*=/gi) || [];
  htmlOk = check('A4 无 on* 内联事件属性', inlineHandlers.length === 0, '实际命中：' + JSON.stringify(inlineHandlers)) && htmlOk;

  htmlOk = check('A5 settings.html 内无 innerHTML', !/innerHTML/.test(html),
    '实际命中：' + ((html.match(/innerHTML/g) || []).length)) && htmlOk;

  htmlOk = check('A6 无 script-src unsafe-inline / unsafe-eval', !/unsafe-inline[^"]*'\s*;?\s*script-src/.test(csp) && !/script-src[^;"]*unsafe-inline/.test(csp) && !/unsafe-eval/.test(csp),
    '实际：' + csp) && htmlOk;

  const missingIds = DOM_SINKS.filter((id) => !new RegExp(`id="${id}"`).test(html));
  htmlOk = check('A7 注入路径汇点 id 全部存在于 settings.html', missingIds.length === 0,
    '缺失：' + JSON.stringify(missingIds)) && htmlOk;
}

// ── B. settings-renderer.js ────────────────────────────────────────────────
const renderer = readFileOrFail(RENDERER_PATH);
const rendererCode = renderer ? stripComments(renderer) : '';
let rendererOk = !!renderer;
if (renderer) {
  const forbidden = [
    ['innerHTML', /innerHTML/g],
    ['outerHTML', /outerHTML/g],
    ['insertAdjacentHTML', /insertAdjacentHTML/g],
    ['document.write', /document\.write\s*\(/g],
    ['eval(', /\beval\s*\(/g],
    ['new Function', /new\s+Function\s*\(/g]
  ];
  for (const [label, re] of forbidden) {
    const hits = rendererCode.match(re) || [];
    rendererOk = check(`B1 可执行代码里无 ${label}`, hits.length === 0, '实际命中：' + hits.length) && rendererOk;
  }

  const selectorConcat = rendererCode.match(/querySelector(?:All)?\(\s*[^)]*\+/g) || [];
  rendererOk = check('B2 无选择器拼接变量', selectorConcat.length === 0, '实际命中：' + JSON.stringify(selectorConcat)) && rendererOk;
  for (const table of SELECTOR_TABLES) {
    rendererOk = check(`B3 白名单查表存在：${table}`, rendererCode.includes(table), '未找到 ' + table) && rendererOk;
  }

  // 渲染脚本引用的 DOM id 必须都存在于 settings.html（防止外提后 id 写错变成静默失效）
  const referencedIds = Array.from(new Set((rendererCode.match(/\$\('([^']+)'\)/g) || []).map((m) => /'([^']+)'/.exec(m)[1])));
  const missingInHtml = html ? referencedIds.filter((id) => !new RegExp(`id="${id}"`).test(html)) : [];
  rendererOk = check('B4 渲染脚本引用的 DOM id 全部存在（共 ' + referencedIds.length + ' 个）', missingInHtml.length === 0,
    '缺失：' + JSON.stringify(missingInHtml)) && rendererOk;

  // 外部字符串必须只经 textContent / createTextNode 进入 DOM
  rendererOk = check('B5 使用 textContent 写外部字符串', /\.textContent\s*=/.test(rendererCode), '未见 textContent 赋值') && rendererOk;

  // 高权限安装动作必须有用户显式确认（H-06 建议项）
  rendererOk = check('B6 plugins:install 前有 window.confirm 确认',
    /window\.confirm\(/.test(rendererCode) && /installPlugin/.test(rendererCode), '未找到确认逻辑') && rendererOk;
}

// ── C. settings-preload.js ─────────────────────────────────────────────────
const preload = readFileOrFail(PRELOAD_PATH);
const preloadCode = preload ? stripComments(preload) : '';
let preloadOk = !!preload;
if (preload) {
  const whitelistBlock = /const ALLOWED_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(preloadCode);
  const allowed = whitelistBlock
    ? Array.from(new Set((whitelistBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))))
    : [];
  preloadOk = check('C1 白名单 ALLOWED_CHANNELS 存在且有内容', allowed.length > 0, '实际条目数：' + allowed.length) && preloadOk;

  const invoked = Array.from(new Set((preloadCode.match(/invoke\('([^']+)'/g) || []).map((s) => /'([^']+)'/.exec(s)[1])));
  const unlisted = invoked.filter((c) => !allowed.includes(c));
  preloadOk = check('C2 所有 invoke 通道都在白名单内（共 ' + invoked.length + ' 个通道）', unlisted.length === 0,
    '越界通道：' + JSON.stringify(unlisted)) && preloadOk;

  // 不得绕过 helper 直接 ipcRenderer.invoke( 拼通道
  const directInvokes = (preloadCode.match(/ipcRenderer\.invoke\(/g) || []).length;
  preloadOk = check('C3 仅 helper 内出现 ipcRenderer.invoke', directInvokes === 1, '实际：' + directInvokes) && preloadOk;

  const exposedKeys = /exposeInMainWorld\('dshSettings',\s*\{([\s\S]*)\}\);/.exec(preloadCode);
  const genericInvoke = exposedKeys ? /^\s*invoke\s*:/m.test(exposedKeys[1]) : false;
  preloadOk = check('C4 不暴露通用 invoke/send', !!exposedKeys && !genericInvoke && !/\bsend\s*:/.test(exposedKeys[1]), '桥面出现了通用通道') && preloadOk;

  // 主进程侧 sender 校验：每个通道必须经 handleIpc 注册（0.3.42 起）
  const main = readFileOrFail(MAIN_PATH);
  if (main) {
    const handlerBlock = /function handleIpc\(channel, listener\) \{[\s\S]*?assertOwnedSender\(event, channel\)[\s\S]*?\n\}/.exec(main);
    preloadOk = check('C5 主进程 handleIpc 内置 assertOwnedSender 校验', !!handlerBlock, '未找到 handleIpc/assertOwnedSender') && preloadOk;
    const notRegistered = allowed.filter((c) => !new RegExp(`handleIpc\\('${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(main));
    preloadOk = check('C6 白名单通道均在主进程用 handleIpc 注册', notRegistered.length === 0,
      '未用 handleIpc 注册：' + JSON.stringify(notRegistered)) && preloadOk;
    // 裸 ipcMain.handle 只允许存在 1 处 —— 就是 handleIpc 包装器自身，不允许旁路
    const bareHandles = (main.match(/^\s*ipcMain\.handle\(/gm) || []).length;
    preloadOk = check('C7 裸 ipcMain.handle 仅 handleIpc 包装器内 1 处（无旁路注册）', bareHandles === 1 && !!handlerBlock,
      '实际裸注册处数：' + bareHandles) && preloadOk;
  }
}

// ── D. 注入路径自检清单文档 ────────────────────────────────────────────────
const checklist = readFileOrFail(CHECKLIST_PATH);
let checklistOk = !!checklist;
if (checklist) {
  const missing = DOM_SINKS.filter((id) => !checklist.includes(id));
  checklistOk = check('D1 自检清单逐个点名全部 ' + DOM_SINKS.length + ' 个汇点', missing.length === 0,
    '清单缺失：' + JSON.stringify(missing)) && checklistOk;
  checklistOk = check('D2 自检清单写明 CSP 目标串', checklist.includes(CSP_REQUIRED), '未含目标 CSP 串') && checklistOk;
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n[test-h06] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
process.stdout.write('[test-h06] 全部通过\n');
process.exit(0);
