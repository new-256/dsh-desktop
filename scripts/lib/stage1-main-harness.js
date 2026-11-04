'use strict';

/**
 * stage1-main-harness —— 让 `main.js` 的真实函数能在**纯 Node**里被驱动（0.3.48）。
 *
 * ## 为什么需要
 *
 * 本轮要修的四条缺陷里，有三条（H-01 回滚接电、H-02 spawn 反模式、H-08 AUMID）
 * 的代码就在 `main.js` 这个 2900 行的 Electron 主进程入口里。它第一行就
 * `require('electron')`，因此「不起 GUI 就能验证」的传统做法是**把逻辑复制一份
 * 到测试里**——那等于测了个影子实现，真正的 main.js 照样没被测到（0.3.44 的教训：
 * 测试全绿而发布版一点就崩）。
 *
 * 这里的做法是：把 `main.js` 源码读出来，用 `Module._compile` 在**受控的模块环境**
 * 里执行，只替换三样东西：
 *   · `electron`               → 桩（app / Tray / dialog / Notification…）
 *   · `child_process`          → 桩（可控的 spawn：抛错 / 假子进程 / 记录 taskkill）
 *   · `./updater-backend`      → 桩（P() / rollbackDsh() / journalUnverified()…）
 * 其余（diag-log / crash-report / lifecycle-log / quit-guard / ladder-policy /
 * startup-deadline）**全部走真模块**，日志与台账真的落盘到临时目录。
 *
 * 启动链本身不会跑：桩的 `app.whenReady()` 返回一个永不 settle 的 Promise ——
 * 于是我们只测被显式调用的那些函数，不会顺带把整个 GUI 启动流程拖进来。
 *
 * 用法（见 scripts/test-h01-*.js / test-h02-*.js / test-h08-*.js）：
 *   const h = require('./lib/stage1-main-harness');
 *   const base = h.makeBase('h01');
 *   const { mod, stub } = h.loadMain({ base, exports: ['showFatal', 'performRollback'] });
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..', '..');

/** 建一个干净的临时沙箱（日志 / userData / cwd 都指向它，绝不碰真实用户目录）。 */
function makeBase(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
  fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
  return base;
}

/** 统一的断言收集器（失败时打印实际值，符合"断言失败打印实际值"的纪律）。 */
function createAsserts() {
  const result = { pass: 0, failures: [] };
  result.section = (name) => console.log('\n' + name);
  result.ok = (cond, label, actual) => {
    if (cond) {
      result.pass += 1;
      console.log('  ✓ ' + label);
    } else {
      result.failures.push(label);
      console.log('  ✗ ' + label);
      if (actual !== undefined) console.log('      实际值：' + require('util').inspect(actual, { depth: 4, breakLength: 140 }));
    }
  };
  result.summary = () => {
    console.log('\n────────────────────────────────────────');
    console.log(`断言 ${result.pass + result.failures.length} 项，失败 ${result.failures.length} 项`);
    if (result.failures.length) {
      console.log('失败明细：');
      for (const f of result.failures) console.log('  ✗ ' + f);
    }
  };
  return result;
}

/** 打印日志文件前 N 行（断言失败时用来回答"当时到底记了什么"）。 */
function printLogHead(file, lines = 20) {
  try {
    if (!fs.existsSync(file)) { console.log(`（日志文件不存在：${file}）`); return; }
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    console.log(`── 日志前 ${Math.min(lines, all.length)} 行（${file}）──`);
    for (const line of all.slice(0, lines)) console.log('  | ' + line);
  } catch (e) {
    console.log('（读日志失败：' + e.message + '）');
  }
}

// ── Electron 桩 ─────────────────────────────────────────────────────────────

/**
 * @param {{userData: string, balloonShow?: boolean, balloonThrows?: boolean,
 *          notificationSupported?: boolean, msgBoxResponses?: Array<{response:number}>,
 *          defaultResponseId?: number, isPackaged?: boolean, version?: string}} opts
 */
