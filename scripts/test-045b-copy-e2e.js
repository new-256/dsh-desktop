'use strict';

/**
 * 端到端验证：真实 Electron 里，页面调用 navigator.clipboard.writeText()
 * 不再导致主进程崩溃，且复制真的成功。
 *
 * 对照：修复前同一实验得到 ReferenceError: win is not defined。
 */

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = src.indexOf('function applyPermissionGates(session, owner) {');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);

const logs = [];
const diag = (...a) => logs.push(a.join(' '));
const dialogRef = {
  // 麦克风确认框：本实验不触碰麦克风；若被调用则自动拒绝，避免卡住
  showMessageBox: () => Promise.resolve({ response: 1 })
};

let uncaught = null;
process.on('uncaughtException', (e) => { uncaught = e; });

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body><script>
    window.res = 'pending';
    window.detail = '';
    window.doCopy = async () => {
      try { await navigator.clipboard.writeText('dsh-copy-test'); window.res = 'ok'; }
      catch (e) { window.res = 'fail:' + e.name; window.detail = e.message; }
    };
    window.hasFocus = () => document.hasFocus();
  </script></body></html>`);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false });
    const factory = new Function('diag', 'dialog', 'APP_NAME', 'mainWindow',
      fnSrc + '\nreturn applyPermissionGates;');
    const applyPermissionGates = factory(diag, dialogRef, 'DSH Desktop', null);

    applyPermissionGates(win.webContents.session, win.webContents);
    console.log('✓ 权限闸门已注册');

    await win.loadURL(`http://127.0.0.1:${port}/`);
    win.show();
    win.focus();
    await new Promise(r => setTimeout(r, 400));
    const focused = await win.webContents.executeJavaScript('window.hasFocus()');
    await win.webContents.executeJavaScript('doCopy()');
    await new Promise(r => setTimeout(r, 900));
    const res = await win.webContents.executeJavaScript('window.res');
    const detail = await win.webContents.executeJavaScript('window.detail');

    console.log('');
    console.log('文档是否有焦点: ' + focused + '（Chromium 要求焦点才允许 clipboard 写入）');
    console.log('渲染进程复制结果: ' + res + (detail ? ' — ' + detail : ''));
    console.log('主进程未捕获异常: ' + (uncaught ? uncaught.constructor.name + ': ' + uncaught.message : '（无）'));
    const permLogs = logs.filter(l => l.includes('权限'));
    if (permLogs.length) { console.log('权限日志:'); permLogs.forEach(l => console.log('  ' + l)); }

    console.log('');
    const crashed = !!(uncaught && /win is not defined/.test(uncaught.message));
    const copied = res === 'ok';

    if (crashed) {
      console.log('✗ 仍然崩溃（win is not defined）');
      process.exitCode = 42;
    } else if (!uncaught && copied) {
      console.log('★ 通过：点复制不再崩溃，且剪贴板写入成功');
      process.exitCode = 0;
    } else if (!uncaught && !copied) {
      console.log('○ 不崩溃但复制未成功（' + res + '）—— 需检查权限放行');
      process.exitCode = 44;
    } else {
      console.log('△ 出现别的异常: ' + uncaught.message);
      process.exitCode = 43;
    }

    server.close();
    setTimeout(() => app.exit(process.exitCode || 0), 150);
  });
});