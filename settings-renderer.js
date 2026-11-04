'use strict';

/**
 * 设置窗渲染脚本（0.3.48 · H-06）
 *
 * 为什么存在：
 *   0.3.47 之前这段脚本**内联**在 settings.html 里，CSP 因此不得不开
 *   `script-src 'unsafe-inline'`；同时插件表/兼容表用 `innerHTML` 拼接
 *   「插件名 / reason / 旧 Home 路径」等**外部字符串**。而设置窗持有
 *   `plugins:install`（→ pnpm → postinstall = 代码执行）、`backend:rollback-to`、
 *   `plugins:set-path-entry` 等高权限 IPC —— 恶意插件名 = 直接把名字变脚本 = 提权。
 *
 * 现在的两条硬纪律（改动时不得破坏）：
 *   ① 任何外部字符串**只**经 `textContent` / `createTextNode` 进入 DOM；
 *      本文件禁止出现 `innerHTML`（含赋值与读取）、`insertAdjacentHTML`、
 *      `outerHTML`、`document.write`。
 *   ② 外部值**不得拼进 CSS 选择器**（选择器注入面）：一率走白名单查表
 *      `pickRadio()` / 固定 id 映射。
 *
 * 注入路径自检清单另见 `修复与借鉴_2026-11-04/04_方案与审计/H06_注入路径自检清单.md`。
 */

/* 0.3.48 · H-06：脚本已加载标记 —— 真机 CSP 冒烟测试的依据（若 CSP 仍拦 'self'
   脚本，这个 dataset 不会出现，测试立刻失败而不是被当成"页面本来就是空的"）。 */
document.documentElement.dataset.rendererLoaded = '1';

const api = window.dshSettings;
// 桥缺失是真缺陷（preload 没生效 / 通道被删），必须立刻炸出来，不允许空桥继续渲染。
if (!api) throw new Error('设置窗桥缺失：settings-preload.js 未生效，拒绝以空桥继续渲染');

const $ = (id) => document.getElementById(id);

// ── DOM 构造工具：外部字符串只能走这里 ──────────────────────────────────────

/** 建一个元素；`text` 一律通过 textContent 写入（永不当 HTML 解析）。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 清空容器（取代 `innerHTML = ''`）。 */
function clear(node) { node.replaceChildren(); }

/** 建 `<option>`，value 与显示文本分别显式赋值。 */
function option(value, label) {
  const node = document.createElement('option');
  node.value = String(value);
  node.textContent = String(label);
  return node;
}

/** 建表格；headers 是表头文本（静态常量），rows 是「单元格节点数组」数组。 */
function buildTable(headers, rows) {
  const table = document.createElement('table');
  const headRow = document.createElement('tr');
  for (const h of headers) headRow.append(el('th', h.className || null, h.text));
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    for (const cell of cells) tr.append(cell);
    tbody.append(tr);
  }
  table.append(headRow, tbody);
  return table;
}

/**
 * 白名单查表选单选：外部值（npmRegistry / nodeDist）**只**用于查表，
 * 不参与选择器拼接 —— `value = 'x"] , body'` 之类构造在这里只会查不到。
 */
function pickRadio(map, value) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(map, value)) return null;
  return $(map[value]);
}

const ROUTE_RADIO_IDS = Object.freeze({ mirror: 'r-mirror', official: 'r-official' });
const NDIST_RADIO_IDS = Object.freeze({ mirror: 'nd-mirror', official: 'nd-official' });

/** 统一的状态提示行。 */
function msg(text, isErr) {
  const node = $('msg');
  node.textContent = text || '';
  node.className = isErr ? 'err' : 'ok';
}

// ══════════════════════════════════════════════════════════════════════════
// 更新设置
// ══════════════════════════════════════════════════════════════════════════

