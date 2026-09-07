# comfyui-bridge 插件文档

`comfyui-bridge` 是 DSH（DeepSeek Harness）的家级 Host 侧插件，让 DSH 在任何会话、任何智能体预设（Preset）下均能通过模型工具**直接控制本地或局域网内的 ComfyUI**，实现全自动的图像与视频生成。

---

## 1. 功能特性

- **文生图与图生图（txt2img / img2img）**：支持 SD 1.5、SDXL、Flux 等主流 Checkpoint 模型，自动识别模型特征并自适应输出分辨率与采样配置。
- **高质量视频生成**：
  - **Wan2.1（万象）**：支持文生视频（`wan_t2v`）与图生视频（`wan_i2v`），自动处理 ModelSamplingSD3 移位与分辨率启发。
  - **SVD（Stable Video Diffusion）**：支持图生视频（`svd_img2vid`），参数可调。
  - **AnimateDiff**：支持动态图像与短视频生成（`animatediff`）。
- **自适应视频保存尾（Adaptive Saver Tail）**：实时探测 ComfyUI 环境所支持的节点，自动按优先级选择 `SaveVideo`（官方核心视频）→ `SaveAnimatedWEBM` → `SaveAnimatedPNG`，兼容不同版本 ComfyUI。
- **模型自动获取与断点续传（Model Fetch）**：内置 14 款主流模型（Wan2.2、Wan2.1、MiniMax H3 等）权重注册表，严格遵循用户现有模型库结构存放；具备全库查重、单连接顺序断点续传与字节级精准校验能力；支持在生成缺少模型时一键或自动补齐。
- **环境与模型库自适应发现与自动安装器**：无需手动寻找路径，首次运行自动通过进程与全盘扫描发现已有 ComfyUI 安装与模型库；若完全未安装 ComfyUI，自动执行硬件达标评估并支持一键在非 C 盘安装官方便携版。
- **自定义工作流支持（Workflow 逃生舱模式）**：可直接提交任意 API 格式的 ComfyUI 工作流 JSON，并支持通过 `overrides` 动态覆写参数。
- **产物全自动下载与管理**：生成结果通过 `/view` API 自动下载至 DSH 工作区目录，模型可通过 `read_image` 预览，并在回答中向用户直接引用。
- **智能预校验与容错自愈**：
  - 构图提交前自动校验所有节点类型与枚举值合法性；
  - 遇到未知节点名称时自动计算编辑距离并给出最相似建议；
  - API 路径兼容性探测（优先直连根路径，遇 404 自动回退并记住 `/api` 前缀）。

---

## 2. 安装与挂载

本插件是标准 npm 包（`dsh-comfyui-bridge`），按 DSH 插件规范声明了 bundle（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），安装后**自动挂载，无需手写补丁行**。三种方式按需选一：

### 方式 A：npm 注册表安装（推荐，发布后可用）

```powershell
dsh plugin --profile web add dsh-comfyui-bridge
```

安装后重启 DSH Desktop 即生效。升级：`dsh plugin --profile web add dsh-comfyui-bridge@latest`。

### 方式 B：本地路径安装（未发布 / 从源码）

```powershell
dsh plugin --profile web add C:\path\to\dsh-comfyui-bridge
```

同 A 一样走官方 bundle 流程（dsh CLI 转发 pnpm 安装进 profile，并自动把包登记进 `profiles/web/package.json` 的 `dsh.profile.bundles`）。

### 方式 C：junction 直连（本机开发，源码改动即时生效）

```powershell
pwsh -File install.ps1
```

脚本幂等创建三处 junction（`dsh-home\node_modules`、`profiles\node_modules`、`profiles\web\node_modules`），然后在家级补丁层确认/提示补一行**裸包名行**：

```yaml
- insert:
    - id: comfyui-bridge
      name: dsh-comfyui-bridge        # ← 裸包名，靠 junction 解析；不再用 file:// 路径
      config:
        baseUrl: http://127.0.0.1:8188
        outputsDir: comfyui-outputs
        defaultTimeoutSec: 1800
        pollIntervalMs: 2000
        # 可选：显式指定模型库根目录（缺省自动发现）
        # modelsDir: D:/ComfyUI/ComfyUI-aki-v3/ComfyUI/models
```

### 配置覆盖规则与热更新

- **bundle 层自动行**（包内 `cordis.patch.yml`）只带通用默认值；**用户层**（`dsh-home/cordis.patch.yml`）同 id 行后应用，`config` **整体覆盖** bundle 默认 — 机器特定配置（`modelsDir` 等）写在用户层。
- `modelsDir` 支持全自动发现（优先扫描运行进程，兜底全盘扫描与 `extra_model_paths.yaml`），一般无需手填。
- 修改配置（如 `baseUrl`）保存即热生效；改插件源码后：方式 A/B 重新 `add` 一次刷新，方式 C 因 junction 直连源码目录，改完把用户层行的 `name` 加/改 `?v=N` 版本号（如 `dsh-comfyui-bridge?v=2`）触发热重载，或重启 DSH。

> ⚠️ 历史挂载迁移：旧式 `name: file:///...lib/index.mjs?v=N` 行与本包行同 id（`comfyui-bridge`），两者不可同时存在 — 迁移到 npm/bundle 形态时，把旧行整体替换为上面的裸包名行即可。
---

## 3. 配置项说明

在 `cordis.patch.yml` 中支持配置以下字段：

