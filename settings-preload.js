'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Settings window bridge — minimal, typed, no node access in the renderer.
contextBridge.exposeInMainWorld('dshSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setRoute: (route) => ipcRenderer.invoke('settings:set-route', route),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  downloadUpdates: () => ipcRenderer.invoke('settings:download-updates'),
  setAutostart: (on) => ipcRenderer.invoke('settings:set-autostart', !!on),
  setNodeDist: (dist) => ipcRenderer.invoke('settings:set-node-dist', dist),
  checkNode: () => ipcRenderer.invoke('settings:check-node'),
  downloadNode: (version) => ipcRenderer.invoke('settings:download-node', version || null),
  listBackendVersions: () => ipcRenderer.invoke('backend:list-versions'),
  compatPlan: (version) => ipcRenderer.invoke('backend:compat-plan', version),
  rollbackTo: (version) => ipcRenderer.invoke('backend:rollback-to', version),
  openLog: () => ipcRenderer.invoke('settings:open-log'),
  restart: () => ipcRenderer.invoke('settings:restart-app'),
  // 0.3.32 插件安装 / 终端接线 / 旧 Home 迁移
  terminalStatus: () => ipcRenderer.invoke('plugins:terminal-status'),
  setDshHomeEnv: (on) => ipcRenderer.invoke('plugins:set-dsh-home-env', !!on),
  setPathEntry: (on) => ipcRenderer.invoke('plugins:set-path-entry', !!on),
  writeWrappers: () => ipcRenderer.invoke('plugins:write-wrappers'),
  installPlugin: (spec, profile) => ipcRenderer.invoke('plugins:install', { spec, profile }),
  scanLegacy: () => ipcRenderer.invoke('plugins:scan-legacy'),
  importLegacy: (items, profile) => ipcRenderer.invoke('plugins:import-legacy', { items, profile }),
  onPluginLog: (cb) => {
    const fn = (_e, line) => { try { cb(String(line)); } catch {} };
    ipcRenderer.on('plugins:log', fn);
    return () => ipcRenderer.removeListener('plugins:log', fn);
  },
  openSettings: () => ipcRenderer.invoke('settings:open'),
  // 通用剪贴板（供「插件安装与终端」区复制命令用；与手机功能无关）
  copyText: (text) => ipcRenderer.invoke('shell:copy-text', text)
});