function renderState(s) {
  if (!s) return;
  const versions = s.versions || {};
  const ver = versions.dsh || '未知';
  $('vShell').textContent = (s.shellVersion || '未知') + (s.shellUpdateVersion ? '（可升级 ' + s.shellUpdateVersion + '）' : '');
  $('vCurrent').textContent = ver + (versions.node ? ' · Node ' + versions.node : '');
  $('vLatest').textContent = (s.updateStatus && s.updateStatus.latest) || '未检查';
  $('vStatus').textContent = (s.updateStatus && s.updateStatus.message) || '—';
  if (s.registry) $('routeNote').textContent = '当前生效：' + s.registry.label + '（' + s.registry.url + '）';
  const routeRadio = pickRadio(ROUTE_RADIO_IDS, (s.settings && s.settings.npmRegistry) || 'mirror');
  if (routeRadio) routeRadio.checked = true;
  $('autoStart').checked = !!(s.autoStart);
  if (s.nodeDist) $('ndNote').textContent = '当前生效：' + s.nodeDist.label + '（' + s.nodeDist.url + '）';
  const ndRadio = pickRadio(NDIST_RADIO_IDS, (s.settings && s.settings.nodeDist) || 'mirror');
  if (ndRadio) ndRadio.checked = true;
  $('nCurrent').textContent = versions.node || '未知';
  $('safeModeState').textContent = s.safeMode ? '已启用（仅核心组件）' : '未启用';
}

async function refresh() {
  renderState(await api.get());
}

document.querySelectorAll('input[name=route]').forEach((input) => input.addEventListener('change', async () => {
  const r = await api.setRoute(input.value);
  if (r) { msg('更新路线已切换：' + r.label + '（下次检查/下载生效）'); refresh(); }
  else { msg('切换失败', true); }
}));

$('autoStart').addEventListener('change', async (e) => {
  const ok = await api.setAutostart(e.target.checked);
  if (!ok) { e.target.checked = !e.target.checked; msg('开机自启设置失败', true); }
});

$('btnCheck').addEventListener('click', async () => {
  $('btnCheck').disabled = true; msg('正在检查更新…');
  const res = await api.checkUpdates();
  $('btnCheck').disabled = false;
  if (res && res.busy) { msg('正在检查或下载更新，请稍候', true); return; }
  renderState(await api.get());
  const info = res && res.info;
  const st = res && res.status;
  const gate = res && res.nodeGate;
  const nodeReqEl = $('vNodeReq');
  if (gate && gate.current) {
    const okText = gate.ok ? '满足' : '不满足（请先更新 Node）';
    nodeReqEl.textContent = '≥ ' + gate.required + '（当前 ' + gate.current + '，' + okText + '）';
    nodeReqEl.className = gate.ok ? 'ok' : 'err';
    if (!gate.ok) msg('⚠ 最新后端要求 Node ≥ ' + gate.required + '，当前 ' + gate.current + ' 不满足——请先在下方「Node.js 基座更新」中更新 Node，再更新后端。', true);
  } else {
    nodeReqEl.textContent = '—'; nodeReqEl.className = '';
  }
  if (info && info.updates && info.updates.length) {
    msg('发现新版本：' + info.updates.map((u) => (u.component === 'dsh' ? 'DSH 后端' : u.component) + ' ' + (u.current || '无') + ' → ' + u.latest).join('；') + '。点击「下载并更新」确认下载。');
  } else if (st && st.message) { msg(st.message); }
});

$('btnDownload').addEventListener('click', async () => {
  $('btnDownload').disabled = true; msg('正在处理…');
  const res = await api.downloadUpdates();
  $('btnDownload').disabled = false;
  if (res && res.busy) { msg('正在检查或下载更新，请稍候', true); return; }
  if (res && res.ok === false) msg(res.msg || '没有可下载的更新');
  else if (res && res.ok) refresh(); // 对话框流程已接管；状态刷新
});

$('btnLog').addEventListener('click', () => api.openLog());
$('btnRestart').addEventListener('click', async () => { msg('正在重启…'); await api.restart(); });

// ══════════════════════════════════════════════════════════════════════════
// Node.js 基座更新
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('input[name=ndist]').forEach((input) => input.addEventListener('change', async () => {
  const r = await api.setNodeDist(input.value);
  if (r) { msg('Node 下载源已切换：' + r.label + '（下次检查/下载生效）'); refresh(); }
  else { msg('切换失败', true); }
}));

