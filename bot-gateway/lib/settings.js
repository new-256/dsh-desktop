/**
 * @file lib/settings.js
 * @description 设置存储管理模块 (SettingsStore)。
 *              支持 settings.json 的读取、深合并与原子写盘 (tmp+rename)。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, resolveBotGatewayPath } from './util.js?v=10';

/**
 * 判断是否为纯 Object 对象
 */
function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val) && (val.constructor === Object || !val.constructor);
}

/**
 * 递归深合并（Plain Object 递归，数组与原始值覆盖）
 * @param {object} target 
 * @param {object} source 
 * @returns {object} 合并后的新对象
 */
export function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = target[key];
    if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = deepMerge(tVal, sVal);
    } else if (sVal !== undefined) {
      result[key] = sVal;
    }
  }
  return result;
}

export class SettingsStore {
  /**
   * @param {object} [options={}]
   * @param {string} [options.settingsPath] - settings.json 保存路径 (空 = <dsh-home>/bot-gateway/settings.json)
   */
  constructor(options = {}) {
    this.log = createLogger('settings');
    this.settingsPath = resolveBotGatewayPath(options.settingsPath, 'settings.json');
    this.currentSettings = {};
  }

  /**
   * 从磁盘读取并解析 settings.json
   * @returns {Promise<object>} 当前设置数据
   */
  async load() {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = await readFile(this.settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed)) {
          this.currentSettings = parsed;
          this.log.info(`已成功载入设置文件: ${this.settingsPath}`);
          return this.currentSettings;
        }
      }
    } catch (e) {
      this.log.warn(`载入 settings.json 异常 (${e.message})，使用空设置`);
    }
    this.currentSettings = {};
    return this.currentSettings;
  }

  /**
   * 保存增量/部分设置（深合并后原子写入 tmp + rename）
   * @param {object} partial 
   * @returns {Promise<object>} 更新后的完整设置
   */
  async save(partial) {
    if (!isPlainObject(partial)) return this.currentSettings;

    this.currentSettings = deepMerge(this.currentSettings, partial);

    try {
      const dir = dirname(this.settingsPath);
      await mkdir(dir, { recursive: true });

      const tmpPath = `${this.settingsPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      const content = JSON.stringify(this.currentSettings, null, 2);

      await writeFile(tmpPath, content, 'utf8');
      await rename(tmpPath, this.settingsPath);
      this.log.info(`设置已成功原子写盘: ${this.settingsPath}`);
    } catch (e) {
      this.log.error(`保存 settings.json 失败:`, e);
      throw e;
    }

    return this.currentSettings;
  }

  /**
   * 获取当前已加载/内存中的 settings
   * @returns {object}
   */
  getSettings() {
    return JSON.parse(JSON.stringify(this.currentSettings));
  }
}
