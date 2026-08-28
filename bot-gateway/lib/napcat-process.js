/**
 * @file lib/napcat-process.js
 * @description NapCatQQ 一键安装、零依赖一键解压、配置动态注入与托管进程守护管理器。
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger, fetchJson, resolveBotGatewayPath } from './util.js?v=10';

/**
 * 校验 NapCat 是否已正确安装
 * 安装判定标准：安装目录下同时存在 node.exe, index.js 与 napcat/napcat.mjs
 * @param {string} installDir 
 * @returns {boolean}
 */
export function checkNapCatInstalled(installDir) {
  if (!installDir) return false;
  return (
    existsSync(join(installDir, 'node.exe')) &&
    existsSync(join(installDir, 'index.js')) &&
    existsSync(join(installDir, 'napcat', 'napcat.mjs'))
  );
}

/**
 * 工厂函数：创建 NapCat 进程管理器
 * @param {object} options
 * @param {object} [options.log] - 日志记录器
 * @param {function(): object} options.getConfig - 获取当前配置闭包
 * @param {object} [options.settingsStore] - SettingsStore 引用，用于将 token/webuiPort 同步回网关设置
 * @returns {object} NapCatProcessManager API 实例
 */
export function createNapCatProcessManager({ log = createLogger('napcat-proc'), getConfig, settingsStore }) {
  let isInstalling = false;
  let activeInstallPromise = null;
  let installedVersion = '';
  let lastError = null;

  let progress = {
    phase: 'idle', // 'idle' | 'resolving' | 'downloading' | 'extracting' | 'configuring' | 'done'
    bytes: 0,
    total: 0
  };

  // 进程状态
  let childProc = null;
  let pid = null;
  let isRunning = false;
  let userStopped = false;

  // 自动重启与轮询定时器
  let restartCount = 0;
  let restartTimer = null;
  let resetCountTimer = null;
  let loginCheckTimer = null;

  /**
   * 获取解析后的安装目录
   */
  function getInstallDir() {
    const config = getConfig?.() || {};
    return resolveBotGatewayPath(config.napcat?.installDir, 'napcat');
  }

  /**
   * 写/更新 webui.json 与 onebot11.json 配置文件
   */
  async function ensureConfigs() {
    const config = getConfig?.() || {};
    const installDir = getInstallDir();
    const configDir = join(installDir, 'napcat', 'config');

    await mkdir(configDir, { recursive: true });

    const webuiPort = config.napcat?.webuiPort || 6099;
    const wsPort = config.napcat?.wsPort || 3001;

    // 1. webui.json
    const webuiPath = join(configDir, 'webui.json');
    let webuiData = {};
    let isWebuiExist = false;

    if (existsSync(webuiPath)) {
      try {
        const content = await readFile(webuiPath, 'utf8');
        webuiData = JSON.parse(content);
        isWebuiExist = true;
      } catch {
        webuiData = {};
      }
    }

    let token = webuiData.token;
    if (!token) {
      token = randomUUID().replace(/-/g, '');
    }

    const needsWebuiUpdate = (
      !isWebuiExist ||
      webuiData.host !== '127.0.0.1' ||
      Number(webuiData.port) !== Number(webuiPort) ||
      webuiData.token !== token
    );

    if (needsWebuiUpdate) {
      webuiData = {
        host: '127.0.0.1',
        port: Number(webuiPort),
        token,
        loginRate: 10,
        ...webuiData
      };
      // 强制 host 为 127.0.0.1
      webuiData.host = '127.0.0.1';
      webuiData.port = Number(webuiPort);
      webuiData.token = token;

      await writeFile(webuiPath, JSON.stringify(webuiData, null, 2), 'utf8');
      log.info(`已更新 webui.json (Port: ${webuiPort})`);
    }

    // 将 token 与 webuiPort 同步回网关设置
    if (settingsStore && typeof settingsStore.save === 'function') {
      const currentNapcatWebui = config.adapters?.onebot11?.napcatWebui;
      const targetUrl = `http://127.0.0.1:${webuiPort}`;
      if (currentNapcatWebui?.url !== targetUrl || currentNapcatWebui?.token !== token) {
        await settingsStore.save({
          adapters: {
            onebot11: {
              napcatWebui: { url: targetUrl, token }
            }
          }
        }).catch((e) => log.warn('同步 napcatWebui 到 settingsStore 失败:', e.message));
      }
    }

    // 2. onebot11.json
    const ob11Path = join(configDir, 'onebot11.json');
    let ob11Data = null;
    let isOb11Exist = false;

    if (existsSync(ob11Path)) {
      try {
        const content = await readFile(ob11Path, 'utf8');
        ob11Data = JSON.parse(content);
        isOb11Exist = true;
      } catch {
        ob11Data = null;
      }
    }

    if (!isOb11Exist || !ob11Data || !Array.isArray(ob11Data.network?.websocketServers)) {
      ob11Data = {
        network: {
          websocketServers: [{
            name: 'dsh-gateway',
            enable: true,
            host: '127.0.0.1',
            port: Number(wsPort),
            token: '',
            heartInterval: 30000,
            debug: false
          }],
          httpServers: [],
          websocketClients: []
        },
        musicSignUrl: '',
        enableLocalFile2Url: false,
        parseMultMsg: true
      };
      await writeFile(ob11Path, JSON.stringify(ob11Data, null, 2), 'utf8');
      log.info(`已写入默认 onebot11.json (WS Port: ${wsPort})`);
    } else {
      let changed = false;
      const wsServer = ob11Data.network.websocketServers[0];
      if (wsServer && Number(wsServer.port) !== Number(wsPort)) {
        wsServer.port = Number(wsPort);
        changed = true;
      }
      if (changed) {
        await writeFile(ob11Path, JSON.stringify(ob11Data, null, 2), 'utf8');
        log.info(`已更新 onebot11.json (WS Port: ${wsPort})`);
      }
    }
  }

  /**
   * 执行一键安装全流程 (内部推进状态机，幂等)
   */
  function install() {
    if (isInstalling && activeInstallPromise) {
      log.info('安装流程已在进行中，返回现有安装任务 Promise');
      return activeInstallPromise;
    }

    isInstalling = true;
    lastError = null;
    progress = { phase: 'resolving', bytes: 0, total: 0 };

    activeInstallPromise = (async () => {
      const installDir = getInstallDir();
      try {
        const config = getConfig?.() || {};
        let version = config.napcat?.version ? String(config.napcat.version).replace(/^v/, '') : '';

        // 1. 获取最新版本号
        if (!version) {
          log.info('正在向 jsdelivr API 获取 NapCatQQ 最新版本号...');
          try {
            const data = await fetchJson('https://data.jsdelivr.com/v1/packages/gh/NapNeko/NapCatQQ', { timeout: 10000 });
            if (data?.versions?.[0]?.version) {
              version = String(data.versions[0].version).replace(/^v/, '');
            }
          } catch (e) {
            log.warn('无法获取 NapCatQQ 最新版本号:', e.message);
          }
        }

        if (!version) {
          throw new Error('获取 NapCat 版本失败，请在设置中手动填入版本号');
        }

        installedVersion = version;
        log.info(`解析到目标安装版本: v${version}`);

        // 2. 构建下载地址与镜像
        const rawUrl = `https://github.com/NapNeko/NapCatQQ/releases/download/v${version}/NapCat.Shell.Windows.Node.zip`;
        let mirror = config.napcat?.mirror || '';
        if (mirror && !mirror.endsWith('/')) mirror += '/';
        const downloadUrl = mirror ? (mirror + rawUrl) : rawUrl;

        // 3. 下载 zip
        progress = { phase: 'downloading', bytes: 0, total: 0 };
        await mkdir(installDir, { recursive: true });

        const zipPath = join(installDir, 'download.zip');
        log.info(`正在下载: ${downloadUrl} -> ${zipPath}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15 * 60 * 1000); // 15分钟超时

        const res = await fetch(downloadUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`下载 NapCat 压缩包失败 HTTP ${res.status}: ${res.statusText}`);
        }

        const totalHeader = Number(res.headers.get('content-length') || 0);
        progress.total = totalHeader;

        const outStream = createWriteStream(zipPath);
        let loaded = 0;

        try {
          for await (const chunk of res.body) {
            outStream.write(chunk);
            loaded += chunk.length;
            progress.bytes = loaded;
          }
          await new Promise((resResolve, resReject) => {
            outStream.end(() => resResolve());
            outStream.on('error', resReject);
          });
        } catch (err) {
          outStream.destroy();
          await unlink(zipPath).catch(() => {});
          throw err;
        }

        log.info(`下载完成，共计 ${loaded} 字节，准备解压...`);

        // 4. bsdtar 解压
        progress = { phase: 'extracting', bytes: loaded, total: progress.total || loaded };
        log.info('正在调用 System32/tar.exe 解压文件...');

        await new Promise((resolveExtract, rejectExtract) => {
          const tarProc = spawn('C:/Windows/System32/tar.exe', ['-xf', zipPath, '-C', installDir], { windowsHide: true });
          let stderrMsg = '';
          tarProc.stderr.on('data', (d) => stderrMsg += d.toString());
          tarProc.on('close', (code) => {
            if (code === 0) resolveExtract();
            else rejectExtract(new Error(`bsdtar 解压失败 (exit ${code}): ${stderrMsg}`));
          });
          tarProc.on('error', (err) => rejectExtract(new Error(`无法启动 tar.exe: ${err.message}`)));
        });

        // 5. 校验安装结果
        if (!checkNapCatInstalled(installDir)) {
          throw new Error('解压已完成，但核心文件结构不完整 (缺少 node.exe / index.js / napcat/napcat.mjs)');
        }

        // 6. 生成配置文件
        progress = { phase: 'configuring', bytes: loaded, total: progress.total || loaded };
        await ensureConfigs();

        // 7. 清理 zip
        await unlink(zipPath).catch(() => {});

        progress = { phase: 'done', bytes: loaded, total: progress.total || loaded };
        log.info(`🎉 NapCat v${version} 一键安装完成！`);
        return { ok: true, version };
      } catch (e) {
        log.error('NapCat 安装过程出错:', e);
        lastError = e.message;
        progress.phase = 'idle';
        throw e;
      } finally {
        isInstalling = false;
        activeInstallPromise = null;
      }
    })();

    return activeInstallPromise;
  }

  /**
   * 启动 NapCat 托管进程
   */
  async function start() {
    const installDir = getInstallDir();

    if (!checkNapCatInstalled(installDir)) {
      throw new Error('NapCat 未安装，请先执行安装');
    }

    const config = getConfig?.() || {};
    if (config.napcat?.enabled === false) {
      log.info('napcat.enabled 为 false，跳过进程启动');
      return;
    }

    if (isRunning && childProc) {
      log.info(`NapCat 进程已在运行中 (PID: ${pid})`);
      return;
    }

    userStopped = false;

    // 清理旧进程
    const pidPath = join(installDir, 'napcat.pid');
    let oldPid = null;
    if (existsSync(pidPath)) {
      try {
        oldPid = Number((await readFile(pidPath, 'utf8')).trim());
      } catch {}
    }

    if (oldPid) {
      let alive = false;
      try {
        process.kill(oldPid, 0);
        alive = true;
      } catch {}

      if (alive) {
        log.warn(`探查到残留 NapCat 进程 (PID: ${oldPid})，正在强杀清理...`);
        await new Promise((resolveKill) => {
          const tk = spawn('taskkill', ['/F', '/T', '/PID', String(oldPid)], { windowsHide: true });
          tk.on('close', () => resolveKill());
        });
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 确保配置文件是最新的
    await ensureConfigs();

    // 启动 child_process
    const nodeExe = join(installDir, 'node.exe');
    log.info(`正在启动 NapCat 托管进程: ${nodeExe} index.js (cwd: ${installDir})`);

    childProc = spawn(nodeExe, ['index.js'], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    pid = childProc.pid;
    isRunning = true;

    await writeFile(pidPath, String(pid), 'utf8').catch(() => {});
    log.info(`NapCat 进程启动成功 (PID: ${pid})`);

    // 运行 10 分钟后重置重启计数
    if (resetCountTimer) clearTimeout(resetCountTimer);
    resetCountTimer = setTimeout(() => {
      if (isRunning) {
        log.info('NapCat 进程已稳定持续运行 10 分钟，重置自动重启计数器');
        restartCount = 0;
      }
    }, 10 * 60 * 1000);

    // 启动 30s 自动轮询 autoLoginAccount
    startLoginStatusPolling();

    childProc.on('exit', (code, signal) => {
      log.warn(`NapCat 进程退出 (code=${code}, signal=${signal})`);
      isRunning = false;
      pid = null;
      childProc = null;

      if (loginCheckTimer) {
        clearInterval(loginCheckTimer);
        loginCheckTimer = null;
      }

      unlink(pidPath).catch(() => {});

      if (!userStopped) {
        restartCount++;
        if (restartCount <= 5) {
          const delay = Math.min(60000, 5000 * Math.pow(2, restartCount - 1)); // 5s, 10s, 20s, 40s, 60s
          log.warn(`NapCat 意外退出，将在 ${delay / 1000}s 后尝试第 ${restartCount}/5 次自动重启...`);
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            start().catch((err) => log.error('自动重启 NapCat 失败:', err));
          }, delay);
        } else {
          lastError = 'NapCat 进程反复崩溃退出，已达到最大重试上限 5 次';
          log.error(lastError);
        }
      }
    });

    childProc.on('error', (err) => {
      log.error('NapCat 进程报错:', err);
      lastError = err.message;
    });
  }

  /**
   * 停止 NapCat 托管进程 (用户主动 stop 语义，取消自动重启)
   */
  async function stop() {
    userStopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (resetCountTimer) {
      clearTimeout(resetCountTimer);
      resetCountTimer = null;
    }
    if (loginCheckTimer) {
      clearInterval(loginCheckTimer);
      loginCheckTimer = null;
    }

    const installDir = getInstallDir();
    const pidPath = join(installDir, 'napcat.pid');

    let killPid = pid;
    if (!killPid && existsSync(pidPath)) {
      try {
        killPid = Number((await readFile(pidPath, 'utf8')).trim());
      } catch {}
    }

    if (killPid) {
      log.info(`正在停止 NapCat 进程 (PID: ${killPid})...`);
      await new Promise((resolveStop) => {
        const tk = spawn('taskkill', ['/F', '/T', '/PID', String(killPid)], { windowsHide: true });
        tk.on('close', () => resolveStop());
      });
    }

    await unlink(pidPath).catch(() => {});
    isRunning = false;
    pid = null;
    childProc = null;
    log.info('NapCat 进程已成功停止');
  }

  /**
   * 轮询 NapCat 登录状态，若已登录自动写回 autoLoginAccount 到 webui.json
   */
  function startLoginStatusPolling() {
    if (loginCheckTimer) clearInterval(loginCheckTimer);

    loginCheckTimer = setInterval(async () => {
      if (!isRunning) return;
      try {
        const config = getConfig?.() || {};
        const napcatCfg = config.adapters?.onebot11?.napcatWebui || {};
        if (!napcatCfg.url || !napcatCfg.token) return;

        // 向 NapCat 探查 CheckLoginStatus
        const checkRes = await fetchJson(`${napcatCfg.url.replace(/\/$/, '')}/api/Bot/GetLoginStatus`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${napcatCfg.token}`
          },
          timeout: 4000
        }).catch(() => null);

        const status = checkRes?.data || checkRes?.result || checkRes || {};
        const isLogin = status.isLogin || status.online || false;
        const uin = status.uin || status.user_id;

        if (isLogin && uin) {
          const installDir = getInstallDir();
          const webuiPath = join(installDir, 'napcat', 'config', 'webui.json');
          if (existsSync(webuiPath)) {
            const content = await readFile(webuiPath, 'utf8');
            const webuiJson = JSON.parse(content);
            if (String(webuiJson.autoLoginAccount || '') !== String(uin)) {
              webuiJson.autoLoginAccount = String(uin);
              await writeFile(webuiPath, JSON.stringify(webuiJson, null, 2), 'utf8');
              log.info(`检测到 QQ ${uin} 登录成功，已自动更新 autoLoginAccount 到 webui.json`);
            }
          }
        }
      } catch {}
    }, 30000);
  }

  /**
   * 获取 NapCat 状态
   */
  function status() {
    const installDir = getInstallDir();
    const installed = checkNapCatInstalled(installDir);
    return {
      installed,
      installing: isInstalling,
      running: isRunning,
      pid: isRunning ? pid : null,
      version: installedVersion || getConfig?.()?.napcat?.version || '',
      lastError,
      progress: { ...progress },
      installDir
    };
  }

  /**
   * 插件销毁
   */
  function dispose() {
    log.info('正在销毁 NapCatProcessManager...');
    stop().catch(() => {});
  }

  return {
    install,
    start,
    stop,
    ensureConfigs,
    status,
    dispose,
  };
}