$('btnNCheck').addEventListener('click', async () => {
  $('btnNCheck').disabled = true; msg('正在检查 Node 更新…');
  const r = await api.checkNode();
  $('btnNCheck').disabled = false;
  if (!r) { msg('检查失败', true); return; }
  if (r.err) { msg('检查 Node 更新失败：' + r.err, true); return; }
  $('nLatest').textContent = r.latest || '未知';
  $('nStaged').textContent = r.staged || '—';
  if (r.required) {
    $('nReqNote').textContent = 'DSH 要求 Node ≥ ' + r.required + '（锁定主版本 ' + (r.pinnedMajor || 24) + '.x，与原生模块 ABI 对齐；可回退主版本内任意版本）';
  }
  const sel = $('nVersions');
  const prev = sel.value;
  clear(sel);
  sel.append(option('', '—（默认最新）—'));
  if (r.available && r.available.length) {
    r.available.forEach((v) => sel.append(option(v, v + (v === r.current ? '（当前）' : ''))));
    if (prev) sel.value = prev;
  }
  if (r.current && r.latest && r.current !== r.latest) msg('发现新版 Node：' + r.current + ' → ' + r.latest + '。点击「下载并暂存所选 Node」下载，重启后生效。');
  else msg('Node 已是最新（' + (r.current || '未知') + '）；如需回退请在下拉框选择更早版本后下载。');
});

$('btnNDownload').addEventListener('click', async () => {
  $('btnNDownload').disabled = true; msg('正在下载 Node 运行时…');
  const r = await api.downloadNode($('nVersions').value || null);
  $('btnNDownload').disabled = false;
  if (r && r.busy) { msg('正在检查或下载更新，请稍候', true); return; }
  if (r && r.ok === false) msg(r.msg || 'Node 下载失败', true);
  else if (r && r.ok) refresh();
});

// ══════════════════════════════════════════════════════════════════════════
// DSH 后端版本管理
// ══════════════════════════════════════════════════════════════════════════

let bvAll = [];

async function loadBackendVersions() {
  const sel = $('bVersions');
  const r = await api.listBackendVersions();
  if (!r || r.err) { clear(sel); sel.append(option('', '列表获取失败')); return; }
  bvAll = r.all || [];
  $('bCount').textContent = bvAll.length;
  $('bCurrent').textContent = r.current || '未知';
  $('bLatest').textContent = r.latest || '—';
  $('bStaged').textContent = r.staged || '—';
  clear(sel);
  if (!bvAll.length) { sel.append(option('', '（无已发布版本）')); return; }
  bvAll.forEach((v) => {
    sel.append(option(v, v + (v === r.current ? '（当前）' : v === r.latest ? '（最新）' : '')));
  });
  if (r.current && bvAll.includes(r.current)) sel.value = r.current;
}

function stateCls(compatible) { return compatible === false ? 'bad' : compatible === null ? 'mid' : 'good'; }
function stateLabel(compatible) { return compatible === false ? '不可用' : compatible === null ? '未验证' : '兼容'; }

