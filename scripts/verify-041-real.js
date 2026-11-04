'use strict';
/** 0.3.41 真实环境验证（只读，绝不改动用户文件）。 */
const Module = require('module');
const os = require('os');
const path = require('path');
const STUB = '\0es';
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'electron' ? STUB : orig.call(this, r, ...a); };
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { app: { getPath: () => path.join(os.tmpdir(), 'x'), isPackaged: false, getVersion: () => 't' } } };

const mgr = require('../updater-backend.js');
const home = path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'dsh-home');

const v = mgr.validateCredentialsDocument(home);
console.log('  文件存在:', v.present);
console.log('  校验结果:', v.ok ? '✓ 结构正常（无非法凭证键）' : '✗ 发现 ' + v.problems.length + ' 条问题');
v.problems.forEach((p) => console.log('    行' + p.line + ': ' + p.key + ' — ' + p.reason));

const log = [
  'dsh: startup failed: 1 required plugin did not activate',
  '',
  'Failed plugins (1):',
  '  credentials',
  '    Package: @deepseek-ai/dsh-credentials-local',
  '    TypeError: credential key "repo-push-access:github.com" must be "<scope>/<id>"'
].join('\n');
const a = mgr.analyzeCredentialFailure(log);
console.log('\n  事故日志归因: credentials=' + a.credentials + '  keys=' + JSON.stringify(a.keys) + '  pluginCount=' + a.pluginCount);

// 模拟：若事故当天装了 0.3.41，护栏会怎么做（不触碰真实文件）
console.log('\n  护栏模拟：命中凭据故障 → 跳过 profile 隔离 =', a.credentials ? '✓ 会跳过（不会烧 profile）' : '✗');