function createElectronStub(opts) {
  const o = opts || {};
  const state = {
    aumid: [],
    messageBoxes: [],
    errorBoxes: [],
    notifications: [],
    trays: [],
    relaunches: [],
    quits: 0,
    exits: [],
    shellOpens: [],
    externalOpens: [],
    msgBoxResponses: (o.msgBoxResponses || []).slice()
  };

  const app = {
    isPackaged: !!o.isPackaged,
    commandLine: { appendSwitch() {} },
    getVersion: () => o.version || '0.3.48-test',
    getPath: () => o.userData,
    getAppPath: () => ROOT,
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // 启动链刻意不执行
    on() {},
    once() {},
    removeListener() {},
    removeAllListeners() {},
    quit() { state.quits += 1; },
    exit(code) { state.exits.push(code); },
    relaunch(args) { state.relaunches.push(args); },
    setAppUserModelId(id) { state.aumid.push(id); },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    disableHardwareAcceleration() {},
    isReady: () => false
  };

  class FakeTray extends EventEmitter {
    constructor(icon) {
      super();
      this.icon = icon;
      this.destroyed = false;
      this.balloons = [];
      state.trays.push(this);
    }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    setImage() {}
    popUpContextMenu() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    displayBalloon(options) {
      this.balloons.push(options);
      if (o.balloonThrows) throw new Error('displayBalloon 不可用（测试注入）');
      if (o.balloonShow) setImmediate(() => this.emit('balloon-show'));
      return true;
    }
  }

  class FakeNotification {
    constructor(options) {
      this.options = options;
      this.shown = false;
      state.notifications.push(this);
    }
    show() { this.shown = true; }
    close() {}
    static isSupported() { return o.notificationSupported !== false; }
  }

  /**
   * 假 Session：`createChromiumWindow` 会往 session 上挂权限闸门与 webRequest 钩子，
   * 少了这些方法真实 main.js 会在建窗时抛错（那正是"接线回归"要跑真实路径的代价）。
   * cookies 用内存 store，便于 B-01 断言"只清目标源"。
   */
  function createFakeSession() {
    const store = [];
    const noop = () => {};
    return {
      cookies: {
        async get() { return store.map((c) => ({ ...c })); },
        async remove(url, name) {
          const i = store.findIndex((c) => c.name === name);
          if (i >= 0) store.splice(i, 1);
          return true;
        }
      },
      webRequest: { onErrorOccurred: noop, onResponseStarted: noop, onBeforeRequest: noop, onHeadersReceived: noop },
      setPermissionRequestHandler: noop,
      setPermissionCheckHandler: noop,
      setDevicePermissionHandler: noop,
      setDisplayMediaRequestHandler: noop,
      setSpellCheckerEnabled: noop,
      clearStorageData: async () => {}
    };
  }
  const sharedSession = createFakeSession();
  state.session = sharedSession;

  const dialog = {
    async showMessageBox(parent, options) {
      const box = options || parent;
      state.messageBoxes.push(box);
      if (state.msgBoxResponses.length) return state.msgBoxResponses.shift();
      return { response: o.defaultResponseId != null ? o.defaultResponseId : 0, checkboxChecked: false };
    },
    showErrorBox(title, content) { state.errorBoxes.push({ title, content }); }
  };

  const ipcHandlers = new Map();
  const electron = {
    app,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (tpl) => ({ tpl }), setApplicationMenu() {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    dialog,
    shell: {
      async openPath(p) { state.shellOpens.push(p); return ''; },
      async openExternal(u) { state.externalOpens.push(u); return true; }
    },
    // 记录注册的处理器，测试才能直接调用真实 handleIpc 逻辑（含 assertOwnedSender 链路）。
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on() {},
      removeHandler(ch) { ipcHandlers.delete(ch); }
    },
    session: { defaultSession: sharedSession, fromPartition: () => sharedSession },
    clipboard: { readText: () => '', writeText() {} },
    Notification: FakeNotification,
    BrowserWindow: class {
      constructor(options) {
        this.webContents = new EventEmitter();
        // 真实 main.js 建窗时会用 webContents.session 挂权限闸门/webRequest 钩子。
        this.webContents.session = sharedSession;
        this.destroyed = false;
        this.options = options || {};
        (state.windows || (state.windows = [])).push(this);
        this.webContents.id = state.windows.length;
        // 0.3.49 · B-05 起，真实 main.js 建窗时会装导航/开窗处理器并读回 webPreferences。
        this.webContents.setWindowOpenHandler = () => {};
        this.webContents.getLastWebPreferences = () => {
          const prefs = (this.options && this.options.webPreferences) || {};
          return {
            sandbox: prefs.sandbox,
            contextIsolation: prefs.contextIsolation,
            nodeIntegration: !!prefs.nodeIntegration,
            webSecurity: prefs.webSecurity === undefined ? true : prefs.webSecurity
          };
        };
      }
      isDestroyed() { return this.destroyed; }
      loadURL() {}
      loadFile() {}
      on() {}
      once() {}
      show() {}
      hide() {}
      focus() {}
      setAlwaysOnTop() {}
      isMinimized() { return false; }
      restore() {}
      close() {}
    },
    powerMonitor: { on() {} }
  };

  return { electron, state, ipcHandlers };
}

