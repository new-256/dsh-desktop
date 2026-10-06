'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge exposed to the loaded DSH Web GUI.
contextBridge.exposeInMainWorld('dshDesktop', {
  appVersion: () => ipcRenderer.invoke('app:get-version'),
  isDesktop: true,
  platform: process.platform,
  // 0.3.39 · 对齐官方 dshDesktop.deviceInfo()：platform/os/app_arch/cpu/memory_gib
  // 以 `name=value`、`; ` 分隔；不含主机名、用户名、序列号。
  deviceInfo: () => ipcRenderer.invoke('app:device-info')
});