| 配置字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8188` | ComfyUI 服务的 HTTP 地址（末尾斜杠会自动剔除） |
| `modelsDir` | string | `""`（可选，缺省自动发现） | ComfyUI 模型库根目录（缺省自动通过：运行进程扫描 → 全盘 ComfyUI 扫描 → extra_model_paths.yaml 多级发现）；用于 comfyui_fetch_model 目标存放及全库查重 |
| `headers` | object | `{}` | 附加的 HTTP 请求头（如反向代理 Basic Auth 等） |
| `outputsDir` | string | `comfyui-outputs` | 产物保存根目录。相对路径将解析到 DSH 工作区根目录 |
| `workspaceRoot` | string | 自动推断 | 产物落盘的工作区根(绝对路径)。缺省时按优先级自动解析:显式配置 > 会话作用域 sandboxPolicy 服务 > **最近活跃会话反推**(读 `dsh-home/sessions/*/*/session.jsonl.zstd` 首行 session 头的 cwd,Node ≥22.15 内置 zstd) > 后端进程 cwd(最后兜底,一般到不了这层)。插件挂载在 host 根作用域看不到会话服务,反推链路是产物正确落入"当前会话工作区"的关键 |

### Z-Image 系 checkpoint 原生支持

`txt2img` / `img2img` 预设会**读取 checkpoint 的 safetensors 文件头**自动识别拓扑:检测到 DiT-only(不内嵌 CLIP/VAE,如 zImageTurbo、beyondREALITY 等 Z-Image 系)时,自动外挂 `CLIPLoader`(Qwen3-4B 编码器,按张量自动识别为 Z-Image TE)+ `VAELoader`(ae),并把默认参数切到 Turbo 甜点(10 步 / cfg 1 / euler+simple)。缺件时返回结构化 `MODEL_MISSING`,提示 `qwen_3_4b_fp8_mixed.safetensors` / `ae.safetensors`(均已入已知模型注册表,`auto_fetch_models: true` 可自动补齐,连环缺件最多自动补 3 件)。
| `requestTimeoutMs` | number | `30000` | 单次 HTTP 请求超时时间（毫秒） |
| `pollIntervalMs` | number | `2000` | 轮询等待生成完成的时间间隔（毫秒） |
| `defaultTimeoutSec` | number | `1800` | 生成任务的默认等待超时上限（秒） |
| `maxTimeoutSec` | number | `3600` | 生成任务允许设定的最大超时硬上限（秒） |
| `clientIdPrefix` | string | `dsh` | 提交给 ComfyUI 的 `client_id` 前缀 |

---

## 4. 模型工具详解与使用示例

插件为模型注册了 8 个全局工具，全部入参采用 `snake_case` 规范：

### 4.1 `comfyui_status`
检查 ComfyUI 服务器运行状态、版本、GPU 显存占用及当前队列。
- **参数**：无必填参数。
- **示例输出**：
  ```
  ComfyUI 状态: 正常运行 (http://127.0.0.1:8188)
  版本: 0.3.10 | ComfyUI 运行时间: 3600s
  计算设备 / 显卡:
  · NVIDIA GeForce RTX 4090 (cuda:0): 显存剩余 19.50 GB / 23.99 GB
  任务队列: 运行中 0 个，等待中 0 个
  ```

### 4.2 `comfyui_models`
枚举当前 ComfyUI 中可用的模型文件，并探测当前环境的视频生成能力。
- **参数**：
  - `folder`（可选，枚举：`checkpoints`、`vaes`、`loras`、`unets`、`upscalers`、`clip`、`all`，默认 `all`）。
- **示例**：
  ```json
  { "folder": "checkpoints" }
  ```

### 4.3 `comfyui_generate`（核心生成工具）
执行生图或生视频任务，支持预设模板与自定义工作流。

#### 核心参数列表：
- `mode`：`preset`（默认）或 `workflow`。
- `preset`：预设名称，支持：
  - `txt2img`：文生图
  - `img2img`：图生图
  - `wan_t2v`：Wan2.1 文生视频
  - `wan_i2v`：Wan2.1 图生视频
  - `svd_img2vid`：SVD 图生视频
  - `animatediff`：AnimateDiff 动画生成
  - `h3_t2v` / `h3_flf2v` / `h3_r2v`：MiniMax H3 本地开源权重生视频（带原生音频，需较新 ComfyUI 核心，详见第 6 节）
- `prompt`：正向提示词。
- `negative_prompt`：负向提示词（可选）。
- `image`：输入图片路径（`img2img`、`wan_i2v`、`svd_img2vid`、`h3_flf2v`、`h3_r2v` 必填，支持绝对路径或相对工作区路径，插件会自动上传）。
- `end_image`：尾帧图（仅 `h3_flf2v`，可选）。
- `duration_sec`：视频时长秒数（仅 H3 预设，默认 5，自动对齐到 17k+5 帧@24fps）。
- `turbo`：H3 加速模式（检测到 turbo LoRA 时默认开启，6 步出片）。
- `ref_image_size`：H3 参考图规格（`match`/`max`，默认 `match`）。
- `text_encoder`：H3 专用，显式指定 text_encoders 目录中的编码器文件名（缺省自动选择；可换社区 abliterated/其他量化变体，见 §6.5）。
- `text_encoder_device`：H3 专用，`default`/`cpu`（`cpu` 把 14.6GB 编码器钉在内存跑，显存全留给 DiT，见 §6.5）。
- `model`：指定模型名称（缺省时插件自动优选）。
- `lora`：LoRA 注入（`txt2img` / `img2img` / `wan22_ti2v` 预设）。接受 `"文件名"`、`"文件名@权重"`（如 `kuroinu_pony_chloe.safetensors@0.8`）、`{name, strength}` 对象或其数组（多 LoRA 链式叠加）。图预设走 `LoraLoader`（模型+CLIP，默认权重 0.8），`wan22_ti2v` 走 `LoraLoaderModelOnly`（仅模型，默认 0.7）；文件缺失时抛含文件名的错误（注册表内的 LoRA 可被 `auto_fetch_models` 自动补齐）。
- `steps` / `cfg` / `sampler` / `scheduler` / `seed`：采样控制参数。
- `denoise`：重绘幅度（`img2img` 默认 0.65，其余默认为 1.0）。
- `length`：视频帧数（Wan 默认 81，SVD 默认 25，AnimateDiff 默认 16）。
- `fps`：视频帧率（Wan 默认 16，SVD 默认 8）。
- `workflow`：自定义工作流（`mode=workflow` 必填，支持对象或合法 JSON 字符串）。
- `overrides`：参数覆写字典，形如 `{"5": {"steps": 30}}`。
- `wait`：是否同步等待生成完成并下载（默认 `true`；若为 `false`，则立刻返回 `prompt_id`）。
- `auto_fetch_models`：布尔值（默认 `false`）。预设构图时若检测到缺少所需模型：
  - 为 `false` 时返回结构化错误 `{ ok: false, status: 'MODEL_MISSING', missingModel, suggestion, autoFetchSupported: true }`；
  - 为 `true` 时自动从多镜像源下载缺失模型至对应的规范子目录，并在下载完成后自动重新获取对象元数据继续构图出片。注意：若设备能力守卫判断硬件不足（`blocked`），将优先拦截，绝不盲目触发大模型下载。
- `timeout_sec`：任务超时时间（秒）。

#### 示例 1：文生图（txt2img）
```json
{
  "mode": "preset",
  "preset": "txt2img",
  "prompt": "masterpiece, best quality, a cyberpunk cat wearing goggles, neon lights, 8k resolution"
}
```

#### 示例 2：图生视频（wan_i2v）
```json
{
  "mode": "preset",
  "preset": "wan_i2v",
  "prompt": "gentle wind blowing, cinematic lighting, ultra realistic",
  "image": "inputs/portrait.png",
  "length": 81,
  "fps": 16
}
```

#### 示例 3：异步提交长视频任务（wait=false）
```json
{
  "mode": "preset",
  "preset": "wan_t2v",
  "prompt": "epic sea battle with tall ships",
  "wait": false
}
```
返回结果中将包含 `prompt_id`。可在稍后使用 `comfyui_history` 工具收取生成好的视频。

### 4.4 `comfyui_history`
查询历史记录或对指定任务断点下载产物。
- **参数**：
  - `prompt_id`（可选）：指定任务 ID；如果为空则列出最近历史任务。
  - `max_items`（可选）：列表模式最大条数，默认 5。
  - `download`（可选）：指定 `prompt_id` 时是否下载产物到本地，默认 `true`。

### 4.5 `comfyui_interrupt`
中断当前 ComfyUI 中正在执行的任务。参数：`free`（同时卸载模型释放显存）、`clear_queue`（同时清空待处理队列，`POST /queue` clear，返回 `queueCleared` 与 `pendingCleared` 个数）。
- **参数**：
  - `free`（可选）：是否同时调用 `/free` 释放显存并卸载缓存模型（默认 `false`）。

### 4.6 `comfyui_upload`
手动将本地图片或文件上传到 ComfyUI 的输入目录。
- **参数**：
  - `path`（必填）：本地文件路径（绝对或相对工作区）。
  - `name`（可选）：指定 ComfyUI 侧保存的文件名。
  - `overwrite`（可选）：是否覆盖同名文件（默认 `true`）。

### 4.7 `comfyui_fetch_model`
从官方/社区镜像源下载特定模型，或通过自定义 URL 下载权重至用户的 ComfyUI 模型库中。

> 模型获取架构参照了开源的 [Stability Matrix](https://github.com/LykosAI/StabilityMatrix)（Lykos AI）：其做法是"静态精选目录（`hf-packages.json`，130 条 repo+files+license）+ HuggingFace 实时 API 浏览 + 文件名关键词级联推断落盘目录 + CivitAI 公共 REST/用户令牌下载（NSFW 走 `civitai.red` 镜像域）+ 本地文件 SHA256 反查识别（`/api/v1/model-versions/by-hash/{hash}`）+ HTTP Range 断点续传"。本插件移植了其中对我们最有价值的两件：关键词级联目录推断与 HF 链接归一化；静态注册表 + 断点续传 + 字节校验为我们原有的对应实现。

#### 设计原则
- **尊重用户模型库结构**：下载目的地固定为配置项 `modelsDir`（或环境变量 `COMFYUI_MODELS_DIR`）下的规范子目录（`diffusion_models` / `text_encoders` / `vae` / `loras` / `checkpoints` / `clip` / `clip_vision` / `unet`），绝不另立目录、绝不散落别处。若未配置 `modelsDir`，工具将返回明确的指引提示。
- **全库查重（已有即跳过）**：下载前先在目标子目录下检查同名文件；若未找到，还会全库扫描所有标准模型子目录匹配 basename。只要找到且大小完整，即刻报告已存在并直接跳过，绝不重复下载或占用磁盘。
- **单连接顺序断点续传 + 字节精确校验**：针对主流 CDN（如 HuggingFace / hf-mirror / ModelScope）拒绝高并发连接的特性，采用单连接逐源尝试机制；已有部分文件时自动发送 HTTP `Range: bytes=<cur>-` 续传；下载完成后严格比对注册表实测精确字节数。若校验失败则保留已下数据供后续继续断点续传。

#### 两种运行模式与参数：

**模式 A：已知模型注册表模式（推荐）**
- **参数**：`model`（必填）。
  - 支持 14 款主流模型简称或精确文件名：
    - Wan2.2 体系：`wan2.2_ti2v_5b`（5B DiT）、`wan2.2_vae`（高压缩 VAE）
    - Wan2.1 体系：`wan2.1_t2v_1.3b`、`wan2.1_i2v_480p_1.3b`、`wan2.1_t2v_14b`、`wan2.1_i2v_720p_14b`、`umt5_xxl`、`wan2.1_vae`
    - MiniMax H3 体系：`minimax_h3_fl2va_int8`、`minimax_h3_ref2va_int8`、`qwen3vl_32b_nvfp4`（编码器）、`minimax_h3_video_vae`、`minimax_h3_audio_vae`、`minimax_h3_turbo_lora`
  - 自动路由到规范子目录，按顺序尝试多个国内/海外镜像源。
- **示例**：
  ```json
  {
    "model": "wan2.2_ti2v_5b"
  }
  ```

**模式 B：自定义 URL 模式**
- **参数**：
  - `url`（必填）：模型文件直链地址。支持三种 HuggingFace 简写（自动转为 hf-mirror 国内直链）：
    - `hf:Owner/Repo/仓库内文件路径`（如 `hf:Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors`）
    - `huggingface.co/{repo}/blob/main/{file}` 网页链接
    - `huggingface.co/{repo}/resolve/main/{file}` 原始直链
    - CivitAI 提示：NSFW 模型用 `civitai.red` 域名（Stability Matrix 同款做法），部分下载需登录 token。
  - `filename`（必填）：保存的文件名（如 `my_lora.safetensors`）。
  - `subfolder`（可选）：存放子目录。**缺省时自动按文件名/来源路径推断**（移植自 Stability Matrix 的关键词级联：`clip_vision` → `controlnet` → `ip-adapter` → 文本编码器（`clip_`/`t5`/`umt5`/`qwen` 等前缀）→ `vae`（含 `ae.` 前缀）→ `lora` → `embeddings` → `upscale_models`（`upscal`/`esrgan`/`ultrasharp` 等）→ DiT（`.gguf`/`unet`/`diffusion_model`）→ 兜底 `checkpoints`）。注意：文件名含 `vae` 字样的 checkpoint（如 `sd_xl_base_1.0_0.9vae`）会被误判为 `vae`，此类请显式传 `subfolder`。
  - `expected_bytes`（可选）：预期字节数，提供后将在完成后自动严格比对。
- **示例**：
  ```json
  {
    "url": "https://hf-mirror.com/.../custom_lora.safetensors",
    "filename": "custom_lora.safetensors",
    "subfolder": "loras"
  }
### 4.8 `comfyui_install`
一键自动下载并安装官方纯净版 ComfyUI 便携版（Portable）。
- **参数**：
  - `confirm`（必填，布尔值）：必须显式传入 `true` 才会执行安装。**调用前须向用户说明并征得明确同意**。
  - `target_drive`（可选，字符串）：指定安装盘符（如 `"D:"` 或 `"E:"`）。**严格禁止安装至 C 盘**；缺省时自动选择剩余空间最大的非 C 盘。
  - `timeout_sec`（可选，整数）：安装包下载与解压总超时上限（秒），默认 3600。
- **自动化流程**：
  1. **严格预检**：检查 NVIDIA GPU、显存（≥8GB）、系统内存（≥16GB）与非 C 盘空闲容量（≥50GB）；
  2. **驱动自适应**：根据 `nvidia-smi` 驱动版本自动匹配官方 CUDA 运行时版本（≥560 采用标准版，525~559 采用 cu126 变体）；
  3. **便携部署**：在目标盘根目录（如 `D:\ComfyUI`）解包部署，杜绝深层嵌套，方便用户查找与管理；
  4. **快捷启动**：自动在根目录创建 `启动ComfyUI.bat`，并生成桌面快捷方式 `ComfyUI.lnk`。

---

## 5. 常见问题与排查指南

### 5.1 ComfyUI 连接失败新引导流程（`reachable: false` 智能自愈）
当 ComfyUI 服务未启动时，调用 `comfyui_status` 会自动触发**本地安装检测与硬件达标评估**，返回结构化诊断：
- **场景 A：本地已安装过 ComfyUI**（如已有秋叶整合包或官方版，但未启动）
  - 插件会自动通过全盘扫描定位其路径，并在返回信息中直接提供专属启动命令（如 `运行 D:\ComfyUI-aki-v3\ComfyUI\run_nvidia_gpu.bat` 或启动器 exe）。用户只需按照指引双击启动即可，服务就绪后插件自动对接并识别模型库。
- **场景 B：本地从未安装 ComfyUI 且硬件达标**
  - 插件返回 `suggestedAction: "offer_install"`，列出当前 GPU、显存与推荐安装盘符，提示可通过 `comfyui_install` 工具一键完成安装。
- **场景 C：硬件未达标**
  - 插件明确列出未达标瓶颈（如无 NVIDIA 独立显卡、显存不足等），直言建议升级配置或选用云端服务。

### 5.2 节点缺失错误（`MISSING_NODES`）
- **现象**：提示 `预设 "xxx" 所需的核心节点类缺失: [...]`。
- **排查**：
  1. **Wan2.1 预设**（`wan_t2v`/`wan_i2v`）使用的是 ComfyUI **核心自带**的 Wan 原生节点（`nodes_wan.py`，含 `WanImageToVideo`），无需安装任何扩展；报缺失说明 ComfyUI 版本过旧，请把核心更新到较新版本；
  2. **SVD 预设**依赖核心的 `ImageOnlyCheckpointLoader` / `SVD_img2vid_Conditioning`（同样为自带节点）；
  3. **AnimateDiff 预设**需安装 `ComfyUI-AnimateDiff-Evolved` 自定义节点包；
  4. **MiniMax H3 预设**需把 ComfyUI 核心更新到包含 `comfy_extras/nodes_minimax_h3.py` 的版本（见第 6 节）。

### 5.3 缺少视频保存尾节点
- **现象**：提示 `ComfyUI 未安装适用的视频保存节点`。
- **排查**：
  1. 请将 ComfyUI 更新至最新版以获得官方核心 `SaveVideo` 节点；
  2. 或安装社区通用的 `ComfyUI-VideoHelperSuite` (VHS) 扩展包。

### 5.4 显存不足（CUDA Out of Memory）
- **现象**：生成任务返回 `EXECUTION_ERROR`，回溯栈中出现 `torch.cuda.OutOfMemoryError`。
- **排查**：
  1. 调用 `comfyui_interrupt({ free: true })` 卸载常驻模型释放显存；
  2. 适当缩小输出尺寸（如将 1024 降至 768 或 512）或减少视频帧数 `length`；
  3. ComfyUI 启动时添加 `--lowvram` 或 `--fp8_e4m3fn` 参数。

---

## 6. MiniMax H3（海螺 3.0）本地生视频指南

[MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) 是 MiniMax（稀宇科技）2026-07-31 发布、08-03 开源权重的全模态视频生成模型：**33B 参数，文/图/视频/音频任意组合输入，输出自带 32kHz 立体声原生音频的视频**，最高 15 秒 / 2K / 24fps。在 Artificial Analysis 榜单上视频编辑第一、文生视频/图生视频均列前三。开源部分为 **H3-Base**（FL2VA 首尾帧 + Ref2VA 全能参考两个 checkpoint）；更高画质的 H3-Regenerate-2K 为托管 API 未开源。

### 6.1 前置条件：更新 ComfyUI 核心

H3 的本地节点（`MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` / `MiniMaxH3AddGuide` 等）位于较新版 ComfyUI 核心的 `comfy_extras/nodes_minimax_h3.py`。**秋叶整合包等较旧版本不含这些节点**，请先通过 ComfyUI-Manager 更新核心（或使用官方最新版/整合包）。注意区分：官方模板里的 `MinimaxHailuo03*` 一体化节点是**云端 API 节点**（走 MiniMax 官方 API、按量计费），本插件的 `h3_*` 预设走的是**本地开源权重**，无需 API Key。

### 6.2 模型下载（放对目录才会被自动识别）

> [!TIP]
> **一键自动获取**：如果本地缺少下列模型，无需手动下载与移动文件，可以直接使用插件提供的 `comfyui_fetch_model` 工具（例如 `comfyui_fetch_model({ model: "minimax_h3_fl2va_int8" })`）自动下载并校验放置于对应子目录中；或在调用 `comfyui_generate` 时传入 `auto_fetch_models: true` 自动按需补齐。

| 文件 | 放置目录 | 来源 |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `ComfyUI/models/diffusion_models/` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors)（国内用 [hf-mirror.com](https://hf-mirror.com/Comfy-Org/MiniMax-H3)） |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（r2v 用） | `ComfyUI/models/diffusion_models/` | 同上 |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`（文本编码器） | `ComfyUI/models/text_encoders/` | 同上 |
| `minimax_h3_video_vae_fp16.safetensors` | `ComfyUI/models/vae/` | 同上 |
| `minimax_h3_audio_vae_fp32.safetensors` | `ComfyUI/models/vae/` | 同上 |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`（turbo 加速 LoRA） | `ComfyUI/models/loras/` | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) |

**显存**：INT8 量化版社区实测 8GB 显存可跑。RTX 5060 Ti 16GB 建议 768P（短边 768，如 1344×768）起步，先小时长（3–5 秒）验证，再逐步上探；`turbo: true`（默认自动启用，检测到 LoRA 即开）8 步出片，速度提升数倍。

**各版本精确大小**（hf-mirror API 实测，GiB；fl2va 与 ref2va 同尺寸）：

| 组件 | 版本 | 大小 |
|---|---|---|
| DiT 33B | bf16 完整 | 61.73 GB |
| DiT 33B | int8_convrot 完整 | 31.70 GB |
| DiT 33B | pruned bf16 | 37.46 GB |
| DiT 33B | pruned fp8_scaled | 19.52 GB |
| **DiT 33B** | **pruned int8_convrot（16GB 卡推荐）** | **19.53 GB** |
| 编码器 Qwen3-VL-32B | bf16 | 47.97 GB |
| 编码器 Qwen3-VL-32B | int8_convrot | 25.28 GB |
| **编码器 Qwen3-VL-32B** | **nvfp4_awq（最小官方版）** | **14.61 GB** |
| 视频 VAE fp16 | — | 4.85 GB |
| 音频 VAE fp32 | — | 0.56 GB |
| turbo LoRA | 4/8 步（lightx2v） | 1.29–1.82 GB |

最小可行组合磁盘占用：**约 41.3 GB**（fl2va 19.53 + 编码器 14.61 + 双 VAE 5.41 + LoRA 1.82）；r2v 再加一份 19.53 GB DiT。运行内存峰值 ~36GB——32GB 机器会被插件设备守卫直言拦截（见 §8.2）。

### 6.3 三个 H3 预设

| 预设 | 用途 | 关键参数 |
|---|---|---|
| `h3_t2v` | 文生视频（带音频） | `prompt`、`duration_sec`（默认 5 秒，自动对齐 17k+5 帧@24fps）、`width`/`height`（默认 1344×768，自动取 32 倍数）、`turbo`、`steps`（turbo 默认 6，普通 20） |
| `h3_flf2v` | 首帧（±尾帧）生视频 | 额外：`image`（首帧，必填）、`end_image`（尾帧，可选） |
| `h3_r2v` | 参考图生视频（人物/风格一致性） | 额外：`image`（参考图，必填）、`ref_image_size`（`match`/`max`）；提示词用 `<Picture 1>` 指代参考图 |

**H3 提示词写法**（与 SD 系完全不同，按"分镜脚本"写）：先一句话总述场景（地点/人物/事件），再按秒拆分镜头（`Second 0–1: …`），镜头运动与音频（对白/音效/配乐）写在同一块里。示例见 `assets/api_minimax_h3_t2v.json` 里的官方 prompt。

### 6.4 示例

```json
{
  "preset": "h3_t2v",
  "prompt": "Single continuous shot, 5 seconds. Cinematic drone view, golden hour. A red vintage car drives along a coastal cliff road, waves crashing below. Second 0-2: camera glides alongside the car. Second 2-5: camera rises revealing the coastline. Audio: engine hum, seagulls, orchestral score swelling.",
  "duration_sec": 5
}
```

### 6.5 文本编码器答疑：能不能换更小的？

**结论：不能换"模型"，只能换"文件"。**

从 ComfyUI 源码（`comfy/text_encoders/minimax.py`）看，H3 的"文本编码器"并不是一个可插拔组件：它是**专门转换过的 Qwen3-VL-32B（截断至 50 层、去掉末层归一化和 lm_head）**，H3 的 DiT 直接消费它的原始隐状态（带逐 token 模态标签），而且**参考图/参考视频的视觉特征也走它的视觉塔**。换任何其他架构（更小的 Qwen、T5、CLIP……）都会让条件空间对不上，输出直接报废——这是训练决定的，不是加载器限制。

**体量对比**（同架构不同量化）：

| 文件 | 体量 | 说明 |
|---|---|---|
| `qwen3vl_32b_minimax_h3_nvfp4_awq` | **14.61GB** | 官方最小，文档默认推荐 |
| `qwen3vl_32b_minimax_h3_int8_convrot` | 25.28GB | 精度更高 |
| `qwen3vl_32b_minimax_h3_bf16` | 47.97GB | 全精度 |
| 社区 GGUF Q4_K_M（joeygambino/MiniMax-H3-encoder-GGUF） | 18.4GB + 1.1GB mmproj 边车 | **反而更大**，且需另装 ComfyUI-H3-Multishot 的 "H3 Clip Loader (Any)" 节点，不推荐 |

**体量问题的正确解法是加载策略**：文本编码器只在每次生成开头运行一次（编码提示词），随后 ComfyUI 自动把权重让位给 DiT（16GB 显存走流式加载，社区 8GB 卡都能跑）。想进一步省显存：生成时传 `text_encoder_device: "cpu"` 把编码器钉在 CPU（你有 32GB 内存足够，代价是每次编码慢一些）。传 `text_encoder: "<文件名>"` 可显式指定编码器文件——例如换社区 **abliterated（去审查）版**（如 `pottokao/MiniMax-H3-TextEncoder-Qwen3VL-32B-abliterated-NVFP4-AWQ`，同为 NVFP4 格式，普通 CLIPLoader 直接加载）——如果发现 H3 对某些提示词有净化/拒绝行为，可以实验这一路线（社区验证较少，效果自负）。

**如果磁盘是硬约束**：H3 全家桶（int8 DiT 19.5GB + 编码器 14.6GB + VAE 5.4GB）约 40GB 起步，这是它的固有门槛。要轻量视频请直接用 Wan2.1 1.3B fp8（四件套约 7GB，见 §7.2）。

### 6.6 耗时预估（RTX 5060 Ti 16GB 实测锚点推算）

以 pruned int8 DiT + nvfp4 编码器（本机推荐组合）、**预热后**为前提：

| 场景 | turbo 6–8 步 | 标准 20 步 |
|---|---|---|
| 720P（1344×768）5s（124 帧） | ~4–7 分钟 | ~12–18 分钟 |
| 720P 10s（250 帧） | ~12–18 分钟 | ~35–50 分钟 |
| **720P 15s（362 帧，训练上限）** | **~30–45 分钟** | **~1.5–2 小时** |

- **首条另加 5–10 分钟**（Sage/Triton JIT 编译 + ~35GB 模型从磁盘载入）；同 seed 重跑会命中缓存秒回，不是真速度
- 实测锚点：4080 直出 720P 5s=14min、10s=42min（[B站实测](https://www.bilibili.com/video/BV1qmuJ65Exx/)，帧数开销超线性：5s→10s 时间×3）；5060Ti pruned 8步 480p=154s、4060Ti 优化链 1344×768 5s=360s（[neng320 实测指南](https://github.com/neng320/minimax-h3-local-deployment)）
- 提速叠加：turbo LoRA（插件默认开）→ SageAttention（官方文档方案，再省 ~20–25%，需在 UNETLoader 与 BasicGuider 之间手动插 `Patch Sage Attention KJ` 节点，或启动加 `--use-sage-attention`）→ "480p 抽卡、720P 成片"策略
- **本机风险点**：① 32GB 内存是官方最低门槛（实测满载 ~44GB，那是完整版 int8；**只用 pruned 20.9GB 版**，关掉大内存程序）；② 362 帧的 VAE 解码在 16GB 显存下易 OOM——先跑 5s/10s 验证，崩了就降时长或分辨率；③ int8_convrot 依赖 torch cu130+，**必须官方 ComfyUI v0.30.0+**（老整合包不行）；④ 20 步 15s 可能超过插件默认等待上限，用 `wait:false` 提交 + `comfyui_history` 收结果
- 许可证地域：开源协议排除美/欧/英/韩，中国大陆不受限

### 6.7 能否用在线 LLM 取代本地 Qwen3-VL-32B 编码器？

**结论：编码器本体换不了；但在线 LLM 可以在"提示词层"接管它的外围工作，这是正确且已验证的用法。**

**为什么换不了（架构硬约束）：**

- 文本编码器不是"翻译器"，而是**条件张量生产者**：它把提示词变成特定形状的隐状态序列，H3 的 DiT 在**每一个去噪步**都拿这些张量做交叉注意力。换任何别的模型（在线或本地），产出的张量就在另一个嵌入空间里，DiT 读到的等于乱码
- 在线 LLM API 只回**文本**（chat/JSON），不回这些张量；没有任何公开 API 提供"H3 版 Qwen3-VL 隐状态"的输出
- r2v（参考图生视频）更绑死：参考图是作为**视觉 token 喂进这个编码器**的，图像嵌入也是 DiT 训练时认的格式——外部模型给不了

**在线 LLM + skill 的正确分工（本地零 LLM 占用）：**

| 环节 | 谁来做 | 说明 |
|---|---|---|
| 写提示词（场景/镜头/音频一体化文案） | **在线模型**（调用方智能体） | H3 提示词建议一段式自然语言，把画面、运镜、音效写在一起；中文直写即可 |
| 看参考图 → 转写成详尽文字描述 | **在线多模态**（如 agy 视觉） | 把 r2v 降级为 t2v：描述得越细（服饰/姿态/光线/景别），主体还原度越高 |
| 抽帧 QC 成品 | **在线多模态** | 插件自动抽首/中/尾 3 帧，交在线模型判分 |
| 产出条件张量（编码） | **本地 Qwen3-VL-32B** | 不可避免，但它只跑**一次**前向（编码结果全程复用），大头是 DiT 的几十次去噪 |

**两个理论上的"省编码器"路子（都不推荐）：**

1. **嵌入预缓存**：在别处（云端租卡）跑一次编码器，把张量存成文件注入工作流。目前 H3 没有现成的嵌入注入节点，要自写 custom node；而且只省 14.6GB 内存峰值，22.4GB 的 DiT 该装不下还是装不下——对你这台机器，H3 的问题不在编码器
2. **API 中转**：MiniMax 官方视频 API 按条计费，无本地硬件要求；要 H3 画质又不想升级硬件，这是最省心的路（本地走 wan22_ti2v 当主力抽卡）

---

## 7. 模型推荐指南（生图 / 生视频，含 NSFW）

> 本节基于 2026-09 的社区共识（CivitAI 下载量/评测、ComfyUI 官方文档）。下载渠道：**CivitAI**（civitai.com，大陆网络通常需代理）、**HuggingFace 镜像**（hf-mirror.com，大陆直连）、**ModelScope 魔搭**（modelscope.cn，大陆直连）。模型文件均放入 `D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\` 对应子目录。

### 7.1 生图（RTX 5060 Ti 16GB 全部可跑）

**先试现有的**：你已有的 `beyondREALITY_zTURBOREBUILDV30`、`plantMilkModelSuite_walnut`、`zImageTurbo`、`juggernautXL` 都是社区合并/微调版 checkpoint，普遍未做严格安全过滤，直接用 `txt2img`/`img2img` 预设测试即可，多数已可产出成人内容。2026-09 已补齐两个 NSFW 专职主力（`RealVisXL_V5.0_Lightning_fp16` 写实 / `ponyDiffusionV6XL_v6StartWithThisOne` 二次元，HF 直连下载），并整理了四流程工作流套件（文生图/图生图/文生视频/图生视频）放在 `C:\Users\lcl\Desktop\NSFW工作流\`。

想要更专职的 NSFW 模型（均为 SDXL 架构，放 `models/checkpoints/`）：

| 模型 | 风格 | 说明 |
|---|---|---|
| [Pony Diffusion V6 XL](https://civitai.com/models/257749) | 二次元/兽人/furry | NSFW 社区事实标准，LoRA 生态最大；用 `score_9, score_8_up…` 标签体系提示 |
| [Pony V7 base](https://civitai.com/models/1901521)（[HF](https://huggingface.co/purplesmartai/pony-v7-base)） | 同上，新一代 | 换用 AuraFlow 7B 架构，自然语言理解强、多角色/复杂场景更好；较新，生态在成长 |
| NoobAI-XL / Illustrious 系 | 二次元（日系动漫向） | Illustrious 架构 NSFW 基线，danbooru 标签提示 |
| [epiCRealism XL](https://civitai.com/models/277440) | 写实人像 | 写实系 NSFW 社区第一（CivitAI 670 万+ 下载） |
| [RealVisXL V5.0 Lightning](https://civitai.com/models/139562) | 写实 | 6 步 Lightning 版出图快，人像质感佳 |
| Big Lust v1.6 | 写实 NSFW 专职 | 专精成人内容的写实微调 |
| Terra Mirabilis (CreaLISM) | 写实情绪/氛围 | 情绪表现力强的写实 NSFW |

提示词要点：写实系用摄影词汇（镜头/光线/胶片感）；Pony 系用 score 标签 + danbooru 标签；SDXL 系分辨率 832×1216 / 1216×832 竖横构图更稳。

**黑兽（黒獣）系列专项**（2026-09 实装，套件含 `文生图-黑兽角色.json` / `图生视频-黑兽风格.json`）：

| 已装 LoRA（`models/loras/`） | 用途 | 要点 |
|---|---|---|
| `kuroinu_pony_chloe.safetensors` | Chloe 角色定妆（Pony 底座） | 触发词 `kjochloe`（训练标注全小写）；金发+侧马尾是训练主流(139:5),白发也能出;实测角色还原度极高 |
| `kuroinu_pony_leona.safetensors` | Leona 角色（Pony 底座） | 触发词 `kjoleona`；白发+狼耳是她,穿甲战斗 NSFW 是独有卖点,群交特化卡 |
| `kuroinu_pony_luca.safetensors` | Luca 角色（Pony 底座） | 触发词 `kjoluca`；刘海遮眼是本体,唯一训练过项圈的卡 |
| `kuroinu_wan_style.safetensors` | Wan 视频画风注入 | `LoraLoaderModelOnly` 串 UNETLoader 后，权重 0.6。四轮 A/B 实测:图生视频画风主要靠首帧继承(此卡可选),动漫首帧的动态弱是 Wan2.2+动漫组合的固有特性而非 LoRA 所致 |

同种子对比实测：LoRA 版"神韵贴合原作"，纯 danbooru 标签版严重跑偏（恶魔角/手游风）——黑兽角色必须走 LoRA。注意：HF 上 CarrotBu 的全角色包是 SD1.5 底座（张量结构实测），与 SDXL 系不兼容；更多角色（Kaguya 的 Pony 卡等）在 CivitAI，部分需登录 token。边界：Luu-Luu（娇小体型）与 Young Radomira 不做，全部生成保持虚构成年人。

**指令式图像编辑（2026-09 实装，`图像编辑-QwenEdit.json`）**：官方 Qwen-Image-Edit-2509 Q4_K_M GGUF + Lightning 8步 LoRA + `qwen_image_vae` + Qwen2.5-VL-7B TE（`device=cpu` 固定内存）。中文直写指令换姿势/换装/换场景，QC 四项 92/95/90/88 生产可用，8 步约 2 分钟/张。**三条铁律（3 小时排障换来的）**：
1. **VAE 必须用 `qwen_image_vae.safetensors`（242MB），绝不能用 Z-Image 的 `ae.safetensors`（320MB）** —— 混用 = 参考图隐编码带时间维 → token×8 必爆显存 + 解码满屏棋盘伪影。两者都已在注册表，`comfyui_fetch_model` 按名可取。
2. **社区 Rapid AIO 合并版（Phr00t v14–v23）在 16GB 卡上判死** —— 其多步蒸馏拼接机制让 token ×8.7，与量化无关，实测 v23 Q4/Q3、v14 Q4 全灭，别再试。
3. **aki/绘世默认的 CUDA Malloc 建议关闭**（`--disable-cuda-malloc`）—— A/B 实测对生成速度零影响（16.2s vs 16.2s），但 cudaMallocAsync 不归还显存池，会坑低显存 offload 调度。

### 7.2 生视频

**Wan2.1（阿里，Apache 2.0，推荐起步）** — 你机器上目前没装视频模型，建议先下载 1.3B fp8（16GB 显存轻松跑，`wan_t2v`/`wan_i2v` 预设直接可用）：

| 文件 | 目录 |
|---|---|
| `wan2.1_t2v_1.3b_fp8_e4m3fn.safetensors` | `models/diffusion_models/` |
| `wan2.1_i2v_480p_1.3b_fp8_e4m3fn.safetensors`（图生视频） | `models/diffusion_models/` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders/` |
| `wan_2.1_vae.safetensors` | `models/vae/` |

来源：[Comfy-Org/Wan_2.1_ComfyUI_repackaged（split_files）](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files)（经 hf-mirror 同路径下载），魔搭亦有大模型镜像。14B fp8 版 16GB 显存也能跑（速度慢，建议 480P）。

**NSFW 视频**：
- Wan2.1 原版对成人内容有一定拒绝倾向，社区在 CivitAI 提供大量 **NSFW 微调 checkpoint / LoRA**（搜 `wan nsfw`、`wan 2.1 realistic nsfw`，如 "Universal NSFW Wan 2.x" 系列工作流与配套 LoRA）——装到 `models/loras/` 后在 `overrides` 里给 UNETLoader 输出串一个 `LoraLoaderModelOnly` 即可，或直接用 workflow 模式装官方 NSFW 工作流 JSON；
- **MiniMax H3**：开源权重未见公开的硬性内容过滤，但成人内容生成效果无社区共识、不作保证，可自行测试（提示词即分镜脚本，描述直白即可）；
- SVD / AnimateDiff 系均为 SD 时代模型，写实 NSFW 质量有限，不作为首选。

### 7.3 使用边界（重要）

成人内容生成仅限：**虚构成年人角色**。不得生成涉及未成年人的任何性化内容（无例外）；不建议生成真实存在人物的成人内容（深伪风险与法律风险）；请遵守所在地法律法规及模型许可证（多数开源模型许可证禁止特定用途，商用前务必阅读；MiniMax H3 本地生成物的商用需另行取得 MiniMax 商业授权）。

## 8. 设备适配与在线协作规则

基于在真实消费级桌面环境（**RTX 5060 Ti 16GB / 32GB RAM / Windows 11 / ComfyUI http://127.0.0.1:8188**）的实测沉淀，本插件固化了以下工程级准则。

### 8.1 16GB VRAM 真实实测与模型选型指南

| 模型体系 | 权重规模 | 16GB 显存表现 | 32GB RAM 表现 | 推荐程度与参数建议 |
|---|---|---|---|---|
| **Wan2.1 i2v 720p 14B fp8** | ~15.27 GB | **严重过载**：桌面渲染与系统基础开销（~1.5-2GB）导致权重无法完全装入显存，被迫触发频繁的内存与显存页换流。 | 若后台存在大内存程序（如 `llama-server` 占用提交 26.5GB），物理内存瞬间被挤爆，Windows 页面文件颠簸至 36.5GB，每步耗时超 2 分钟，37 分钟跑不完 20 步甚至直接死锁。 | ⚠ **低可用**：仅适合 24GB 显卡；若在 16GB 运行，必须彻底清空所有后台大内存程序，预留 45+ 分钟，且降低分辨率。 |
| **Wan2.2 TI2V-5B + wan2.2_vae** | ~9.31 GB | **黄金甜点**：权重 + 720p 激活值约 12.5GB，完美落入 16GB 显存安全水位，绝不触发流式页置换。 | 物理内存占用稳定在安全区间，杜绝虚拟内存颠簸与死锁。 | 🌟 **强烈推荐（首选）**：**13 分钟稳定出片**。甜点参数：`704×1280`（竖版）或 `1280×704`（横版），`121帧`，`24fps`，`30步`，`cfg 5.0`，`shift 5.0`，采样器 `euler2`，调度器 `simple`。 |
| **MiniMax H3 (pruned int8)** | ~20.9 GB + 14GB 文本编码器 | **极大挑战**：需将文本编码器通过 `text_encoder_device: cpu` 锁定在内存中，并启用 Turbo 8 步加速。 | 物理内存必须留足 36GB 以上，否则同样触发页面文件置换。 | ⚡ **可选体验**：必须预先关闭所有后台占用程序。 |

### 8.2 直言不讳规则（No Euphemism）

设备能力守卫（`lib/capability.mjs`）在每次执行生图/生视频前自动探测硬件状态与模型规格，裁决直白透明：
1. **拦截（blocked）**：当系统空闲物理内存不足以装载模型权重（`ram_free < weights * 0.6`，如后台开了 llama-server 导致物理内存仅剩几 GB）或显卡总显存低于 6GB 时，守卫**主动拦截任务并拒绝向 ComfyUI 提交**，直接向用户展示带具体数字的中文拦截原因与释放内存建议，坚决杜绝因盲目提交导致整机卡死、死锁重启。
2. **警示慢速（ok_slow）**：当模型权重略大于可用显存但系统内存充足时，明确告知用户预计耗时（如 45 分钟起步）及换页代价，并直接推荐替代方案（如 `wan22_ti2v`）。
3. **健康通过（ok）**：显存与物理内存均在安全裕度内，流畅执行。

### 8.3 画幅自适应与在线协作

- **杜绝人像切头**：直接向横版 `1280×704` 预设喂竖版手机人像拍摄素材，会导致模型在 Latent 预处理时将人物头部或下半身裁切。
- **自动检测与无感对齐**：`lib/imageMeta.mjs` 内置零外部依赖的原生 Buffer 二进制解析器，快速读取 PNG IHDR 与 JPEG SOF 真实宽高。
  - 输入竖版素材（高度 > 宽度）：`wan_i2v` / `wan22_ti2v` 自动切换为 `704×1280` 竖版视频模式；
  - 输入横版素材（宽度 ≥ 高度）：自动保持 `1280×704` 横版视频模式；
  - 用户显式指定 `width` / `height` 时，100% 遵从用户指令；
  - 调整详情实时展示在终端与模型响应摘要中。

### 8.4 异常保护看门狗与自动化质检

- **显存保护看门狗**：在长视频生成的轮询期间，若遇用户中断（AbortSignal）、等待超时（timeout_sec）或异常报错，看门狗将立即触发 `POST /interrupt` 中止生成并调用 `POST /free {"unload_models": true, "free_memory": true}`，杜绝后台幽灵进程占用显存或继续空耗算力。
- **自动化 QC 抽帧**：视频生成落地后，若宿主机已配置 `ffmpeg`，插件自动抽取第 0 帧、中帧和尾帧存为 `<base>_qc1.png`、`<base>_qc2.png`、`<base>_qc3.png` 并纳入产物清单。调用模型可直接通过 `read_image` 视检生成的视频关键帧，实现端到端的自主多模态闭环验证。

### 8.5 模型库首次运行全自动发现

为完美适应不同用户差异化的电脑环境与模型存放习惯（例如有的用户使用官方目录、有的用户使用秋叶整合包多层目录、或在 `extra_model_paths.yaml` 中挂载了 SD WebUI 共享模型库）：
- 插件在首次运行时，无需用户手动寻找或配置复杂路径，自动通过 **运行中 ComfyUI 进程命令行扫描 → 全盘 ComfyUI 深度扫描 → extra_model_paths.yaml 递归解析** 自动汇总全量模型库目录集合；
- 在模型查重与自动下载时，优先选用已有文件子目录、优先非 C 盘并按最大可用空间智能调度，真正做到全自动适应与即插即用。