/** 兼容性报告表：插件名 / 原因 / Node 版本要求全是外部字符串 → 逐节点 textContent。 */
function renderCompatPlan(r) {
  const plan = r.plan;
  const box = $('compatBox');
  clear(box);

  const summary = plan.summary || {};
  const head = el('div');
  head.append(
    document.createTextNode('目标 ' + plan.target + '（当前 ' + (plan.current || '未知') + '）：插件共 ' + summary.total + ' 个 — '),
    el('span', 'bad', '不可用 ' + summary.incompatible),
    document.createTextNode(' · '),
    el('span', 'mid', '未验证 ' + summary.unverified),
    document.createTextNode(' · '),
    el('span', 'good', '兼容 ' + summary.compatible)
  );
  box.append(head);

  const engines = plan.targetEngines;
  if (engines && engines.current) {
    box.append(el('div', engines.ok ? 'good' : 'bad',
      '目标后端 Node 要求 ≥ ' + engines.required + '（当前 ' + engines.current + (engines.ok ? '，满足）' : '，不满足——请先更新 Node）')));
  }

  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  if (rows.length) {
    box.append(buildTable(
      [{ text: '插件' }, { text: '判定' }, { text: '原因' }],
      rows.map((row) => {
        const nameCell = el('td');
        nameCell.append(document.createTextNode(String(row.name)));
        if (row.installed) {
          nameCell.append(el('div', 'dim', 'v' + row.installed.version + '（' + String(row.installed.installedAt || '').slice(0, 10) + ' 安装）'));
        }
        const stateCell = el('td', stateCls(row.compatible), stateLabel(row.compatible));
        const reasonCell = el('td', null, String(row.reason) + (row.nodeEngine ? '；声明 Node ≥ ' + row.nodeEngine : ''));
        return [nameCell, stateCell, reasonCell];
      })
    ));
  }
  return plan;
}

$('btnBCompat').addEventListener('click', async () => {
  const target = $('bVersions').value;
  if (!target) { msg('请先选择目标版本', true); return; }
  $('btnBCompat').disabled = true; msg('正在分析兼容性…');
  const r = await api.compatPlan(target);
  $('btnBCompat').disabled = false;
  if (!r || r.err) { msg('兼容性分析失败：' + ((r && r.err) || '未知错误'), true); return; }
  renderCompatPlan(r);
  if (r.file) msg('兼容性报告已导出到桌面：' + r.file);
  else msg('兼容性分析完成（报告导出失败，见日志）', true);
});

