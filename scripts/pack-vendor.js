'use strict';

/**
 * Pack the two large vendor trees (vendor/dsh + vendor/runtime) into N
 * multi-threaded 7-Zip PARTS: build/payload/vendor-0.7z … vendor-(N-1).7z.
 *
 * Why N parts instead of one archive: `7za t` (decode-only) on the single
 * archive is ~0.8 s, so LZMA2 decompression is NOT the first-run cost — 7za
 * writes the extracted files with a SINGLE thread, and creating ~31.8k tiny
 * files dominates (measured ~80-85 s for one `7za x`, vs 44 s single-threaded
 * per-file copy and 7.5 s for robocopy /MT:16). The only way to parallelise the
 * WRITE side is to run several 7za processes concurrently over DISJOINT parts.
 * updater-backend.js extracts every part concurrently into the backend root.
 *
 * Balance strategy: parts are balanced by FILE COUNT (file creation is the
 * cost), not by bytes. We split the trees into fine-grained candidate entries
 * (recursively descending until each candidate holds <= a target file count),
 * then bin-pack largest-first into the currently-smallest bucket.
 *
 * Layout contract (so `7za x <part> -o<backendRoot>` for EVERY part reproduces
 * exactly the directory-copy fallback layout):
 *   - runtime candidates are packed with cwd = vendor/runtime, entries relative
 *     to it  -> stored as node.exe, node_modules\**  -> extract to <root>\...
 *   - dsh candidates are packed with cwd = vendor, entries like dsh\...
 *     (scoped packages naturally recursed as dsh\...\@scope\<pkg>)
 *     -> stored as dsh\**  -> extract to <root>\dsh\**
 * A single part may hold candidates from BOTH bases; we then invoke 7za once
 * per base with the SAME output archive (the second call appends).
 *
 * Idempotent: repacking is skipped when the correct number of parts already
 * exists and every part is newer than every input file. Stale vendor.7z or
 * leftover vendor-*.7z from a previous N are removed so payload generations
 * never mix.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const RUNTIME_DIR = path.join(VENDOR, 'runtime');
const DSH_DIR = path.join(VENDOR, 'dsh');
const OUT_DIR = path.join(ROOT, 'build', 'payload');
const LEGACY_ARCHIVE = path.join(OUT_DIR, 'vendor.7z');

// The bundled Windows x64 7za.exe (this is exactly the binary we also ship as
// resources/payload/7za.exe, so pack-time and install-time behavior match).
const SEVEN_ZA = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

// Multi-threaded compression + explicit LZMA2 block size for MT decompression.
const COMPRESS_FLAGS = ['-t7z', '-m0=LZMA2:d64m:c16m', '-mx=5', '-mmt=on'];

// Number of parts (default 8, overridable, clamped to 1..16).
function partCount() {
  const raw = parseInt(process.env.DSH_PAYLOAD_PARTS || '8', 10);
  if (!Number.isFinite(raw)) return 8;
  return Math.max(1, Math.min(16, raw));
}

// Max number of entries passed to a single 7za invocation (keeps the Windows
// command line well under its ~32k limit even for very fine granularity).
const MAX_ENTRIES_PER_CALL = 150;

function log(m) { console.log('[pack-vendor] ' + m); }

function assertExists(p, what) {
  if (!fs.existsSync(p)) throw new Error(`${what} 不存在：${p}`);
}

// Latest mtime (ms) across every file/dir under `dir`.
function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (ent.isDirectory()) stack.push(full);
    }
  }
  return newest;
}

// Recursive file count for a subtree (files only, not directories).
function countFiles(abs) {
  let n = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else n++;
    }
  }
  return n;
}

// The list of part archive paths for a given N.
function partPaths(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(path.join(OUT_DIR, `vendor-${i}.7z`));
  return out;
}

// Every existing vendor-*.7z under the payload dir.
function existingParts() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs.readdirSync(OUT_DIR)
    .filter((f) => /^vendor-\d+\.7z$/.test(f))
    .map((f) => path.join(OUT_DIR, f));
}

/**
 * Recursively split a directory subtree into candidate entries whose file count
 * is <= targetMax. Each candidate is either a directory (packed wholesale) or a
 * group of loose files. `rel` is the path relative to `base`; stored paths keep
 * `rel` so extraction to <root> reproduces the layout.
 * Returns { total, candidates:[{ entries:[rel...], files }] }.
 */
function splitDir(base, rel, targetMax) {
  const abs = path.join(base, rel);
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return { total: 0, candidates: [] }; }
  const subdirs = [];
  const looseFiles = [];
  for (const e of ents) {
    if (e.isDirectory()) subdirs.push(e.name);
    else looseFiles.push(e.name);
  }
  let total = looseFiles.length;
  const childResults = [];
  for (const d of subdirs) {
    const r = splitDir(base, path.join(rel, d), targetMax);
    total += r.total;
    childResults.push(r);
  }
  // Small enough: pack this whole subtree as ONE candidate directory.
  if (total <= targetMax) {
    return { total, candidates: [{ entries: [rel], files: total }] };
  }
  // Too big: keep children split; group this level's loose files as one candidate.
  const candidates = [];
  for (const r of childResults) for (const c of r.candidates) candidates.push(c);
  if (looseFiles.length) {
    candidates.push({ entries: looseFiles.map((f) => path.join(rel, f)), files: looseFiles.length });
  }
  return { total, candidates };
}

