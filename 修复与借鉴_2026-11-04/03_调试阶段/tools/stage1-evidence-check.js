'use strict';

/**
 * stage1-evidence-check —— 验收证据「有效性」通用断言（防再次产出假证据）。
 *
 * 为什么必须有这条断言：
 *   本仓库真实翻车过一次 —— 两张文件名写着「首帧」的截图，实际抓到的是前台**别的程序**
 *   （一个游戏画面、一个播放器窗口），原因是拿 `CopyFromScreen` 做了**全桌面截屏**。
 *   如果验收文档据此写「已确认首帧正常」，那比不截图更糟：它让视觉验收变成形式主义，
 *   还可能正好掩盖真白屏。
 *
 * 纪律（本工具把它变成机械断言）：
 *   1) 截图必须来自 **target 级**（CDP `Page.captureScreenshot`）或 **HWND 级**（`PrintWindow`
 *      且抓前断言窗口标题匹配）——全桌面截屏一律不认；
 *   2) 每张图必须有**同名 .json 元数据**，至少包含 captureMethod / capturedAt /
 *      targetUrl（CDP）或 windowTitle（HWND）/ assertions；
 *   3) 元数据里的关键断言必须为真（readyState=complete、URL 是本地后端、DOM 有实质内容）。
 *   缺任一条 → 该图**不得**作为验收证据，本工具 exit 1。
 *
 * 用法：
 *   node stage1-evidence-check.js <png...> [--root <目录>] [--json <输出>]
 *   退出码：0=全部有效；1=存在无效证据；2=用法错误。
 */

const fs = require('fs');
const path = require('path');

const INVALID_SUFFIX = '无效证据_全桌面截屏';

function main() {
  const args = process.argv.slice(2);
  let jsonOut = null;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--root') {
      const root = args[++i];
      for (const f of fs.readdirSync(root)) if (/\.png$/i.test(f)) targets.push(path.join(root, f));
    } else targets.push(args[i]);
  }
  if (targets.length === 0) { console.error('用法：node stage1-evidence-check.js <png...> [--root <目录>] [--json <输出>]'); process.exit(2); }

  const rows = [];
  let bad = 0;
  for (const png of targets) {
    const name = path.basename(png);
    const rec = { image: png, status: 'INVALID', reasons: [], meta: null };

    // ① 已标注作废的历史证据：单独归类，不算"当前无效"（它们是被诚实标记过的）
    if (name.includes(INVALID_SUFFIX)) {
      rec.status = 'RETIRED';
      rec.reasons.push('文件名已标注为无效证据（历史全桌面截屏），仅作教训留存');
      rows.push(rec);
      continue;
    }

    if (!fs.existsSync(png)) { rec.reasons.push('文件不存在'); rows.push(rec); bad++; continue; }
    const metaPath = png.replace(/\.png$/i, '') + '.json';
    if (!fs.existsSync(metaPath)) {
      rec.reasons.push('缺少同名 .json 元数据（无元数据的图不作为验收证据）');
      rows.push(rec); bad++; continue;
    }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (err) { rec.reasons.push('.json 元数据无法解析：' + err.message); rows.push(rec); bad++; continue; }
    rec.meta = meta;

    const method = String(meta.captureMethod || '');
    const isCdp = /cdp-page-captureScreenshot/i.test(method);
    const isHwnd = /hwnd-printwindow/i.test(method);
    // Electron 自带的 webContents.capturePage() 抓的是**该窗口自身的页面内容**，
    // 与 CDP 的 Page.captureScreenshot 同属 target 级（物理上抓不到别的程序），因此也接受。
    const isCapturePage = /electron-webContents-capturePage/i.test(method);
    if (!isCdp && !isHwnd && !isCapturePage) {
      rec.reasons.push(`captureMethod 不合规：'${method}'（只接受 cdp-page-captureScreenshot / electron-webContents-capturePage / hwnd-printwindow）`);
    }
    if (isCdp) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(meta.targetUrl || ''))) rec.reasons.push('targetUrl 不是本地后端页面');
      const a = meta.assertions || {};
      if (a.readyState !== 'complete') rec.reasons.push('断言未满足：readyState !== complete');
      if (a.nodesOk === false) rec.reasons.push('断言未满足：DOM 节点数不足');
      if (a.anchorsOk === false) rec.reasons.push('断言未满足：关键 UI 锚点未命中');
      if (a.errorishEmpty === false) rec.reasons.push('断言未满足：页面有报错文案');
      if (a.interactivePresent === false) rec.reasons.push('断言未满足：页面无任何可交互元素');
    }
    if (isCapturePage) {
      if (!/^file:\/\//.test(String(meta.targetUrl || ''))) rec.reasons.push('targetUrl 不是本地页面（设置窗应为 file:// 的 asar 内页面）');
      if (!/设置/.test(String(meta.windowTitle || ''))) rec.reasons.push('windowTitle 不含「设置」（抓错窗口）');
      const a = meta.assertions || {};
      if (a.nodesOk === false) rec.reasons.push('断言未满足：设置窗 DOM 节点数不足');
      if (a.interactivePresent === false) rec.reasons.push('断言未满足：设置窗无表单控件');
      if (a.anchorsOk === false) rec.reasons.push('断言未满足：设置窗锚点未命中');
      if (a.errorishEmpty === false) rec.reasons.push('断言未满足：设置窗有报错文案');
    }
    if (isHwnd) {
      if (!/DSH Desktop/.test(String(meta.windowTitle || ''))) rec.reasons.push('windowTitle 不匹配 DSH Desktop（抓错窗口）');
    }
    if (!meta.capturedAt) rec.reasons.push('缺少 capturedAt');

    if (rec.reasons.length === 0) { rec.status = 'VALID'; }
    else { bad++; }
    rows.push(rec);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('  验收截图有效性检查（target 级 / HWND 级 + 元数据 + 断言）');
  console.log('══════════════════════════════════════════════════════════════════════════');
  for (const r of rows) {
    const mark = r.status === 'VALID' ? '✔ 有效' : r.status === 'RETIRED' ? '⊘ 已作废' : '✖ 无效';
    console.log(`  ${mark}  ${path.basename(r.image)}`);
    for (const reason of r.reasons) console.log(`        · ${reason}`);
    if (r.meta && r.status === 'VALID') console.log(`        · ${r.meta.captureMethod} @ ${r.meta.targetUrl || r.meta.windowTitle}`);
  }
  const valid = rows.filter((r) => r.status === 'VALID').length;
  const retired = rows.filter((r) => r.status === 'RETIRED').length;
  console.log('');
  console.log(`  合计：有效 ${valid} / 无效 ${bad} / 已标注作废 ${retired}`);
  console.log(`  结论：${bad ? '✖ 存在无效证据 —— 不得写入验收结论' : '✔ 证据均可采信'}`);
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('');

  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ checkedAt: new Date().toISOString(), rows, valid, invalid: bad, retired, passed: bad === 0 }, null, 2) + '\n');
  }
  process.exit(bad ? 1 : 0);
}

main();
