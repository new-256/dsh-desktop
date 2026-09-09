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
  restart: () => ipcRenderer.invoke('settings:restart-app')
});