// ── child_process 桩 ────────────────────────────────────────────────────────

/** 一个"活着但什么都不做"的假后端子进程。 */
function createFakeBackendChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(child);
  return child;
}

/**
 * @param {{onSpawn?: (cmd: string, args: string[], options: any, calls: object) => any}} opts
 *   onSpawn 返回什么，`spawn()` 就返回什么（可以抛错来模拟 EACCES）。
 */
function createChildProcessStub(opts) {
  const o = opts || {};
  const calls = { spawns: [], taskkills: [] };
  return {
    calls,
    module: {
      spawn(cmd, args, options) {
        const record = { cmd, args, options };
        calls.spawns.push(record);
        if (path.basename(String(cmd)).toLowerCase() === 'taskkill') {
          calls.taskkills.push(record);
          const killer = new EventEmitter();
          killer.pid = 1;
          return killer;
        }
        if (o.onSpawn) return o.onSpawn(cmd, args, options, calls);
        return createFakeBackendChild();
      },
      spawnSync() { throw new Error('测试未预期 main.js 调用 spawnSync'); },
      execSync() { throw new Error('测试未预期 main.js 调用 execSync'); }
    }
  };
}

// ── updater-backend 桩 ─────────────────────────────────────────────────────

/**
 * @param {{root?: string, nodeExe?: string, dshBin?: string, dshPrevious?: string,
 *          currentDsh?: string, buildEnvThrows?: boolean, journal?: Array<object>,
 *          rollbackOk?: boolean, rollbackThrows?: boolean, versions?: Array<string>}} opts
 */
