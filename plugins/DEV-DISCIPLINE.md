# 开发纪律：开发-制品闭环（DEV DISCIPLINE）

> 制度化于 2026-09-12 —— 由 agy-first-bridge 仓库迁移断链事故确立（姊妹仓
> `agy-first-bridge\docs\DEV-DISCIPLINE.md` 有完整事故记录）。
> 本纪律适用于本机**所有 DSH 插件**的开发与部署，本目录（Desktop\DSH\plugins）各插件同等遵守。

## 闭环流程（每版必走，缺一环不算完成）

```
开发 → 测试 → 提交仓库 → 发版（npm publish / 打 tgz 制品 + tag）
     → 卸载本地开发态接线
     → 从制品源安装（registry / 固定 tgz）
     → 测试（含需要重启的运行时验证）
     → 对比一致性（已安装 ≡ 发布制品）
     → 闭环备案（写入交接/README 并提交）
     → 等待下一次修订
```

## 七条纪律

1. **交付即制品**：版本发布并验证通过后，本机部署必须切换到**制品形态**（registry 安装或固定 tgz）。禁止让 junction / `file:` 目录依赖直连源码目录的开发态接线跨会话存活。
2. **开发态是临时的**：开发态接线（junction 直连源码 + `patchReload: live`）仅限活跃开发会话内使用；会话收尾时必须拆除，或在交接文档中显式标注「当前为开发态 + 接线位置」。
3. **路径解耦**：部署配置（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`）中禁止出现指向**易变路径**（桌面、用户目录、可迁移的仓库位置）的引用。一律使用 registry 包名或长期稳定路径；确需本地 tgz 引用，把 tgz 视为制品并放在稳定位置（不要依赖 `Desktop\` 下的源码树位置）。
4. **完整性校验**：从制品源安装必须校验完整性（tgz SHA512 对照 registry 元数据 / 源 tarball 哈希）。
5. **一致性核验**：安装后对比「已安装文件 vs 发布制品」（清单 + 内容哈希，行尾归一化后比对）；任何差异必须逐项归因。
6. **交接文档反映真实形态**：文档必须记录**当前真实部署形态**（制品态还是开发态）、版本、验证方法；「待重启验证」的变更要写明验证步骤。
7. **闭环备案**：闭环执行记录（备份、校验值、结论、提交号）写入文档并提交。

## 本目录插件的本机部署形态普查（2026-09-12 实测）

| 插件 | 本机部署形态 | 纪律评价 |
| --- | --- | --- |
| `web-search`（→ npm `web-search-panel@1.2.0`） | registry 安装 | ✅ 制品态标杆 |
| `comfyui-bridge`（→ npm `dsh-comfyui-bridge@^1.0.0`） | registry 安装（源码已从本目录移除） | ✅ 制品态（毕业闭环） |
| `dsh-pet-fixed`（→ `@captain1275/dsh-pet` file: tgz） | tgz 制品，但路径耦合 `Desktop\DSH\plugins\` | ⚠️ 制品态但违反路径解耦（纪律 3） |
| `bot-gateway`（→ `dsh-bot-gateway@0.2.0-beta` 本地 tgz） | tgz 制品 | ⚠️ 制品态，注意 tgz 存放位置稳定性 |
| `dsh-plugin-manager`（→ junction `profiles\node_modules\dsh-plugin-manager-plus`） | **junction 直连本源码目录** | ❌ 开发态接线（纪律 1/2）：仓库迁移即断，需转制品或显式标注 |
| `mobile-companion`（→ `dsh-home\node_modules\dsh-mobile-companion`） | 目录拷贝安装 | ⚠️ 拷贝与源码可能漂移，更新时按闭环流程重装并核验 |
| `agentrouter-proxy` / `session-cleaner`（单文件 + `?v=N`） | 复制到 `dsh-home\` 根 + 缓存破坏参数 | ⚠️ 源码正本（`plugins\web\`）与部署副本需同步；**每次改动必须 bump `?v=N` 并重启验证**。2026-09-12 纪律审计发现部署副本长期领先正本（session-cleaner +1087/-192、agentrouter +221/-42），已回同步归位 |

## 事故背景

2026-09-12：`agy-first-bridge` v1.6.2 发布后，本机 profile 层保留 junction 直连仓库工作副本。
仓库目录迁移 → junction 悬空 → 状态灯 bundle 静默失效；宿主层（绝对路径）与 preset 层
（自包含拷贝）幸存。排查 + 闭环修复耗时远超开发本身。

**教训：开发态接线是有保质期的债——发布之日就是还债之时。**
