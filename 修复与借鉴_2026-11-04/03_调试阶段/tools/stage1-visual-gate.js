'use strict';

/**
 * stage1-visual-gate —— 视觉验收的**可复算门禁**（输入 png + json，自动断言，不满足 exit 1）。
 *
 * 为什么要有它：本项目已经因为"截图证据"翻过两次车 ——
 *   ① 用全桌面截屏，抓到的是前台别人的窗口（文件名却叫「首帧」）；
 *   ② 只落了 .json，PNG 在失败分支被删掉（"有元数据没图"，同样不能当证据）。
 * 靠人眼看、靠临时命令查，都会再犯。所以把"证据有效"变成一条能跑的门禁：
 *
 *   【每一条断言都必须能解释成一种缺陷】—— 禁止魔法阈值：
 *     · PNG 存在            → 防"有 json 没图"
 *     · 字节数 >= 截断下限   → **只防写盘截断/0 字节/几 KB 占位**，不用于判定内容质量
 *                              （旧版把它写成 `> 51200`，等于惩罚"界面简单"：空工作区首页白底占 79.5%，
 *                                PNG 压出来就是 49 KB；那是针对某个样例调出来的阈值，必须废弃）
 *     · PNG magic 正确      → 防"不是 PNG / 被截断到认不出"
 *     · 尺寸对 json.viewport → 防"抓的是别的 target / 别的 DPR"（等比缩放容差）
 *     · captureMethod 合规  → 防"全桌面截屏抓错窗口"
 *     · consoleErrors 空    → 防"页面带着报错被当成正常首帧"
 *     · failedAssertions 空 → 防"采集时自己声明的断言不达标还入库"
 *     · domProbe 锚点命中   → 防"这张图确实是我们的 UI，而不是某个空白页/错误页"
 *     · 像素非空白          → 防"白屏/黑屏/纯色占位"
 *   内容质量由「锚点 + 像素非空白 + 尺寸」三项共同承担，字节数不参与质量判定。
 *
 * 用法：
 *   node stage1-visual-gate.js <png> <json> [--min-bytes 8192] [--anchors 新会话,插件,工作区] [--out X]
 *   可批量：node stage1-visual-gate.js --pair <png> <json> [--pair <png> <json> ...]
 *   退出码：0=全部通过；1=有不通过项；2=用法错误。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const validator = path.join(__dirname, 'stage1-png-validate.js');

// 截断下限：只用来挡"写盘写了一半 / 0 字节 / 几 KB 占位"。
// 正常 PNG 的最小合理值是几十 KB；8 KB 以下几乎只可能是截断或占位文件。
const TRUNCATION_FLOOR = 8192;

// 默认锚点：按采集方式来分（主窗 Web UI / 设置窗）。
// 这些词是界面里稳定存在的结构性标签，命中它们说明"这确实是我们那一屏"。
const DEFAULT_ANCHORS = {
  'cdp-page-captureScreenshot': ['新会话', '插件', '工作区'],
  'electron-webContents-capturePage': ['更新', '设置']
};

function main() {
  const argv = process.argv.slice(2);
  const pairs = [];
  let minBytes = TRUNCATION_FLOOR;
  let out = null;
  let anchorsOverride = null;
  let cur = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-bytes') minBytes = Number(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--anchors') anchorsOverride = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--pair') { if (cur.length === 2) { pairs.push(cur); cur = []; } }
    else if (a === '--label') { /* 标签仅用于输出，忽略 */ }
    else cur.push(a);
  }
  if (cur.length) pairs.push(cur);
  if (pairs.length === 0) { console.error('用法：node stage1-visual-gate.js <png> <json> [--min-bytes N] [--anchors a,b] [--out X]'); process.exit(2); }

  const results = [];
  let failedTotal = 0;
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('  视觉验收门禁（存在 / magic / 尺寸 / 元数据断言 / 非空白）');
  console.log('══════════════════════════════════════════════════════════════════════════');

  for (const [png, jsonPath] of pairs) {
    const checks = [];
    const rec = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: String(detail === undefined ? '' : detail) }); };
    console.log('');
    console.log(`  ▸ ${path.basename(png)}`);

    const exists = fs.existsSync(png);
    rec('PNG 存在', exists, exists ? null : '文件不存在 —— "只有 json 没有图"不得作为证据');
    let meta = null;
    const jsonExists = fs.existsSync(jsonPath);
    rec('同名 .json 元数据存在', jsonExists, jsonPath);
    if (jsonExists) { try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (err) { rec('.json 可解析', false, err.message); } }

    if (exists) {
      const buf = fs.readFileSync(png);
      // 注意：这一项**只防截断**，不判定内容质量（见文件头说明）。
      rec(`字节数 >= 截断下限 ${minBytes}（只防写盘截断，不判内容质量）`, buf.length >= minBytes, `${buf.length} 字节`);
      const magicOk = buf.length > 8 && buf.slice(0, 8).equals(PNG_MAGIC);
      rec('PNG magic 正确（89 50 4E 47 0D 0A 1A 0A）', magicOk, magicOk ? '89 50 4E 47 0D 0A 1A 0A' : '前 8 字节不是 PNG 签名');
      if (magicOk && meta && meta.viewport) {
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        const rw = w / meta.viewport.width, rh = h / meta.viewport.height;
        rec('尺寸与 json.viewport 成等比缩放（防抓错 target/DPR）', Math.abs(rw - rh) <= 0.02 && rw >= 0.99 && rw <= 3.01,
          `图 ${w}×${h} vs viewport ${meta.viewport.width}×${meta.viewport.height} → ${rw.toFixed(3)}×/${rh.toFixed(3)}×`);
      }
    }

    if (meta) {
      const ce = Array.isArray(meta.consoleErrors) ? meta.consoleErrors : [];
      rec('json.consoleErrors 为空（防带错页面当正常）', ce.length === 0, ce.length ? JSON.stringify(ce).slice(0, 200) : '空');
      const fa = Array.isArray(meta.failedAssertions) ? meta.failedAssertions : [];
      rec('json.failedAssertions 为空（采集时声明的断言必须达标）', fa.length === 0, fa.length ? fa.join(',') : '空');
      const method = String(meta.captureMethod || '');
      rec('captureMethod 为 target 级（防全桌面截屏抓错窗口）',
        /cdp-page-captureScreenshot|electron-webContents-capturePage|hwnd-printwindow/i.test(method), method || '（缺失）');

      // domProbe 锚点断言：这是"这张图确实是我们的 UI"的正解（比字节数有因果关系）
      const anchors = anchorsOverride
        || Object.entries(DEFAULT_ANCHORS).find(([m]) => method.includes(m))?.[1]
        || [];
      const probeText = [
        (meta.domProbe && meta.domProbe.bodyTextHead) || '',
        (meta.domProbe && meta.domProbe.bodyText) || ''
      ].join(' ');
      const hit = anchors.filter((k) => probeText.includes(k));
      const errorish = (meta.domProbe && Array.isArray(meta.domProbe.errorish)) ? meta.domProbe.errorish : [];
      rec(`domProbe 命中关键锚点（${anchors.join('/') || '未指定'}）`, anchors.length === 0 || hit.length === anchors.length,
        `命中 ${hit.length}/${anchors.length}：${hit.join('、') || '无'}`);
      rec('domProbe.errorish 为空（防错误浮层被当正常）', errorish.length === 0,
        errorish.length ? JSON.stringify(errorish).slice(0, 160) : '空');
    }

    // 像素级非空白证明（复用 png-validate）
    if (exists && fs.existsSync(validator)) {
      const tmpOut = path.join(path.dirname(path.resolve(png)), '.vg-' + path.basename(png) + '.json');
      try {
        execFileSync(process.execPath, [validator, png, '--json', jsonPath, '--out', tmpOut, '--min-bytes', '0'],
          { stdio: 'pipe' });
        const vr = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
        const px = vr.checks.filter((c) => /唯一颜色数|标准差|最频色/.test(c.name));
        rec('像素非空白（唯一色数/标准差/最频色占比）', px.every((c) => c.ok), px.map((c) => `${c.name.split('（')[0]}=${c.detail}`).join('；'));
        try { fs.unlinkSync(tmpOut); } catch { /* 清理失败不影响结论 */ }
      } catch (err) {
        rec('像素非空白（唯一色数/标准差/最频色占比）', false, 'png-validate 执行失败：' + (err.message || err).toString().slice(0, 160));
      }
    }

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`      ${c.ok ? '✔' : '✖'} ${c.name}${c.detail && c.detail !== 'null' ? '  —— ' + c.detail : ''}`);
    console.log(`      结论：${failed.length ? `✖ ${failed.length} 项不通过` : '✔ 通过'}（${checks.length} 项）`);
    failedTotal += failed.length;
    results.push({ png: path.resolve(png), json: path.resolve(jsonPath), checks, passed: failed.length === 0 });
  }

  console.log('');
  console.log(`  合计：${results.length} 组，失败 ${failedTotal} 项`);
  console.log(`  结论：${failedTotal ? '✖ 视觉证据不可采信' : '✔ 视觉证据全部可采信'}`);
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('');

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify({ checkedAt: new Date().toISOString(), minBytes, results, passed: failedTotal === 0 }, null, 2) + '\n');
  }
  process.exit(failedTotal ? 1 : 0);
}

main();
