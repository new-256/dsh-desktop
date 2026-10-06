# lab/ — 研究产物归档区

> 建立：2026-10-07 · 用途：存放桌面壳仓库中的**实验脚本与中间产物**，避免污染主仓根目录。

这些文件不属于 `dsh-desktop`（Electron 桌面壳）的产品代码，但保留有参考价值，故归入本目录而非删除。

| 子目录 | 内容 | 说明 |
|---|---|---|
| `comfyui-scripts/` | 14 个 Python 脚本 | ComfyUI / GGUF / 量化模型的调试与探测脚本（bench、probe、measure、inspect 等） |
| `workflows/` | 7 个 JSON | ComfyUI 工作流（Wan 5B / i2v / Qwen edit / img2img） |
| `notes/` | 3 个 Markdown | ComfyUI 模型指南、插件修复判责报告、配置手册 |
| （根） | 3 个 JS | `test-038.js`、`test-039.js`、`test-manifest-verify.js`（清单校验测试） |

**约定**
- 新增实验产物请直接放入对应子目录，不要放在仓库根。
- `lab/` 内容不参与构建与发布流程。
- 如某脚本演化为正式工具，应移出 `lab/` 并补充测试。

相关治理记录见 [DSH插件开发/PROJECT-CONTROL.md](../../DSH插件开发/PROJECT-CONTROL.md)。