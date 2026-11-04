'use strict';

/**
 * stage1-run-with-timeout —— 阶段一收口用的「防卡死执行器」。
 *
 * 为什么需要它：本阶段要跑几十个子进程（node --check、三支团队的验证脚本、
 * npm run dist）。其中任何一个都可能在无输出的情况下永久挂起（例如等 stdin、
 * 等网络、等被占用的文件句柄），让整个收口流程无限期停住——这正是本轮要修的
 * 缺陷类型（H-02/H-03 的同类问题在测试流程里的镜像）。
 *
 * 契约：
 *   - 超时即 kill **整棵进程树**（Windows 用 taskkill /T /F，避免 npm/pwsh
 *     派生的孙进程变成孤儿继续占着文件与端口）；
 *   - 超时必须回答「卡在哪」：先抓取超时瞬间的进程树快照（进程名 + 命令行），
 *     再输出最后 N 行（默认 50）输出，而不是只说一句「失败了」；
 *   - 全文输出同时落盘（--log 追加），满足项目规则「编译错误输出全文入档」；
 *   - 退出码透传；超时固定返回 124（与 GNU timeout 语义一致），便于上层判断
 *     是「实现有错」还是「卡死」。
 *
 * 用法：
 *   node stage1-run-with-timeout.js --label "node --check main.js" \
 *        --log <日志文件> [--timeout 300] [--tail 50] [--json-out <记录文件>] \
 *        --cmd "node --check main.js"
 *   node stage1-run-with-timeout.js --label ... -- node --check main.js   # argv 模式
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const EXIT_TIMEOUT = 124;
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const opts = { timeout: 300, tail: 50, log: null, jsonOut: null, label: null, cmd: null, argv: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.argv = argv.slice(i + 1); break; }
    if (a === '--timeout') { opts.timeout = Number(argv[++i]); continue; }
    if (a === '--tail') { opts.tail = Number(argv[++i]); continue; }
    if (a === '--log') { opts.log = argv[++i]; continue; }
    if (a === '--json-out') { opts.jsonOut = argv[++i]; continue; }
    if (a === '--label') { opts.label = argv[++i]; continue; }
    if (a === '--cmd') { opts.cmd = argv[++i]; continue; }
    // 未识别的参数一律当作被跑命令的 argv 起始（宽容命令行书写）。
    opts.argv = argv.slice(i);
    break;
  }
  return opts;
}

/** 追加写入日志文件；失败仅打印警告，绝不让日志 IO 掩盖被测命令的结果。 */
function makeLogger(logPath) {
  let fd = null;
  if (logPath) {
    fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
    fd = fs.openSync(logPath, 'a');
  }
  return {
    write(text) {
      if (fd !== null) { try { fs.writeSync(fd, text); } catch (err) { console.error('[runner] 日志写入失败：' + err.message); } }
    },
    close() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败不影响退出码 */ } fd = null; } }
  };
}

/**
 * 抓取某个 PID 的整棵后代进程树快照。
 * 为什么枚举全表而不是逐层查询：Windows 上逐层 Get-CimInstance 会有 TOCTOU 与
 * 多次 500ms 级开销，超时现场要的是「一次成像」。CommandLine 缺失通常意味着
 * 进程属于其他用户/已退出，这里如实记录而不是补空。
 */
function processTreeSnapshot(rootPid) {
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3'
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true });

  if (res.error) return { error: '进程表枚举失败：' + res.error.message, nodes: [] };
  if (res.status !== 0) return { error: '进程表枚举失败（exit ' + res.status + '）：' + String(res.stderr || '').trim(), nodes: [] };

  let all;
  try {
    all = JSON.parse(res.stdout || '[]');
  } catch (err) {
    return { error: '进程表 JSON 解析失败：' + err.message, nodes: [] };
  }
  if (!Array.isArray(all)) all = [all];

  const byParent = new Map();
  for (const p of all) {
    const ppid = p.ParentProcessId;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(p);
  }

  const nodes = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of (byParent.get(cur) || [])) {
      if (seen.has(child.ProcessId)) continue;
      seen.add(child.ProcessId);
      nodes.push({
        pid: child.ProcessId,
        ppid: child.ParentProcessId,
        name: child.Name || '?',
        commandLine: child.CommandLine || '(命令行不可读)'
      });
      queue.push(child.ProcessId);
    }
  }
  return { error: null, nodes };
}

/**
 * kill 整棵树：先 taskkill /T /F，再兜底直接 kill，保证不留孤儿进程。
 * 刻意只回报状态码而不回贴 taskkill 的文本输出：它的中文输出是 GBK(OEM) 编码，
 * 直接塞进 UTF-8 日志会变成 mojibake，反而影响「卡在哪」这段证据的可读性。
 */
function killTree(pid) {
  const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'buffer', timeout: 20000, windowsHide: true });
  if (res.error) return { ok: false, detail: 'taskkill 无法执行：' + res.error.message };
  if (res.status === 0) return { ok: true, detail: 'exit=0' };
  return { ok: false, detail: `exit=${res.status === null ? 'null(超时)' : res.status}` };
}

