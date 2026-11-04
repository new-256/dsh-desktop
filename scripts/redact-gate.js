'use strict';

/**
 * redact-gate —— 提交前脱敏门禁（幂等、可复算、供 `git commit` 前逐次运行）。
 *
 * 为什么需要它（这个坑是真踩过的）：
 *   0.3.50 入库后才发现，证据 JSON 里带着**完整的本地后端 URL**：
 *     `http://127.0.0.1:58189/?token=<40 位一次性令牌>`
 *   这 token 是那次进程的一次性本地会话令牌（进程退出即失效，实际风险低），但仓库是公开的，
 *   "提交里出现 40 字符 token" 这条本身就不合格。靠人眼复查 300 个文件是靠不住的，
 *   所以把它变成一条能跑的门禁：**命中就不许提交**。
 *
 * 检查项（阻塞级，命中即 exit 1）：
 *   · `token=<16+ 位字母数字/下划线/点/连字符>`  —— 本地会话 token、以及各种 ?token= 链接
 *   · `ghp_…` / `github_pat_…`                   —— GitHub 个人令牌
 *   · `npm_…`                                    —— npm token
 *   · `sk-…`                                     —— 各家 API key 的通用前缀
 *   · `-----BEGIN … PRIVATE KEY-----`            —— 私钥
 *   · `AKIA…` / `xox[baprs]-…`                    —— AWS / Slack 凭据
 * 另外给出**非阻塞**告警：仍含 `C:\Users\<本机用户名>\` 的绝对路径（降低信息暴露面用）。
 *
 * 白名单（`scripts/redact-gate.allowlist.json`）：
 *   只允许**测试夹具**这类"故意写成凭据样式来验证脱敏逻辑"的内容，且必须写理由；
 *   命中白名单不会静默跳过，而是以 `ALLOWED` 明示，便于审计。
 *
 * 用法：
 *   node scripts/redact-gate.js                # 默认扫描 git 暂存区（提交前用这个）
 *   node scripts/redact-gate.js --all          # 扫描所有已跟踪文件（例行体检）
 *   node scripts/redact-gate.js --paths a,b    # 扫描指定文件/目录
 *   node scripts/redact-gate.js --selftest     # 自检：确认门禁真的能抓到假 token
 *   退出码：0=干净；1=命中阻塞项；2=用法/环境错误。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BLOCKING = [
  { name: '本地/会话 token（token=<16+>）', rx: /token=([A-Za-z0-9_.\-]{16,})/g },
  { name: 'GitHub PAT（ghp_）', rx: /ghp_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub PAT（github_pat_）', rx: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'npm token（npm_）', rx: /npm_[A-Za-z0-9]{20,}/g },
  { name: 'API key（sk-）', rx: /sk-[A-Za-z0-9]{16,}/g },
  { name: '私钥块', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'AWS 访问键（AKIA）', rx: /AKIA[0-9A-Z]{16}/g },
  { name: 'Slack token（xox*）', rx: /xox[baprs]-[A-Za-z0-9-]{10,}/g }
];
const WARN_ONLY = [{ name: '本机绝对路径', rx: /C:\\Users\\(?!<user>)[A-Za-z0-9_.\-]+/g }];

const ALLOWLIST_PATH = path.join(__dirname, 'redact-gate.allowlist.json');

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.entries || []);
  } catch (err) {
    console.error('[redact-gate] 白名单 JSON 解析失败：' + err.message);
    process.exit(2);
  }
}

function listFiles(mode, pathsArg) {
  if (pathsArg) {
    const out = [];
    const walk = (p) => {
      if (!fs.existsSync(p)) return;
      const st = fs.statSync(p);
      if (st.isDirectory()) for (const c of fs.readdirSync(p)) walk(path.join(p, c));
      else out.push(p);
    };
    for (const p of pathsArg.split(',')) walk(p.trim());
    return out;
  }
  const args = mode === 'all'
    ? ['ls-files']
    : ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

function scan(files, allowlist, { quiet = false } = {}) {
  const hits = [];
  const allowed = [];
  const warnings = [];
  let scanned = 0, skipped = 0;

  for (const f of files) {
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) { skipped++; continue; }           // 二进制
    if (buf.length > 4 * 1024 * 1024) { skipped++; continue; }
    scanned++;
    const text = buf.toString('utf8');

    for (const rule of BLOCKING) {
      rule.rx.lastIndex = 0;
      let m;
      while ((m = rule.rx.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        const isAllowed = allowlist.some((a) => a.file === f && (a.pattern === undefined || a.rule === rule.name));
        const rec = { rule: rule.name, file: f, line, snippet: redact(m[0]) };
        if (isAllowed) {
          const why = (allowlist.find((a) => a.file === f) || {}).reason || '(未写理由)';
          allowed.push({ ...rec, reason: why });
        } else hits.push(rec);
      }
    }
    for (const rule of WARN_ONLY) {
      rule.rx.lastIndex = 0;
      let m;
      while ((m = rule.rx.exec(text)) !== null) {
        warnings.push({ rule: rule.name, file: f, line: text.slice(0, m.index).split('\n').length, snippet: redact(m[0]) });
      }
    }
  }

  if (!quiet) {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log('  提交前脱敏门禁（redact-gate）');
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log(`  扫描文件 ${scanned} 个，跳过 ${skipped} 个（二进制/超大）`);
    for (const h of hits) console.log(`  ✖ ${h.rule}  ${h.file}:${h.line}  ${h.snippet}`);
    for (const a of allowed) console.log(`  ⊘ ALLOWED（白名单）: ${a.rule}  ${a.file}:${a.line}  ${a.snippet}  —— 理由：${a.reason}`);
    if (warnings.length) {
      console.log(`  ⚠ 非阻塞告警 ${warnings.length} 处（本机绝对路径，建议改成 C:\\Users\\<user>\\）`);
      for (const w of warnings.slice(0, 5)) console.log(`      ${w.file}:${w.line}  ${w.snippet}`);
      if (warnings.length > 5) console.log(`      …另有 ${warnings.length - 5} 处`);
    }
    console.log('');
    console.log(`  结论：${hits.length ? `✖ 命中 ${hits.length} 处阻塞项 —— 不许提交` : '✔ 干净（阻塞项 0）'}`);
    console.log('══════════════════════════════════════════════════════════════════════════');
    console.log('');
  }
  return { hits, allowed, warnings, scanned, skipped };
}

function redact(s) {
  const v = s.replace(/^token=/, '');
  return v.length <= 6 ? s : (s.startsWith('token=') ? 'token=' + v.slice(0, 3) + '«redacted»' : v.slice(0, 4) + '«redacted»');
}

function selftest() {
  const tmp = path.join(require('os').tmpdir(), 'redact-gate-selftest-' + Date.now() + '.txt');
  // 故意写成"凭据样式"，验证门禁能抓到；这行只在临时目录里，不会进仓库
  const fake = 'token=' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '45';
  fs.writeFileSync(tmp, 'GET http://127.0.0.1:1234/?' + fake + '\n');
  const r = scan([tmp], [], { quiet: true });
  fs.unlinkSync(tmp);
  const ok = r.hits.length === 1 && /token=/.test(r.hits[0].rule);
  console.log(`[selftest] 造一个假 token 文件 → 命中 ${r.hits.length} 处；判定：${ok ? '✔ 门禁有效' : '✖ 门禁失效'}`);
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
const mode = argv.includes('--all') ? 'all' : 'staged';
const pathsArg = (() => { const i = argv.indexOf('--paths'); return i !== -1 ? argv[i + 1] : null; })();
const files = listFiles(mode, pathsArg);
const { hits } = scan(files, loadAllowlist());
process.exit(hits.length ? 1 : 0);