$('btnBInstall').addEventListener('click', async () => {
  const target = $('bVersions').value;
  if (!target) { msg('请先选择目标版本', true); return; }
  $('btnBInstall').disabled = true; msg('正在下载并暂存 ' + target + '…');
  const r = await api.rollbackTo(target);
  $('btnBInstall').disabled = false;
  if (r && r.busy) { msg('正在检查或下载更新，请稍候', true); return; }
  if (r && r.ok === false) msg(r.msg || '暂存失败', true);
  else if (r && r.ok) { refresh(); loadBackendVersions(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 插件安装与终端（0.3.32）
// ══════════════════════════════════════════════════════════════════════════

let legacyScan = null;

function plog(line, reset) {
  const node = $('pLog');
  if (reset) node.textContent = '';
  else if (node.textContent === '（尚无输出）') node.textContent = '';
  node.textContent += (node.textContent ? '\n' : '') + line;
  node.scrollTop = node.scrollHeight;
}

if (api.onPluginLog) api.onPluginLog((line) => plog(line));

async function loadTerminalStatus() {
  const r = await api.terminalStatus();
  if (!r || r.err) { $('tHome').textContent = (r && r.err) || '读取失败'; return; }
  $('tHome').textContent = r.home || '未知';
  const env = r.env || {};
  const pathSt = r.path || {};
  if (env.pointsHere) { $('tEnv').textContent = '已指向桌面版 Home ✓'; $('tEnv').className = 'v good'; }
  else if (env.set) { $('tEnv').textContent = '已设置但指向别处：' + env.current; $('tEnv').className = 'v bad'; }
  else { $('tEnv').textContent = '未设置（终端里的 dsh 会用 ' + (env.legacyHome || '~/.dsh') + '）'; $('tEnv').className = 'v mid'; }
  $('tEnvToggle').checked = !!env.pointsHere;
  $('tEnvNote').textContent = env.legacyInUse
    ? '检测到 ' + env.legacyHome + ' 已在使用（有插件/会话），因此未自动写入——避免让你原有的独立 CLI 环境"消失"。需要统一时手工勾选。'
    : '未检测到在用的旧 Home，干净机器首次启动已自动写入，README 原文命令即可正确安装。';
  $('tPath').textContent = pathSt.inPath ? ('已加入：' + pathSt.dir) : ('未加入（脚本' + (pathSt.exists ? '已生成' : '未生成') + '：' + (pathSt.dir || '—') + '）');
  $('tPath').className = pathSt.inPath ? 'v good' : 'v mid';
  $('tPathToggle').checked = !!pathSt.inPath;
  $('tCmdWrapper').textContent = r.cmdWrapper || '—';
  $('tCmdPwsh').textContent = r.cmdPwsh || '—';
}

$('btnPInstall').addEventListener('click', async () => {
  const spec = $('pSpec').value.trim();
  if (!spec) { msg('请填写插件名', true); return; }
  // 0.3.48 · H-06：plugins:install 会跑 pnpm（含 postinstall = 代码执行），
  // 这是本窗口最高权限的动作，必须由用户对确切包名显式确认一次。
  const confirmed = window.confirm(
    '即将安装插件：\n\n' + spec + '\n\n' +
    '安装过程会执行该包的安装脚本（postinstall），等同于允许它在你的电脑上运行代码。\n' +
    '确认包名是你信任的来源后再继续。'
  );
  if (!confirmed) { msg('已取消安装：' + spec, true); return; }
  $('btnPInstall').disabled = true;
  plog('──── 安装 ' + spec + ' ────', true);
  msg('正在安装 ' + spec + '…');
  const r = await api.installPlugin(spec, $('pProfile').value);
  $('btnPInstall').disabled = false;
  if (r && r.busy) { msg('已有安装任务在进行，请稍候', true); return; }
  if (r && r.ok) { msg('安装成功：' + spec + '（重启后加载生效）'); loadTerminalStatus(); return; }
  msg('安装失败：' + ((r && (r.msg || (r.timedOut ? '超时' : '详见下方日志'))) || '详见下方日志'), true);
  if (r && r.log) plog(r.log);
});

$('tEnvToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  const r = await api.setDshHomeEnv(on);
  e.target.disabled = false;
  if (r && r.ok) msg(on ? 'DSH_HOME 已写入用户环境变量（新开的终端生效）' : 'DSH_HOME 已移除');
  else msg('操作失败：' + ((r && r.msg) || '未知错误'), true);
  loadTerminalStatus();
});

$('tPathToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  const r = await api.setPathEntry(on);
  e.target.disabled = false;
  if (r && r.ok) msg(on ? '包装器已加入用户 PATH（新开的终端里可用 dsh-desktop）' : '包装器已移出 PATH');
  else msg('操作失败：' + ((r && r.msg) || '未知错误'), true);
  loadTerminalStatus();
});

function copyToClipboard(text, okMsg) {
  const done = () => msg(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      const holder = document.createElement('textarea');
      holder.value = text; document.body.appendChild(holder); holder.select();
      document.execCommand('copy'); document.body.removeChild(holder); done();
    });
    return;
  }
  const holder = document.createElement('textarea');
  holder.value = text; document.body.appendChild(holder); holder.select();
  document.execCommand('copy'); document.body.removeChild(holder); done();
}
$('btnCopyWrapper').addEventListener('click', () => copyToClipboard($('tCmdWrapper').textContent, '包装器命令已复制'));
$('btnCopyPwsh').addEventListener('click', () => copyToClipboard($('tCmdPwsh').textContent, 'PowerShell 命令已复制'));