function nowIso() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    (() => { const off = -d.getTimezoneOffset(); const s = off >= 0 ? '+' : '-'; const a = Math.abs(off); return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; })();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cmd && opts.argv.length === 0) {
    console.error('用法：node stage1-run-with-timeout.js --label <名称> [--timeout 300] [--log <文件>] --cmd "<命令>" | -- <argv...>');
    process.exit(EXIT_USAGE);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) opts.timeout = 300;

  const label = opts.label || (opts.cmd || opts.argv.join(' '));
  const cmdText = opts.cmd || opts.argv.join(' ');
  const logger = makeLogger(opts.log);

  const startedAt = Date.now();
  const startedIso = nowIso();
  const header =
    `\n${'='.repeat(78)}\n` +
    `[RUN BEGIN] ${startedIso}\n` +
    `  label    : ${label}\n` +
    `  command  : ${cmdText}\n` +
    `  timeout  : ${opts.timeout}s\n` +
    `  cwd      : ${process.cwd()}\n` +
    `${'-'.repeat(78)}\n`;
  process.stdout.write(header);
  logger.write(header);

  // cmd 模式走 cmd.exe，保证 npm.cmd / *.bat 能被正确解析；argv 模式直接 spawn。
  const child = opts.cmd
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', opts.cmd], { cwd: process.cwd(), windowsHide: true, env: process.env })
    : spawn(opts.argv[0], opts.argv.slice(1), { cwd: process.cwd(), windowsHide: true, env: process.env });

  const ring = [];
  const pushChunk = (text) => {
    logger.write(text);
    process.stdout.write(text);
    // 逐行进入环形缓冲，超时报告用它回答「最后发生了什么」。
    for (const line of text.split(/\r?\n/)) {
      if (line === '' && text.endsWith('\n')) continue;
      ring.push(line);
      while (ring.length > Math.max(opts.tail, 50) * 4) ring.shift();
    }
  };

  child.stdout.on('data', (b) => pushChunk(b.toString('utf8')));
  child.stderr.on('data', (b) => pushChunk(b.toString('utf8')));

  let finished = false;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    // 先成像再开杀：kill 之后的进程表什么都看不到了。
    const snapStarted = Date.now();
    const snapshot = processTreeSnapshot(child.pid);
    const snapMs = Date.now() - snapStarted;
    const lastLines = ring.slice(-Math.max(opts.tail, 50));

    const report =
      `\n${'-'.repeat(78)}\n` +
      `[TIMEOUT] 超过 ${opts.timeout}s 仍未结束（已运行 ${elapsed}s），开始强制终止进程树。\n` +
      `  label        : ${label}\n` +
      `  command      : ${cmdText}\n` +
      `  卡在         : ${lastLines.length ? (lastLines[lastLines.length - 1] || '(最后一行是空行)') : '(自始至终没有任何输出——典型表现为等待 stdin / 等待网络 / 等待文件锁)'}\n` +
      `  进程树快照   : ${snapshot.error ? snapshot.error : (snapshot.nodes.length + ` 个后代进程，枚举耗时 ${snapMs}ms`)}\n` +
      snapshot.nodes.map((n) => `    - pid=${n.pid} ppid=${n.ppid} ${n.name} :: ${n.commandLine}`).join('\n') +
      (snapshot.nodes.length ? '\n' : '') +
      `\n  ==== 最后 ${lastLines.length} 行输出（全文见日志文件）====\n` +
      lastLines.map((l) => '  | ' + l).join('\n') + '\n';

    process.stdout.write(report);
    logger.write(report);

    const kill = killTree(child.pid);
    process.stdout.write(`[TIMEOUT] taskkill 结果：${kill.ok ? '已终止进程树' : '失败'} ${kill.detail}\n`);
    logger.write(`[TIMEOUT] taskkill 结果：${kill.ok ? '已终止进程树' : '失败'} ${kill.detail}\n`);

    // 双保险：taskkill 失败时直接结束子进程句柄。
    try { child.kill('SIGKILL'); } catch { /* 已死 */ }

    // 给运行库 1.5s 收尾，然后无论如何都以 124 退出，不让收尾把卡死变成挂起。
    setTimeout(() => finish(EXIT_TIMEOUT, 'timeout'), 1500);
  }, opts.timeout * 1000);

  function finish(code, reason) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const tail = ring.slice(-opts.tail);
    const footer =
      `${'-'.repeat(78)}\n` +
      `[RUN END] ${nowIso()} exit=${code} reason=${reason} elapsed=${elapsed}s label=${label}\n` +
      `${'='.repeat(78)}\n`;
    process.stdout.write(footer);
    logger.write(footer);
    logger.close();

    if (opts.jsonOut) {
      const record = {
        label, command: cmdText, startedAt: startedIso, endedAt: nowIso(),
        timeoutSec: opts.timeout, exitCode: code, reason, elapsedSec: Number(elapsed),
        cwd: process.cwd(), tail
      };
      try {
        fs.mkdirSync(path.dirname(path.resolve(opts.jsonOut)), { recursive: true });
        fs.writeFileSync(opts.jsonOut, JSON.stringify(record, null, 2) + '\n');
      } catch (err) {
        console.error('[runner] 记录写入失败：' + err.message);
      }
    }
    process.exit(code);
  }

  child.on('error', (err) => {
    const msg = `[RUN ERROR] 子进程无法启动：${err.message}\n`;
    process.stdout.write(msg);
    logger.write(msg);
    finish(EXIT_USAGE, 'spawn-error');
  });

  child.on('close', (code, signal) => {
    // 超时路径由 timer 自己 finish，这里忽略 kill 后必然触发的 close。
    if (timedOut) return;
    finish(code === null ? 1 : code, signal ? 'signal:' + signal : 'exit');
  });
}

main();
