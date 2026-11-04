'use strict';

/**
 * stage1-asar-list —— 出包后对 app.asar 做「实物核对」的无依赖清单器。
 *
 * 为什么不能只看配置推断：`build.files` 白名单写对了，不代表 asar 里真的有；
 * electron-builder 的多层过滤（默认忽略、asarUnpack、node_modules 处理、
 * extraResources 之外的隐式规则）任何一层都可能把文件吃掉。用户现场看到的是
 * 「设置窗白屏」「主进程 require 失败」，而构建日志里全是绿色的。
 *
 * 所以出包后必须从**产物本身**读出文件清单，并与门禁算出的引用闭包逐项对账。
 * 本工具直接解析 asar 头部（Chromium pickle + JSON 目录树），不依赖
 * @electron/asar / asar / node 模块 —— 离线可用，也不会因工具缺失而"跳过验收"。
 *
 * 用法：
 *   node stage1-asar-list.js <app.asar>                       # 打印全部条目
 *   node stage1-asar-list.js <app.asar> --json <文件>          # 落盘清单
 *   node stage1-asar-list.js <app.asar> --compare-gate <门禁导出的 json>
 *   node stage1-asar-list.js <app.asar> --expect a.js,b.html   # 逐项断言存在
 *   退出码：0=通过；1=有缺失；2=用法/读取错误。
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = { asar: null, json: null, compareGate: null, expect: [], listOnly: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = argv[++i];
    else if (a === '--compare-gate') o.compareGate = argv[++i];
    else if (a === '--expect') o.expect.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--quiet') o.quiet = true;
    else if (!a.startsWith('--')) o.asar = a;
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  if (!o.asar) {
    console.error('用法：node stage1-asar-list.js <app.asar> [--json <文件>] [--compare-gate <json>] [--expect a,b]');
    process.exit(2);
  }
  return o;
}

/**
 * 解析 asar 头部并返回目录树。
 * 头部布局（Chromium pickle）：
 *   [0..4)  payloadSize=4
 *   [4..8)  headerSize
 *   [8..8+headerSize)  pickle: [payloadSize][stringLen][JSON 字符串]
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    const n = fs.readSync(fd, sizeBuf, 0, 8, 0);
    if (n !== 8) throw new Error('文件过短，不是有效的 asar');
    const size = sizeBuf.readUInt32LE(4);
    if (!size || size > 512 * 1024 * 1024) throw new Error(`头部长度异常：${size}`);

    const headerBuf = Buffer.alloc(size);
    const m = fs.readSync(fd, headerBuf, 0, size, 8);
    if (m !== size) throw new Error('头部读取不完整');

    const stringLen = headerBuf.readUInt32LE(4);
    if (!stringLen || stringLen > size) throw new Error(`JSON 长度异常：${stringLen}`);
    const jsonText = headerBuf.toString('utf8', 8, 8 + stringLen);
    return { header: JSON.parse(jsonText), headerSize: size };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把目录树摊平成相对路径列表（asar 内路径统一用 / 分隔）。 */
