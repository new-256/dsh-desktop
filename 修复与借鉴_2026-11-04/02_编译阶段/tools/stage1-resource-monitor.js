'use strict';

/**
 * stage1-resource-monitor —— 阶段一收口用的资源监控采样器（用户规则 7）。
 *
 * 为什么需要它：编译与出包都是 CPU/内存/显存密集型，而「测试跑得慢」与
 * 「机器被别的进程拖死」在日志里长得一模一样。没有独立采样的硬件曲线，
 * 任何一句「这个阶段耗时长」都不可证伪。所以测试期间必须有一个**与被测进程
 * 相互独立**的进程持续记录 CPU / 内存 / GPU / 显存，结束后给出峰值摘要。
 *
 * 采样口径：
 *   - CPU 总占用：读 os.cpus() 累计 tick 差值，跨全核加权，零额外进程开销；
 *   - 进程内存：由常驻 PowerShell 采样器按名称/端口过滤求和（见
 *     stage1-resource-monitor-sampler.ps1），不用每次冷启动 pwsh，避免采样
 *     本身污染被测负载；
 *   - GPU 使用率/显存：nvidia-smi；**不可用时写「不可用」并记原因，绝不填数字**。
 *
 * 用法：
 *   node stage1-resource-monitor.js --out <csv> [--interval 2] [--duration 0]
 *        [--name node.exe,npm.exe] [--pid 1234] [--label 阶段一编译] \
 *        [--stop-file <文件>] [--summary-json <文件>]
 *   --duration 0 表示不自动停：由 Ctrl-C 或出现 --stop-file 结束。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SAMPLER = path.join(__dirname, 'stage1-resource-monitor-sampler.ps1');
const UNAVAILABLE = '不可用';

function parseArgs(argv) {
  const o = { out: null, interval: 2, duration: 0, names: [], pids: [], label: '', stopFile: null, summaryJson: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--interval') o.interval = Number(argv[++i]);
    else if (a === '--duration') o.duration = Number(argv[++i]);
    else if (a === '--name') o.names.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--pid') o.pids.push(...String(argv[++i]).split(',').map((s) => Number(s)).filter(Boolean));
    else if (a === '--label') o.label = argv[++i];
    else if (a === '--stop-file') o.stopFile = argv[++i];
    else if (a === '--summary-json') o.summaryJson = argv[++i];
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  if (!o.out) { console.error('用法：node stage1-resource-monitor.js --out <csv> [--interval 2] [--name a,b] [--pid 1,2] [--duration sec] [--label x]'); process.exit(2); }
  if (!Number.isFinite(o.interval) || o.interval <= 0) o.interval = 2;
  return o;
}

/** CPU 全核占用百分比：把累计 tick 差值里的 idle 与总量相比，得到的是区间均值。 */
function cpuTotals() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function mb(bytes) { return bytes > 0 ? Math.round(bytes / 1048576) : 0; }

