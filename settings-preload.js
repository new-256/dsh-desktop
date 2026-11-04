'use strict';

/**
 * 设置窗桥（0.3.48 · H-07/H-06 配套收敛）
 *
 * 为什么存在：
 *   设置窗持有本应用最高权限的一批通道 —— `plugins:install`（→ pnpm → 包的
 *   postinstall = 代码执行）、`plugins:import-legacy`（同样走 pnpm）、
 *   `backend:rollback-to`（换后端版本）、`plugins:set-path-entry`（改用户 PATH）、
 *   `shell:copy-text`。0.3.47 之前这些方法直接散写在 contextBridge 里，谁想加一条
 *   通道就随手 invoke 一个字符串（无白名单、无入参收敛）。
 *
 * 现在三条纪律：
 *   ① 所有 invoke 只走 `invoke()`，channel 必须命中 `ALLOWED_CHANNELS`。
 *      拼错/未登记的通道**立刻抛错**（开发期禁静默兜底：让缺陷第一时间暴露）。
 *   ② 入参在桥边界做一次类型收敛 —— 只挡类型，不做业务校验（业务校验仍属于主进程：
 *      `settings:set-route` 只接受 official/mirror 等）。
 *   ③ 不暴露通用 `invoke(channel, ...)`，渲染层无法自行编造通道名。
 *
 * 主进程侧：main.js 自 0.3.42 起所有通道都经 `handleIpc()` → `assertOwnedSender()`
 * 校验来源（sender 必须是 mainWindow/settingsWindow 的 webContents，且 origin 必须
 * 是 file: 或本机回环）。审计结论见 04_方案与审计/H-06_H-10_审计.md。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 允许从设置窗发起的 IPC 通道白名单（新增通道必须同时登记到这里）。 */
const ALLOWED_CHANNELS = Object.freeze([
  // 更新 / 外壳状态
  'settings:get',
  'settings:set-route',
  'settings:check-updates',
  'settings:download-updates',
  'settings:set-autostart',
  'settings:open-log',
  'settings:restart-app',
  'settings:open',
  // Node 基座
  'settings:set-node-dist',
  'settings:check-node',
  'settings:download-node',
  // 后端版本
  'backend:list-versions',
  'backend:compat-plan',
  'backend:rollback-to',
  // 插件安装与终端接线
  'plugins:terminal-status',
  'plugins:set-dsh-home-env',
  'plugins:set-path-entry',
  'plugins:write-wrappers',
  'plugins:install',
  'plugins:scan-legacy',
  'plugins:import-legacy',
  // 通用剪贴板（复制命令用）
  'shell:copy-text'
]);

const ALLOWED = new Set(ALLOWED_CHANNELS);

/** 白名单闸门：未登记的通道是开发期缺陷，必须当场炸出来。 */
function invoke(channel, ...args) {
  if (!ALLOWED.has(channel)) {
    throw new Error(`设置窗桥拒绝未列入白名单的通道：${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

/** 类型收敛：字符串（业务语义由主进程判定）。 */
function asText(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`设置窗桥：${name} 必须是字符串，收到 ${value === null ? 'null' : typeof value}`);
  }
  return value;
}

/** 类型收敛：字符串或 null（`downloadNode(null)` = 默认最新版）。 */
function asOptionalText(value, name) {
  if (value === null || value === undefined) return null;
  return asText(value, name);
}

/** 类型收敛：数组（导入旧 Home 的插件清单）。 */
function asArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`设置窗桥：${name} 必须是数组，收到 ${value === null ? 'null' : typeof value}`);
  }
  return value;
}

// 设置窗桥 —— 最小面、只白名单、无 node 能力外泄。
contextBridge.exposeInMainWorld('dshSettings', {
  get: () => invoke('settings:get'),
  setRoute: (route) => invoke('settings:set-route', asText(route, 'route')),
  checkUpdates: () => invoke('settings:check-updates'),
  downloadUpdates: () => invoke('settings:download-updates'),
  setAutostart: (on) => invoke('settings:set-autostart', !!on),
  setNodeDist: (dist) => invoke('settings:set-node-dist', asText(dist, 'dist')),
  checkNode: () => invoke('settings:check-node'),
  downloadNode: (version) => invoke('settings:download-node', asOptionalText(version, 'version')),
  listBackendVersions: () => invoke('backend:list-versions'),
  compatPlan: (version) => invoke('backend:compat-plan', asText(version, 'version')),
  rollbackTo: (version) => invoke('backend:rollback-to', asText(version, 'version')),
  openLog: () => invoke('settings:open-log'),
  restart: () => invoke('settings:restart-app'),
  // 0.3.32 插件安装 / 终端接线 / 旧 Home 迁移
  terminalStatus: () => invoke('plugins:terminal-status'),
  setDshHomeEnv: (on) => invoke('plugins:set-dsh-home-env', !!on),
  setPathEntry: (on) => invoke('plugins:set-path-entry', !!on),
  writeWrappers: () => invoke('plugins:write-wrappers'),
  installPlugin: (spec, profile) => invoke('plugins:install', { spec: asText(spec, 'spec'), profile: asText(profile, 'profile') }),
  scanLegacy: () => invoke('plugins:scan-legacy'),
  importLegacy: (items, profile) => invoke('plugins:import-legacy', { items: asArray(items, 'items'), profile: asText(profile, 'profile') }),
  /**
   * 订阅安装日志。回调内抛错会打断 Electron 的事件派发，因此这里捕获后**显式**
   * 打到渲染层 console（main.js 的 console-message 钩子会把它写进诊断日志），
   * 不是静默吞掉。
   */
  onPluginLog: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('设置窗桥：onPluginLog 需要函数回调');
    const listener = (_event, line) => {
      try { cb(String(line)); }
      catch (err) { console.error('[settings-preload] 插件日志回调抛错:', err); }
    };
    ipcRenderer.on('plugins:log', listener);
    return () => ipcRenderer.removeListener('plugins:log', listener);
  },
  openSettings: () => invoke('settings:open'),
  // 通用剪贴板（供「插件安装与终端」区复制命令用；与手机功能无关）
  copyText: (text) => invoke('shell:copy-text', asText(text, 'text'))
});
