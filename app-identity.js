'use strict';

/**
 * app-identity —— 随包分发的**应用身份常量**（0.3.48 · H-08 复修）。
 *
 * ## 为什么需要这个文件（不是"多此一举的常量文件"）
 *
 * electron-builder 打包时会**重写 app 的 `package.json`**，把 `build`
 * （以及 `devDependencies` / `scripts`）剥离掉 —— 实测 0.3.48 A 版成品：
 * `release/win-unpacked/resources/app.asar` 里的 `package.json` 只有 503 字节，
 * 源码里那个含 `appId` 的 `build` 段**完全不存在**。
 *
 * 于是运行期 `require('./package.json')` 取 appId 的行为是：**开发态正确、
 * 成品里恒为 undefined**。后果不是"少个版本号"，而是
 * `app.setAppUserModelId()` 在 shipped 包里**从未执行** —— AUMID 保护整体空转，
 * Win10/11 可以静默丢弃托盘气泡，而托盘气泡是我们唯一的主动通知通道
 * （更新可用 / 启动失败）。也就是说：一类"用户永远收不到提示"的缺陷，
 * 在 CI 与开发机上永远复现不出来。
 *
 * 修法：身份作为**普通随包模块**分发（`*.js` 已被 `build.files` 的 `*.js`
 * 通配覆盖，因此不需要改任何构建清单），运行期只读本模块。
 *
 * ## 单一事实源与防漂移
 *
 * 构建侧权威值仍然是 `package.json` 的 `appId`（安装器按它写快捷方式身份）。
 * 本模块是**运行期**的那一份拷贝 —— 两份写死必然漂移，所以由
 * `scripts/app-identity-gate.js` 机械校验：
 *   ① 本常量与 `build.appId` 逐字符相等；
 *   ② `main.js` 确实 require 本模块并把常量喂给 `app.setAppUserModelId()`；
 *   ③ `main.js` 不再读取任何会被打包剥离的字段。
 * 三条任一不满足即 `exit 1`，已串在 `npm run dist` 前置链上 —— 漂移变成
 * **构建失败**，而不是靠某人记得同步两处字符串。
 *
 * ## 校验纪律
 *
 * 本模块被 require 时**立即自检**：非字符串 / 空串 / 不符合反向域名格式 /
 * 超过 Windows AUMID 上限 → **直接 throw**。绝不返回 `undefined` 让上层
 * 静默降级成"没有 AUMID"（那正是本缺陷最初的形态：日志里一行
 * `跳过 AppUserModelId 设置`，然后所有人都以为没事）。
 */

/** Windows AppUserModelID 的合法上限（超过会被系统截断/拒绝）。 */
const APP_ID_MAX_LEN = 128;

/**
 * 反向域名格式：至少两段、只允许小写字母/数字/短横、以点分隔。
 * 刻意不接受大写与下划线 —— 安装器与 Windows 都按这套口径识别身份，
 * 放宽容忍只会把"看起来设置了其实对不上"变成新的静默故障。
 */
const APP_ID_FORMAT = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

/** 应用身份（= 安装器写进快捷方式的 AUMID，必须与构建侧 appId 逐字符一致）。 */
const DSH_APP_ID = 'com.deepseek.dshdesktop';

/**
 * 对外小写别名与短别名 —— 值来自同一个常量，**不存在第二处字面量**。
 * 为什么要两个名字：门禁 `scripts/app-identity-gate.js` 按"导出形状"识别常量
 * （名字需形如 `…APP…ID…`），`DSH_APP_ID` 满足；而调用方按 `APP_ID` 读更自然，
 * 所以这里用别名而不是再写一遍字符串。
 */
const APP_ID = DSH_APP_ID;

/**
 * 校验一个候选 AUMID，不合法直接抛错。
 * 为什么抛而不是返回 false：调用方（main.js 的模块加载期）没有任何"合理的
 * 继续方式"——没有身份就不能假装身份是对的，必须让问题在第一次启动就暴露。
 *
 * @param {unknown} value
 * @returns {string} 合法的 appId（原样返回，便于链式使用）
 */
function assertAppId(value) {
  if (typeof value !== 'string') {
    throw new Error(`app-identity：appId 必须是字符串，实际是 ${value === null ? 'null' : typeof value}`);
  }
  if (!value.trim()) throw new Error('app-identity：appId 不能为空字符串');
  if (value !== value.trim()) throw new Error(`app-identity：appId 前后不能有空白字符（收到 ${JSON.stringify(value)}）`);
  if (value.length > APP_ID_MAX_LEN) {
    throw new Error(`app-identity：appId 超过 Windows AUMID 上限 ${APP_ID_MAX_LEN}（实际 ${value.length}）：${value}`);
  }
  if (!APP_ID_FORMAT.test(value)) {
    throw new Error(`app-identity：appId 不符合反向域名格式（只允许小写字母/数字/短横，点分隔，至少两段）：${JSON.stringify(value)}`);
  }
  return value;
}

// 模块加载即自检：常量写错时让 require 直接失败（失败可见 > 静默无 AUMID）。
assertAppId(DSH_APP_ID);

module.exports = {
  /** 规范常量名（构建门禁按这个名字识别）。 */
  DSH_APP_ID,
  /** 短别名，方便调用方按习惯取用（与 DSH_APP_ID 同一个值）。 */
  APP_ID,
  /** 小写别名（同上，不是第二处字面量）。 */
  appId: DSH_APP_ID,
  APP_ID_MAX_LEN,
  assertAppId
};