/**
 * Collect candidates for a base directory given its top-level entry names.
 * Each returned candidate carries its base so bin-packing can group by base.
 */
function collectFromBase(base, targetMax) {
  const candidates = [];
  const looseTop = [];
  for (const name of fs.readdirSync(base)) {
    const abs = path.join(base, name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      const r = splitDir(base, name, targetMax);
      for (const c of r.candidates) candidates.push({ base, entries: c.entries, files: c.files });
    } else {
      looseTop.push(name);
    }
  }
  if (looseTop.length) candidates.push({ base, entries: looseTop, files: looseTop.length });
  return candidates;
}

function run7za(args, cwd) {
  const res = spawnSync(SEVEN_ZA, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`7za 失败(code ${res.status})：${args.slice(0, 6).join(' ')} …(+${Math.max(0, args.length - 6)} entries)\n${res.stderr || res.stdout}`);
  }
  return res.stdout || '';
}

// Pack all candidates assigned to one bucket into archivePath. Candidates are
// grouped by base (one 7za pass per base, appending), and each pass is chunked
// so the command line can never overflow.
function packBucket(archivePath, bucketCandidates) {
  const byBase = new Map();
  for (const c of bucketCandidates) {
    if (!byBase.has(c.base)) byBase.set(c.base, []);
    for (const e of c.entries) byBase.get(c.base).push(e);
  }
  for (const [base, entries] of byBase) {
    for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_CALL) {
      const chunk = entries.slice(i, i + MAX_ENTRIES_PER_CALL);
      run7za(['a', ...COMPRESS_FLAGS, archivePath, ...chunk], base);
    }
  }
}

function isFresh(parts) {
  // Fresh only when: no legacy single archive lingers, exactly the parts for the
  // current N exist (and no extras), and every part is newer than every input.
  if (fs.existsSync(LEGACY_ARCHIVE)) return false;
  const existing = existingParts().sort();
  const want = parts.slice().sort();
  if (existing.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (existing[i] !== want[i]) return false;
  for (const p of parts) if (!fs.existsSync(p)) return false;
  let oldestPart = Infinity;
  for (const p of parts) oldestPart = Math.min(oldestPart, fs.statSync(p).mtimeMs);
  const newestInput = Math.max(newestMtime(RUNTIME_DIR), newestMtime(DSH_DIR));
  return oldestPart >= newestInput;
}

function main() {
  assertExists(SEVEN_ZA, '捆绑的 7za.exe');
  assertExists(RUNTIME_DIR, 'vendor/runtime');
  assertExists(DSH_DIR, 'vendor/dsh');

  const N = partCount();
  const parts = partPaths(N);

  if (isFresh(parts)) {
    let totalSize = 0;
    for (const p of parts) totalSize += fs.statSync(p).size;
    log(`已是最新的 ${N} 个分卷（均比所有输入文件新），跳过重打包。合计=${(totalSize / 1048576).toFixed(1)} MB`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Remove stale generations: the legacy single archive AND any leftover parts
  // (possibly from a different N) so the payload can never mix generations.
  try { fs.unlinkSync(LEGACY_ARCHIVE); } catch {}
  for (const stale of existingParts()) { try { fs.unlinkSync(stale); } catch {} }

  const started = Date.now();

  // Single structural walk to count files, used to size the split granularity.
  const totalFiles = countFiles(RUNTIME_DIR) + countFiles(DSH_DIR);
  // Aim for many small candidates so bin-packing balances well; the largest
  // indivisible unit still bounds the fullest bucket (reported below).
  const targetMax = Math.max(200, Math.ceil(totalFiles / (N * 8)));
  log(`total files=${totalFiles}, parts N=${N}, candidate targetMax=${targetMax} files`);

  // Candidates from both bases. Runtime entries are relative to vendor/runtime;
  // dsh entries are like dsh\... relative to vendor.
  const candidates = [
    ...collectFromBase(RUNTIME_DIR, targetMax),
    ...collectFromBase(VENDOR, targetMax).filter((c) => c.entries.every((e) => e === 'dsh' || e.startsWith('dsh' + path.sep)))
  ];
  log(`generated ${candidates.length} candidate entr(ies)`);

  // Bin-pack largest-first into the currently-smallest bucket (by file count).
  candidates.sort((a, b) => b.files - a.files);
  const buckets = [];
  for (let i = 0; i < N; i++) buckets.push({ files: 0, candidates: [] });
  for (const c of candidates) {
    let min = 0;
    for (let i = 1; i < N; i++) if (buckets[i].files < buckets[min].files) min = i;
    buckets[min].files += c.files;
    buckets[min].candidates.push(c);
  }

  // Emit each part.
  let totalSize = 0;
  let totalPacked = 0;
  for (let i = 0; i < N; i++) {
    packBucket(parts[i], buckets[i].candidates);
    const size = fs.existsSync(parts[i]) ? fs.statSync(parts[i]).size : 0;
    totalSize += size;
    totalPacked += buckets[i].files;
    log(`vendor-${i}.7z: ${buckets[i].files} files, ${(size / 1048576).toFixed(2)} MB`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`packed ${totalPacked} files into ${N} parts, total size=${(totalSize / 1048576).toFixed(2)} MB (${totalSize} bytes), pack time=${secs}s`);
}

main();
