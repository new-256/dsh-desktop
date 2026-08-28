'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge exposed to the loaded DSH Web GUI.
contextBridge.exposeInMainWorld('dshDesktop', {
  appVersion: () => ipcRenderer.invoke('app:get-version'),
  isDesktop: true,
  platform: process.platform
});
