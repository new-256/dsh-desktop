// web-search-panel — no-op host entry.
//
// 真正的 host 逻辑在同目录的 lib/index.mjs，经家级 cordis.patch.yml 的
// file://...lib/index.mjs?v=N 行加载（bot-gateway 模式）。本文件是包的
// main/exports["."] 占位：裸包名行（web-search-client）激活本包只为把
// lib/client.js 纳入浏览器花名册，不能让 host 半边被两个行名加载成两份
// 实例（否则 settings namespace 重名注册会直接失败）。
export const name = 'web-search-panel-entry'
export const inject = []

export function apply(_ctx) {
  return () => {}
}