function createUpdaterBackendStub(opts) {
  const o = opts || {};
  const root = o.root || path.join(ROOT, '.tmp-nonexistent-backend');
  const calls = { rollback: 0, buildEnv: 0, journalVerified: 0 };
  const versions = Array.isArray(o.versions) ? o.versions.slice() : null;
  let current = o.currentDsh || '1.0.0-test';

  const stub = {
    calls,
    P: () => ({
      root,
      dshHome: path.join(root, 'dsh-home'),
      nodeExe: o.nodeExe || path.join(root, 'node.exe'),
      dshBin: o.dshBin || path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      dshDir: path.join(root, 'dsh'),
      dshNew: path.join(root, 'dsh.new'),
      dshPrevious: o.dshPrevious || path.join(root, 'dsh.previous'),
      versionsJson: path.join(root, 'versions.json'),
      binDir: path.join(root, 'bin')
    }),
    activeRoot: () => root,
    dshHome: () => path.join(root, 'dsh-home'),
    buildDedicatedEnv() {
      calls.buildEnv += 1;
      if (o.buildEnvThrows) throw new Error('buildDedicatedEnv 失败（测试注入：磁盘满/权限异常）');
      return { PATH: 'stub', APPDATA: root };
    },
    currentVersions: () => ({ dsh: current, shell: '0.3.48-test' }),
    journalUnverified: () => (Array.isArray(o.journal) ? o.journal : []),
    journalMarkVerified() { calls.journalVerified += 1; return 1; },
    rollbackDsh() {
      calls.rollback += 1;
      if (o.rollbackThrows) throw new Error('rollbackDsh 抛错（测试注入）');
      if (o.rollbackOk === false) return false;
      // 与真实 rollbackDsh() 同一判据：dsh.previous 里的 bin.js 存在才换名。
      const prevBin = path.join(
        o.dshPrevious || path.join(root, 'dsh.previous'),
        'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'
      );
      if (!fs.existsSync(prevBin)) return false;
      if (versions && versions.length) current = versions.shift();
      else current = '0.9.0-previous';
      return true;
    },
    safeModeActive: () => false,
    writeWrapperScripts() {},
    preseedDshHomeEnv: () => ({ applied: false, reason: 'stub' }),
    requestedBackendVersion: () => null,
    clearRequestedBackendVersion() {},
    ensureSeeded() {},
    applyStaged: () => ({ dsh: null, node: null }),
    applySafeModeBoot: () => ({ active: false, exited: false }),
    recoverInterruptedIsolation: () => null,
    nodeRequirement: () => ({ ok: true, current: '24.0.0', required: '>=20', source: 'stub' }),
    ensureNodeMeetsRequirement: async () => ({}),
    repairProfileJunctions: () => [],
    describeEnvIsolation: () => ({ strippedVars: [], droppedPathEntries: [], dshHome: path.join(root, 'dsh-home') }),
    migrateAgentPresetPersonaText: () => ({ migrated: [] }),
    validateAndRepairPatchLayers: () => [],
    findLoaderIdConflicts: () => [],
    applyLoaderConflictFixes: () => ({ fixed: [] }),
    restorePreflightDisabledEntries: () => ({ restored: [] }),
    preflightBareNameResolution: () => ({ repaired: [] }),
    comboGateCheck: () => ({ validated: true, shouldPrompt: false, combo: 'stub' }),
    dismissComboPrompt() {},
    pythonBootCheck: () => ({ shouldPrompt: false, info: { available: true, version: '3.12', reason: 'stub' } }),
    dismissPythonPrompt() {},
    validateCredentialsDocument: () => ({ present: false, ok: true, problems: [] }),
    repairCredentialKeys: () => ({ changed: [], failed: [] }),
    preparePluginIsolation: () => ({ active: false, plugins: [], entries: [] }),
    finishPluginIsolation: () => ({ entries: [] }),
    enablePluginIsolationEntry() {},
    clearPluginIsolation() {},
    stagedVersions: () => ({ dsh: null, node: null }),
    checkForUpdates: async () => ({ current: {}, latest: {}, updates: [], pending: [], errors: [] }),
    stageDsh: async () => ({ version: '0.0.0-stub' }),
    stageNode: async () => ({}),
    compareSemver: () => 0,
    npmDshVersionsAll: async () => ({ all: [], latest: null, engines: {} }),
    safeModeActive2: undefined
  };
  return stub;
}

// ── 加载被测 main.js ───────────────────────────────────────────────────────

/**
 * 在受控模块环境里编译 main.js，并把指定符号导出给测试。
 * @param {{base: string, electronStub?: object, childProcessStub?: object,
 *          backendStub?: object, exports?: string[], packageJsonStub?: object}} opts
 *   packageJsonStub 用于**模拟 electron-builder 打包后的 package.json**：
 *   实测成品 asar 内的 package.json 没有 `build` 段（见 0.3.48 H-08 复修），
 *   把它注入进来就能验证"main.js 是否还敢依赖 package.json"。
 */
function loadMain(opts) {
  const o = opts || {};
  const filename = path.join(ROOT, 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const names = Array.isArray(o.exports) ? o.exports : [];
  const exportLine = `\n// 测试专用导出（只在 harness 编译时追加，磁盘上的 main.js 没有这一行）\n` +
    `module.exports = { ${names.join(', ')} };\n`;

  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(ROOT);

  // 记录 main.js 真正 require 过的模块 id —— 用来证明"运行期不再访问 package.json"。
  const requireLog = [];
  const realRequire = Module.prototype.require.bind(mod);
  mod.require = (id) => {
    requireLog.push(id);
    if (id === 'electron') return o.electronStub;
    if (id === 'child_process') return o.childProcessStub;
    if (id === './updater-backend') return o.backendStub;
    if (id === './package.json' && o.packageJsonStub) return o.packageJsonStub;
    return realRequire(id);
  };

  mod._compile(source + exportLine, filename);
  if (mod.exports && typeof mod.exports === 'object') {
    Object.defineProperty(mod.exports, '__requireLog', { value: requireLog, enumerable: false });
  }
  return mod.exports;
}

module.exports = {
  ROOT,
  makeBase,
  createAsserts,
  printLogHead,
  createElectronStub,
  createChildProcessStub,
  createFakeBackendChild,
  createUpdaterBackendStub,
  loadMain
};