/** 旧 Home 扫描结果：home / name / version 均为外部字符串 → 逐节点 textContent。 */
function renderLegacyScan(scan) {
  const box = $('legacyBox');
  clear(box);
  if (scan.sameAsDesktop) { box.append(el('div', 'good', '旧 Home 与桌面 Home 是同一目录，无需迁移。')); msg('无需迁移'); return; }
  if (!scan.exists) { box.append(el('div', 'good', '未发现旧 Home（' + scan.home + '），无需迁移。')); msg('未发现旧 Home'); return; }
  if (!scan.total) { box.append(el('div', 'good', '旧 Home 存在，但没有桌面版看不到的插件。')); msg('无孤儿插件'); return; }

  const intro = el('div');
  intro.append(
    document.createTextNode('旧 Home '),
    el('code', null, scan.home),
    document.createTextNode(' 中有 '),
    el('b', 'mid', scan.total),
    document.createTextNode(' 个插件桌面版看不到：')
  );
  box.append(intro);

  const orphans = Array.isArray(scan.orphans) ? scan.orphans : [];
  box.append(buildTable(
    [{ text: '' }, { text: '插件' }, { text: '版本' }, { text: '形态' }],
    orphans.map((o, i) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'lgk';
      cb.dataset.i = String(i);
      cb.checked = !!o.installable;
      cb.disabled = !o.installable;
      const checkCell = el('td', 'col-check');
      checkCell.append(cb);
      const shapeCell = el('td', o.installable ? 'good' : 'bad', o.installable ? 'npm 包（可导入）' : '本地 link（需手工）');
      return [checkCell, el('td', null, String(o.name)), el('td', null, o.version || '—'), shapeCell];
    })
  ));
  msg('扫描完成：发现 ' + scan.total + ' 个孤儿插件，勾选后点「导入所选」');
}

$('btnScanLegacy').addEventListener('click', async () => {
  $('btnScanLegacy').disabled = true; msg('正在扫描旧 Home…');
  const r = await api.scanLegacy();
  $('btnScanLegacy').disabled = false;
  if (!r || !r.ok) { msg('扫描失败：' + ((r && r.msg) || '未知错误'), true); return; }
  legacyScan = r.scan;
  renderLegacyScan(legacyScan);
});

/** 导入结果表：name / reason 是外部字符串 → 逐节点 textContent。 */
function renderImportResults(results) {
  const box = $('legacyBox');
  clear(box);
  box.append(buildTable(
    [{ text: '插件' }, { text: '结果' }, { text: '说明' }],
    results.map((x) => {
      const outcome = x.ok ? '成功' : x.skipped ? '跳过' : '失败';
      return [el('td', null, String(x.name)), el('td', x.ok ? 'good' : x.skipped ? 'mid' : 'bad', outcome), el('td', null, String(x.reason))];
    })
  ));
}

$('btnImportLegacy').addEventListener('click', async () => {
  if (!legacyScan || !legacyScan.orphans || !legacyScan.orphans.length) { msg('请先扫描旧 Home', true); return; }
  const picked = Array.from(document.querySelectorAll('.lgk'))
    .filter((cb) => cb.checked)
    .map((cb) => legacyScan.orphans[Number(cb.dataset.i)]);
  if (!picked.length) { msg('请至少勾选一个插件', true); return; }
  // 0.3.48 · H-06：批量导入同样走 pnpm（含 postinstall = 代码执行），显式确认一次。
  const confirmed = window.confirm(
    '即将导入 ' + picked.length + ' 个插件：\n\n' + picked.map((p) => '· ' + String(p.name)).join('\n') + '\n\n' +
    '导入会执行这些包的安装脚本（postinstall），等同于允许它们在你的电脑上运行代码。'
  );
  if (!confirmed) { msg('已取消导入（' + picked.length + ' 个）', true); return; }
  $('btnImportLegacy').disabled = true;
  plog('──── 导入 ' + picked.length + ' 个插件 ────', true);
  msg('正在导入 ' + picked.length + ' 个插件…');
  const r = await api.importLegacy(picked, 'web');
  $('btnImportLegacy').disabled = false;
  if (r && r.busy) { msg('已有安装任务在进行，请稍候', true); return; }
  if (!r || !r.ok) { msg('导入失败：' + ((r && r.msg) || '未知错误'), true); return; }
  const s = r.summary || {};
  msg('导入完成：成功 ' + s.ok + ' / 失败 ' + s.failed + ' / 跳过 ' + s.skipped + (r.file ? '。报告已导出到桌面。' : ''));
  if (Array.isArray(s.results)) renderImportResults(s.results);
});

// ── 初始化 ─────────────────────────────────────────────────────────────────
refresh();
loadBackendVersions();
loadTerminalStatus();