function tsLocal(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });

  const header = [
    'timestamp', 'elapsed_s', 'cpu_total_pct',
    'proc_count', 'proc_ws_mb', 'proc_pb_mb',
    'sys_mem_used_pct', 'sys_mem_avail_mb', 'sys_mem_total_mb',
    'gpu_util_pct', 'gpu_mem_used_mb', 'gpu_mem_total_mb', 'gpu_temp_c',
    'gpu_name', 'note'
  ].join(',');
  fs.writeFileSync(csvPath, header + '\n');

  const meta = `# stage1 资源监控  开始=${tsLocal()}  间隔=${opts.interval}s  ` +
    `过滤进程=${opts.names.join('|') || '(全部)'}  pid=${opts.pids.join('|') || '-'}  label=${opts.label || '-'}\n`;
  fs.appendFileSync(csvPath, meta);
  process.stdout.write(meta);

  const sampler = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', SAMPLER], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });

  const rl = readline.createInterface({ input: sampler.stdout });
  const pending = [];
  let samplerStderr = '';

  sampler.stderr.on('data', (b) => { samplerStderr += b.toString('utf8'); });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text || !text.startsWith('{')) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (data.ack) {
      process.stdout.write(`[monitor] 采样器过滤器已设置：${data.filters || '(全部)'}\n`);
      return;
    }
    if (data.error) { process.stdout.write(`[monitor] 采样器报错：${text}\n`); return; }
    const waiter = pending.shift();
    if (waiter) waiter(data);
  });

  sampler.on('error', (err) => {
    console.error('[monitor] 无法启动采样器：' + err.message);
    process.exit(1);
  });

  let stopped = false;
  let prev = cpuTotals();
  const startedAt = Date.now();
  const peaks = { cpu: 0, ws: 0, pb: 0, sysUsedPct: 0, gpuUtil: 0, gpuMem: 0, gpuTemp: 0 };
  let samples = 0;
  let gpuState = null;

  function requestSample() {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
      pending.push((d) => { if (done) return; done = true; clearTimeout(t); resolve(d); });
      sampler.stdin.write('sample\n');
    });
  }

  async function tick() {
    if (stopped) return;
    const cur = cpuTotals();
    const dIdle = cur.idle - prev.idle;
    const dTotal = cur.total - prev.total;
    prev = cur;
    const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;

    const s = await requestSample();
    if (stopped) return;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const notes = [];
    let row;

    if (!s) {
      notes.push('采样超时（采样器无响应）');
      row = [tsLocal(), elapsed, cpuPct.toFixed(1), UNAVAILABLE, UNAVAILABLE, UNAVAILABLE,
        UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE,
        UNAVAILABLE, notes.join('；')];
    } else {
      const gpu = s.gpu || { ok: false, reason: '采样器未返回 GPU 字段' };
      if (!gpu.ok) {
        gpuState = gpu.reason || 'GPU 信息不可用';
        notes.push(gpuState);
      } else {
        gpuState = gpu.name;
        peaks.gpuUtil = Math.max(peaks.gpuUtil, gpu.util || 0);
        peaks.gpuMem = Math.max(peaks.gpuMem, gpu.memUsed || 0);
        if (typeof gpu.tempC === 'number') peaks.gpuTemp = Math.max(peaks.gpuTemp, gpu.tempC);
      }
      const sysUsedPct = s.sysTotal > 0 ? ((s.sysTotal - s.sysAvail) / s.sysTotal) * 100 : 0;
      const wsMb = mb(s.procWs);
      const pbMb = mb(s.procPb);
      peaks.cpu = Math.max(peaks.cpu, cpuPct);
      peaks.ws = Math.max(peaks.ws, wsMb);
      peaks.pb = Math.max(peaks.pb, pbMb);
      peaks.sysUsedPct = Math.max(peaks.sysUsedPct, sysUsedPct);

      row = [
        tsLocal(), elapsed, cpuPct.toFixed(1),
        s.procCount, wsMb, pbMb,
        sysUsedPct.toFixed(1), mb(s.sysAvail), mb(s.sysTotal),
        gpu.ok ? gpu.util : UNAVAILABLE,
        gpu.ok ? gpu.memUsed : UNAVAILABLE,
        gpu.ok ? gpu.memTotal : UNAVAILABLE,
        gpu.ok ? (typeof gpu.tempC === 'number' ? gpu.tempC : '') : UNAVAILABLE,
        gpu.ok ? String(gpu.name || '').replace(/,/g, ' ') : UNAVAILABLE,
        notes.join('；')
      ];
    }

    const line = row.join(',');
    fs.appendFileSync(csvPath, line + '\n');
    samples++;
    // 每行都打印会淹掉被测命令的输出，这里只打印控制台摘要（5 行一次）。
    if (samples % 5 === 1) {
      process.stdout.write(`[monitor] ${row[0]} cpu=${row[2]}% ws=${row[4]}MB gpu=${row[9]}% vram=${row[10]}/${row[11]}MB\n`);
    }
  }

  function finish(reason) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { sampler.stdin.write('quit\n'); } catch { /* 已退出 */ }
    setTimeout(() => { try { sampler.kill(); } catch { /* 已退出 */ } }, 800);

    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = [
      '',
      '==== stage1 资源监控峰值摘要 ====',
      `  采样区间   : ${meta.replace('# stage1 资源监控  ', '').trim()}`,
      `  采样数     : ${samples}（间隔 ${opts.interval}s，持续 ${dur}s，结束原因：${reason}）`,
      `  CPU 峰值   : ${peaks.cpu.toFixed(1)}%（全核加权，区间均值）`,
      `  进程内存峰值: WS ${peaks.ws} MB / Private ${peaks.pb} MB`,
      `  系统内存   : 已用峰值 ${peaks.sysUsedPct.toFixed(1)}%`,
      `  GPU        : ${gpuState || '未知'}`,
      `  GPU 峰值   : 使用率 ${peaks.gpuUtil}% / 显存 ${peaks.gpuMem} MB` + (peaks.gpuTemp ? ` / 温度 ${peaks.gpuTemp}°C` : ''),
      `  CSV        : ${csvPath}`,
      samplerStderr.trim() ? `  采样器 stderr（前 500 字）: ${samplerStderr.trim().slice(0, 500)}` : '',
      ''
    ].filter(Boolean).join('\n');
    process.stdout.write(summary + '\n');
    fs.appendFileSync(csvPath, summary + '\n');

    if (opts.summaryJson) {
      fs.writeFileSync(path.resolve(opts.summaryJson), JSON.stringify({
        label: opts.label, startedAt: new Date(startedAt).toISOString(), durationSec: Number(dur),
        samples, intervalSec: opts.interval, reason, filters: opts.names, pids: opts.pids,
        peaks: { ...peaks, gpu: gpuState }, csv: csvPath
      }, null, 2) + '\n');
    }
    process.exit(0);
  }

  let timer = null;

  sampler.stdin.write(`filter ${opts.names.join(',')}\n`);
  // 首帧稍等，让采样器把 filter 的 ack 消费掉，避免和第一条 sample 抢行。
  setTimeout(async () => {
    await tick();
    timer = setInterval(() => { tick().catch((err) => process.stdout.write('[monitor] 采样异常：' + err.message + '\n')); }, opts.interval * 1000);

    if (opts.duration > 0) setTimeout(() => finish(`达到时长 ${opts.duration}s`), opts.duration * 1000);

    if (opts.stopFile) {
      const stopPath = path.resolve(opts.stopFile);
      const watch = setInterval(() => { if (fs.existsSync(stopPath)) { clearInterval(watch); finish('检测到停止文件 ' + stopPath); } }, 1000);
    }
  }, 400);

  process.on('SIGINT', () => finish('收到 SIGINT'));
  process.on('SIGTERM', () => finish('收到 SIGTERM'));
}

main();
