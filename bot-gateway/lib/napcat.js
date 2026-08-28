/**
 * @file lib/napcat.js
 * @description NapCat WebUI API 客户端，负责登录凭证管理（Credential 1小时有效，401重登）、
 *              二维码获取与验证、快速登录功能。
 */

import { createLogger, fetchJson } from './util.js?v=10';

export class NapCatClient {
  /**
   * @param {object} options
   * @param {string} options.url - NapCat WebUI 基础 URL（例如 http://127.0.0.1:6099）
   * @param {string} options.token - NapCat WebUI Token
   */
  constructor({ url, token }) {
    this.baseUrl = (url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.log = createLogger('napcat');
    this.credential = null;
    this.credentialExpiresAt = 0;
  }

  get isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * 登录获取 WebUI Credential
   */
  async login() {
    if (!this.isConfigured) {
      throw new Error('NapCat WebUI 未配置 url 或 token');
    }

    const res = await fetchJson(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token }),
      timeout: 5000,
      retries: 1,
    });

    // 兼容 { code: 0, data: { Credential } } 或 { data: { Credential } } 或 { Credential }
    const cred = res?.data?.Credential || res?.Credential || res?.data?.credential || res?.credential;
    if (!cred) {
      throw new Error(`NapCat 登录响应缺少 Credential: ${JSON.stringify(res)}`);
    }

    this.credential = cred;
    // 设置 50 分钟后过期（提前 10 分钟刷新）
    this.credentialExpiresAt = Date.now() + 50 * 60 * 1000;
    this.log.info('NapCat WebUI 登录成功');
    return cred;
  }

  /**
   * 确保 Credential 有效，如果 401 则重试登录
   */
  async ensureCredential() {
    if (!this.credential || Date.now() >= this.credentialExpiresAt) {
      await this.login();
    }
    return this.credential;
  }

  /**
   * 带 Credential 的通用 API 请求
   */
  async request(path, body = {}) {
    if (!this.isConfigured) return null;

    let cred = await this.ensureCredential();
    const url = `${this.baseUrl}${path}`;

    try {
      return await fetchJson(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cred}`,
        },
        body: JSON.stringify(body),
        timeout: 8000,
        retries: 1,
      });
    } catch (err) {
      // 401 错误重试一次登录
      if (err.status === 401) {
        this.log.warn('NapCat 凭证 401，尝试重新登录...');
        cred = await this.login();
        return await fetchJson(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cred}`,
          },
          body: JSON.stringify(body),
          timeout: 8000,
          retries: 0,
        });
      }
      throw err;
    }
  }

  /**
   * 获取登录二维码 URL
   * @returns {Promise<{ qrcodeUrl: string } | null>}
   */
  async GetQQLoginQrcode() {
    const res = await this.request('/api/QQLogin/GetQQLoginQrcode');
    const qrcode = res?.data?.qrcode || res?.qrcode || res?.data?.url;
    return qrcode ? { qrcodeUrl: qrcode } : null;
  }

  /**
   * 检查登录状态
   * @returns {Promise<{ isLogin: boolean, qrcodeurl?: string, uin?: string }>}
   */
  async CheckLoginStatus() {
    const res = await this.request('/api/QQLogin/CheckLoginStatus');
    const data = res?.data || res || {};
    return {
      isLogin: Boolean(data.isLogin || data.login),
      qrcodeurl: data.qrcodeurl || data.qrcode,
      uin: data.uin ? String(data.uin) : undefined,
    };
  }

  /**
   * 获取快速登录账号列表
   * @returns {Promise<Array<{ uin: string, nickName?: string }>>}
   */
  async GetQuickLoginList() {
    const res = await this.request('/api/QQLogin/GetQuickLoginList');
    const list = res?.data || res || [];
    return Array.isArray(list) ? list.map((item) => ({
      uin: String(item.uin || item.qq || ''),
      nickName: item.nickName || item.nickname || '',
    })) : [];
  }

  /**
   * 设置快速登录
   * @param {string|number} uin 
   */
  async SetQuickLogin(uin) {
    return await this.request('/api/QQLogin/SetQuickLogin', { uin: String(uin) });
  }
}