function flatten(node, prefix = '', out = []) {
  const entries = node && node.files ? node.files : {};
  for (const name of Object.keys(entries)) {
    const child = entries[name];
    const rel = prefix ? `${prefix}/${name}` : name;
    const isDir = child && child.files && !child.link;
    if (isDir) {
      flatten(child, rel, out);
    } else {
      out.push({
        path: rel,
        size: typeof child.size === 'number' ? child.size : null,
        unpacked: !!child.unpacked,
        link: child.link || null,
        executable: !!child.executable
      });
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const asarPath = path.resolve(opts.asar);
  if (!fs.existsSync(asarPath)) { console.error('找不到 asar：' + asarPath); process.exit(2); }

  let header;
  try {
    header = readAsarHeader(asarPath);
  } catch (err) {
    console.error('解析 asar 头部失败：' + err.message);
    process.exit(2);
  }

  const files = flatten(header.header);
  const packed = files.filter((f) => !f.unpacked);
  const unpacked = files.filter((f) => f.unpacked);

  if (!opts.quiet) {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('  app.asar 实物清单');
    console.log(`  文件      : ${asarPath}`);
    console.log(`  字节      : ${fs.statSync(asarPath).size}`);
    console.log(`  头部长度  : ${header.headerSize} 字节`);
    console.log(`  条目总数  : ${files.length}（asar 内 ${packed.length} / 标记 unpacked ${unpacked.length}）`);
    console.log('══════════════════════════════════════════════════════════════════════');
    // 只打印根级与"应用源码"部分：node_modules 上万条会淹掉关键信息。
    const interesting = files.filter((f) => !f.path.startsWith('node_modules/'));
    console.log(`\n【应用文件】${interesting.length} 条（node_modules 部分 ${files.length - interesting.length} 条，默认不展开）`);
    for (const f of interesting) {
      const tag = f.unpacked ? ' [unpacked]' : '';
      console.log(`  · ${f.path}  (${f.size === null ? '?' : f.size} B)${tag}`);
    }
  }

  const packedPaths = new Set(files.map((f) => f.path));

  // ── 闭包对账 ─────────────────────────────────────────────────────────────
  const missing = [];
  let gateInfo = null;
  if (opts.compareGate) {
    const gatePath = path.resolve(opts.compareGate);
    gateInfo = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
    const closure = Array.isArray(gateInfo.closureFiles) ? gateInfo.closureFiles : [];
    console.log('');
    console.log('【闭包对账】门禁闭包 vs asar 实物');
    console.log(`  门禁记录 : ${gatePath}`);
    console.log(`  闭包文件 : ${closure.length}`);
    // 空闭包必须判失败：拿错文件（例如误传编译门禁的汇总 JSON）会让"全覆盖"变成一句空话，
    // 那是最危险的一种假通过 —— 核对项为 0 就等于什么都没核对。
    if (closure.length === 0) {
      console.log('  ✖ 门禁 JSON 里没有任何 closureFiles（是不是传错了文件？需要 build-files-gate.js 导出的 --json）');
      missing.push('(closureFiles 为空，无法核对)');
    }
    for (const rel of closure) {
      const posix = rel.replace(/\\/g, '/');
      if (!packedPaths.has(posix)) missing.push(posix);
    }
    if (missing.length) {
      console.log(`  ✖ asar 内缺失 ${missing.length} 项：`);
      for (const m of missing) console.log(`    ✖ ${m}`);
    } else {
      console.log('  ✔ 闭包内每一个文件都在 asar 里');
    }
  }

  for (const rel of opts.expect) {
    const posix = rel.replace(/\\/g, '/');
    if (!packedPaths.has(posix) && !missing.includes(posix)) {
      missing.push(posix);
      if (!opts.quiet) console.log(`  ✖ --expect 未满足：${posix}`);
    }
  }

  // ── node_modules 运行期裸包核对（用户现场 require 的落点）───────────────
  const bareNeeds = [];
  if (gateInfo && Array.isArray(gateInfo.barePackages)) bareNeeds.push(...gateInfo.barePackages);
  if (bareNeeds.length) {
    console.log('');
    console.log('【运行期裸包】asar 内 node_modules 实测');
    const nm = files.filter((f) => f.path.startsWith('node_modules/'));
    console.log(`  asar 内 node_modules 条目数：${nm.length}`);
    for (const name of bareNeeds) {
      const prefix = `node_modules/${name}/`;
      const hit = nm.filter((f) => f.path.startsWith(prefix));
      if (hit.length) {
        // 入口文件必须真的在（否则 require 仍会失败）：优先找 package.json 与 main 字段指向的文件。
        const pkgEntry = hit.find((f) => f.path === `${prefix}package.json`);
        console.log(`  ✔ ${name}：${hit.length} 个文件${pkgEntry ? '，含 package.json' : '（⚠ 未见 package.json）'}`);
        if (!pkgEntry) missing.push(`${prefix}package.json`);
      } else {
        console.log(`  ✖ ${name}：asar 内完全没有该包`);
        missing.push(`node_modules/${name}`);
      }
    }
  }

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify({
      generatedAt: new Date().toISOString(),
      asar: asarPath,
      asarBytes: fs.statSync(asarPath).size,
      headerBytes: header.headerSize,
      total: files.length,
      appFiles: files.filter((f) => !f.path.startsWith('node_modules/')).map((f) => f.path),
      nodeModulesTopLevel: [...new Set(files.filter((f) => f.path.startsWith('node_modules/')).map((f) => f.path.split('/')[1]))].sort(),
      nodeModulesCount: files.filter((f) => f.path.startsWith('node_modules/')).length,
      missing,
      passed: missing.length === 0
    }, null, 2) + '\n');
  }

  console.log('');
  if (missing.length) {
    console.log(`结论：✖ 实物核对未通过 —— ${missing.length} 项在 asar 里找不到，装到真机必然出问题。`);
    process.exit(1);
  }
  console.log('结论：✔ 实物核对通过。');
}

main();
