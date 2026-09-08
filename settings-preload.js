'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Settings window bridge — minimal, typed, no node access in the renderer.
contextBridge.exposeInMainWorld('dshSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setRoute: (route) => ipcRenderer.invoke('settings:set-route', route),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  downloadUpdates: () => ipcRenderer.invoke('settings:download-updates'),
  setAutostart: (on) => ipcRenderer.invoke('settings:set-autostart', !!on),
  openLog: () => ipcRenderer.invoke('settings:open-log'),
  restart: () => ipcRenderer.invoke('settings:restart-app')
});
