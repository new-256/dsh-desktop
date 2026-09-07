# comfyui-bridge — DSH 直接控制 ComfyUI 生图生视频插件 · 设计文档

> 版本 v1 · 平面:家级(host root)· 源码:`C:\Users\lcl\Desktop\DSH\plugins\comfyui-bridge\`
> 挂载:`dsh-home/cordis.patch.yml` 增加 file:// 行(全局层 → 所有 preset / 所有模式的会话都可见)

## 1. 目标

让 DSH(任意会话、任意 preset)通过模型工具**直接驱动本地(或局域网)ComfyUI**:

- **生图**:txt2img / img2img(SD1.5 / SDXL / Flux 等单文件 checkpoint 均可)
- **生视频**:Wan2.1 文生视频 / 图生视频、SVD 图生视频、AnimateDiff(装了对应模型与节点即可)
- **提交任意 API 格式工作流**(workflow 模式,逃生舱:任何自定义节点图都能跑)
- 产物**自动下载进 DSH 工作区**,模型可用 read_image 查看、可在回答中引用路径给用户
- ComfyUI 不在运行 / 模型缺失 / 节点缺失时给出**可操作的错误信息**(列出可选项)

非目标(v1 不做):GUI 画廊卡片(客户端半边)、WebSocket 实时进度、自定义节点市场扫描。
`/history` 轮询 + 队列位置上报已足够;GUI 后续可加(见 §9)。

## 2. 架构与平面决策

```
┌─ DSH Host(root 作用域,家级 cordis.patch.yml)─────────────────────┐
│  comfyui-bridge 行 (file:///.../lib/index.mjs?v=1)                 │
│  ├─ ctx.tools.register × 6   → 工具进 global 层 → 全部会话可见      │
│  ├─ ctx.systemPrompt.section → 简短使用引导(仅一段)                │
│  └─ global fetch → ComfyUI HTTP API(http://127.0.0.1:8188)        │
└────────────────────────────────────────────────────────────────────┘
        │ GET/POST /prompt /history /view /object_info /upload /interrupt /queue /system_stats
        ▼
   ComfyUI 服务(本机默认 8188,可配置 baseUrl / headers)
```

- **为什么放家级而不是 preset**:ComfyUI 是机器级能力(类似 agy MCP / web-search 的家级注册),
  与会话无关;放 preset 会 scoped-shadow 且每 preset 重复注册。插件不发布任何服务,
  只注册 tools + systemPrompt,无 isolate realm 需求。
- **依赖纪律**(与 agy-first-bridge / web-search 相同):不 import 任何 `@deepseek-ai/*`;
  HTTP 用 host realm 全局 `fetch`(web-search 插件已验证可用);Node 内建(`node:fs/path/url/crypto`)可用。
- **config 来源**:`apply(ctx, config)` 第二参数 = cordis.patch.yml 行 config,热重载(改 config 无需重启);
  改 .mjs 源码需 bump `?v=N`;**新增行需重启 DSH**。

## 3. 配置(cordis.patch.yml 行 config)

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `headers` | `{}` | 附加请求头(反代 Basic Auth 等),如 `{Authorization: 'Basic ...'}` |
| `outputsDir` | `comfyui-outputs` | 产物目录;相对路径 → 拼到工作区根;绝对路径 → 原样 |
| `requestTimeoutMs` | `30000` | 单次 HTTP 请求超时 |
| `pollIntervalMs` | `2000` | 等待结果轮询间隔 |
| `defaultTimeoutSec` | `1800` | generate 默认等待上限 |
| `maxTimeoutSec` | `3600` | generate 等待上限的硬顶 |
| `clientIdPrefix` | `dsh` | /prompt client_id 前缀(随机后缀) |

工作区根解析顺序:`sandboxPolicy.workspaceRoot`(host 服务,DSH Desktop = `C:\Users\lcl\Desktop\DSH`)
→ 兜底 `process.cwd()`。

## 4. 工具集(6 个,snake_case 参数,全局层注册)

### 4.1 `comfyui_status`
无必填参数。聚合 `GET /system_stats` + `GET /queue`。
返回:`{ok, reachable, version, comfy_uptime, devices:[{name,vram_total,vram_free,torch_dev}], queue:{running,pending}, apiNote}`。
ComfyUI 不可达时 `ok:false` + 明确的连接错误(提示先启动 ComfyUI、检查端口)。

### 4.2 `comfyui_models`
参数:`folder` ∈ `checkpoints|vaes|loras|unets|upscalers|clip|all`(默认 all)。
实现:`GET /object_info/{CheckpointLoaderSimple|VAELoader|LoraLoader|UNETLoader|UpscaleModelLoader|CLIPLoader...}`
解析各节点对应枚举字段(checkpoint 名称列表)。**缓存 60s**。
返回每类文件列表(每类截断 80 条 + total),并附视频能力探测:
`videoCaps: {saveVideo|saveAnimatedWEBM|saveAnimatedPNG, wanNodes, svd, animateDiff}`(按节点存在性)。
单一文件夹节点缺失(如没装 LoraLoader)→ 该类标 `unavailable` 而不是整体失败。

### 4.3 `comfyui_generate`(核心)
参数(JSON Schema,全部可选除模式必填项):

| 参数 | 类型/默认 | 说明 |
|---|---|---|
| `mode` | `preset`(默认)/ `workflow` | |
| `preset` | 见 §5 模板表 | preset 模式必填 |
| `prompt` | string | 正向提示词(preset 模式必填) |
| `negative_prompt` | string | 负向提示词(Wan/SVD 模板忽略或仅注释) |
| `model` | string | checkpoint 名(图)/ unet 名(wan);缺省自动挑(§5) |
| `image` | string | img2img / wan_i2v / svd 的输入图;**工作区相对或绝对路径,自动上传** |
| `width`/`height` | int | 默认按模板/模型启发式 |
| `steps`/`cfg`/`seed`/`sampler`/`scheduler` | — | KSampler;seed 缺省随机 |
| `denoise` | num | img2img 默认 0.65,其余 1.0 |
| `batch_size` | int=1 | |
| `length` | int | 视频帧数(wan 默认 81=5s@16fps;svd 25;ad 32) |
| `fps` | int | 视频保存帧率(wan 16;svd 8) |
| `motion_bucket_id`/`augmentation_level` | — | SVD 专用 |
| `workflow` | object/string | workflow 模式必填;API 格式图(对象或 JSON 字符串,容忍尾逗号?否——严格 JSON,字符串给清晰解析错误) |
| `overrides` | object | `{nodeId:{field:value}}` 合并进最终图(preset/workflow 模式都可用,如接 Lora) |
| `wait` | bool=true | false=只提交,立刻返回 prompt_id,之后用 comfyui_history 收 |
| `timeout_sec` | int | 10..maxTimeoutSec,默认 defaultTimeoutSec |
| `output_dir` | string | 本次覆盖输出目录 |
| `filename_prefix` | string=`ComfyUI` | |

执行流程:
1. 构图(preset 模板 or workflow 直用)→ `overrides` 深合并。
2. **预校验**:对图中每个 class_type 查 `/object_info`(缓存);类不存在→错误+近似名建议;
   枚举字段值不在列表→错误+可用值(前 20 个)。模板内节点缺失(如没装 Wan/AD)→ 明确「缺哪个节点包」。
   (校验只对 preset 模式强制;workflow 模式也校验但仅警告不阻断?——**统一强制**,ComfyUI 自己也会拒,
   但我们的错误信息更可读;校验失败即返回,不提交。)
3. `image` 存在 → 读文件(不存在→明确错误)→ `POST /upload/image`(multipart,overwrite:true)
   → 得到 ComfyUI 侧文件名,填入 LoadImage/WanImageToVideo 节点。
4. `POST /prompt` `{prompt: graph, client_id}` → `prompt_id`;node_errors 非空→结构化返回。
5. `wait=false` → 返回 `{ok:true, prompt_id, queuePos, note:'用 comfyui_history(prompt_id) 收结果'}`。
6. `wait=true` → 轮询 `GET /history/{prompt_id}`(pollIntervalMs):
   - 响应含该 id → 看 `status.status_str`:`success` 收集输出;`error` → 从 `status.messages`
     提取 execution_error(node/type/exception_message/traceback 摘要)结构化返回。
   - 未出现 → 顺带查 `GET /queue` 上报位置(running/pending),继续等。
   - **观察 `exec.signal`**(用户取消→停止等待,返回 prompt_id,渲染仍在 ComfyUI 侧继续)。
   - 超时 → 返回 `{ok:false, status:'TIMEOUT', prompt_id, note:'可 comfyui_history 续收'}`。
7. 收集输出:遍历 `outputs[nodeId]` 的**所有**值为「对象数组且元素含 filename」的键
   (images/gifs/videos/audio…,不硬编码键名,兼容新旧版本),逐个 `GET /view?filename&subfolder&type`
   下载保存到 `<outputsDir>/<yyyyMMdd-HHmmss>-<promptId前8>/<原名>`;同目录写 `run.json` 清单
   (参数、prompt_id、耗时、输出列表)。
8. 返回:`{ok, prompt_id, elapsedSec, queuePosLast, outputs:[{node, filename, type, savedPath(工作区相对), absPath, url(view直链), kind(image|video|audio|other按扩展名)}], outputsDir, error?}`。
   render 文本:每行一个产物路径 + 提示「图片可用 read_image 查看;引用路径给用户」。

**不设 registry timeoutMs**(视频生成可达小时级);内部自管 timeout_sec,全程转发 exec.signal 到 fetch。

### 4.4 `comfyui_history`
参数:`prompt_id`(可空=列最近)、`max_items`=5(列表模式)、`download`=true。
- 列表:`GET /history?max_items=N` → 每条 {prompt_id, 时间, status_str, 输出数}。
- 指定 id:同 generate 第 7 步下载收集;不存在或未完成 → 明确状态(还在队列/执行中/历史无此 id)。

### 4.5 `comfyui_interrupt`
参数:`free`=false。`POST /interrupt`;free 时再 `POST /free {unload_models:true, free_memory:true}`。
返回执行结果;同时说明「只中断当前执行,排队中的清空需 ComfyUI 面板」(v1 不做清队列)。

### 4.6 `comfyui_upload`
参数:`path`(必填,工作区相对或绝对)、`name`(改名)、`overwrite`=true、`type`=`input`。
上传后返回 ComfyUI 侧文件名(preset 的 image 参数会自动上传,此工具用于预传/复用,如遮罩、参考图)。

## 5. 预设工作流模板(preset 模式)

模板 = `(params, apiInfo) => graph`,apiInfo 提供 object_info 缓存与模型列表,实现**版本自适应**。

| preset | 图 | 关键默认 | 自动选模型 |
|---|---|---|---|
| `txt2img` | CheckpointLoaderSimple→CLIPTextEncode±→EmptyLatentImage→KSampler→VAEDecode→SaveImage | 名含 sdxl/flux→1024²,否则 768²;steps 25(flux 20);cfg 6.5(flux 1.0,euler/simple);denoise 1.0 | checkpoints 第一项(优先 xl/flux 关键词) |
| `img2img` | LoadImage→VAEEncode→KSampler→VAEDecode→SaveImage | denoise 0.65;尺寸不填(用输入图) | 同上 |
| `wan_t2v` | UNETLoader→(ModelSamplingSD3 shift8)→CLIPLoader(type:wan)→CLIPTextEncode±→EmptyHunyuanLatentVideo→KSampler(cfg1,steps20,euler/simple)→VAEDecode→**自适应视频尾** | 832×480,length 81,fps 16 | unets 匹配 /wan.*t2v/i;vae 匹配 /wan.*vae/i;clip 匹配 /umt5/i |
| `wan_i2v` | LoadImage→WanImageToVideo(±cond,vae,w/h/length)→KSampler→VAEDecode→自适应视频尾 | 832×480(720p 模型→1280×720),length 81 | unets 匹配 /wan.*(i2v|img)/i |
| `svd_img2vid` | ImageOnlyCheckpointLoader→SVD_img_to_vid_Conditioning(+VideoLinearCFGGuidance min_cfg1.0)→KSampler(cfg1,steps20,euler,simple)→VAEDecode→自适应视频尾 | 1024×576,frames 25,fps 8,motion 127 | checkpoints 匹配 /svd/i |
| `animatediff` | CheckpointLoaderSimple→ADE_AnimateDiffLoaderGen1(context 16)→VideoTriangleCFGGuidance→KSampler→VAEDecode→自适应视频尾 | 512×512,length 32,steps 20 | checkpoints 第一;motion 模型匹配 /animateliff|mm_sd/i,缺→可操作错误 |
| `h3_t2v` | UNETLoader→(LoraLoaderModelOnly turbo)→CLIPLoader(type:minimax)→MiniMaxH3ImageToVideo→BasicGuider+KSamplerSelect(res_multistep)+BasicScheduler(simple)→SamplerCustomAdvanced→VAEDecode+VAEDecodeAudio→CreateVideo(fps24,audio)→SaveVideo | 1344×768(32 倍数),duration_sec 5→length 124(17k+5@24fps),turbo 6 步/普通 20 步 | unet 匹配 /minimax.*h3.*fl2v/i;qwen3vl 文本编码;video/audio 双 VAE;turbo LoRA 匹配 /minimax.*h3.*(turbo|lightning)/i |
| `h3_flf2v` | 同 h3_t2v,MiniMaxH3ImageToVideo 接 first_frame(±last_frame,两张 LoadImage) | 同上 | 同上 |
| `h3_r2v` | 同 h3_t2v,条件节点换 MiniMaxH3ReferenceToVideo(clip+vae+audio_vae+ref_image_0,prompt 用 `<Picture 1>` 指代) | ref_image_size: match | unet 匹配 /minimax.*h3.*ref2v/i |

H3 三预设的图骨架逐节点对照 ComfyUI 官方源码 `comfy_extras/nodes_minimax_h3.py` 与官方模板 `video_minimax_h3_t2v.json`(subgraph 接线提取)验证;本地 ComfyUI 核心过旧(无 nodes_minimax_h3.py)时,预校验给出明确的"请升级 ComfyUI"错误。注意区分:官方模板里的 `MinimaxHailuo03*` 一体化节点是云端 API 节点(comfy_api_nodes),本插件走本地开源权重。

**自适应视频尾**(生成时探测,不硬编码版本):
按优先级找 saver 类:`SaveVideo`(新核心视频节点)→ `SaveAnimatedWEBM` → `SaveAnimatedPNG`;
按其 object_info 实际输入填参(有 `fps` 填 fps;`video_format`/`format` 枚举选 'video/h264-mp4' 或 'video/vp9-webm' 或第一项;
`filename_prefix` 填前缀)。三者皆无 → 「请安装新版 ComfyUI 或 VHS」。
`CLIPLoader` 无 `type` 字段(旧版)→ 省略该字段。`ModelSamplingSD3` 不存在 → 省略并直连(带 warn)。
同规则处理 `WanImageToVideo`/`SVD_*`/`ADE_*` 缺失:错误信息列出 preset 所需全部节点 + 哪个缺。

**API 路径兼容**:请求辅助函数先打根路径(`/prompt`),遇 404 自动改用 `/api` 前缀(`/api/prompt`)
并记住(新版 ComfyUI 前端路由拆分,老路径仍兼容;探测一次,后续直接用)。`/view` 下载同理。

## 6. 错误与呈现

- 每个工具返回 `{ok:false, error, hint?}` 结构 + render 出可读文本;
  网络层错误带 hint(「ComfyUI 未启动?默认 127.0.0.1:8188,用 comfyui_status 检查」)。
- generate 的 execution_error 结构化透出(node 类名、节点 id、异常消息、traceback 尾部 8 行)。
- 工具结果 render 均为 text 块;产物路径为**工作区相对**(`comfyui-outputs/...`),模型可直接引用。

## 7. systemPrompt 引导(一段,~10 行)

comfyui_* 工具存在性、preset 优先 / workflow 逃生舱、产物落点与 read_image 提示、
ComfyUI 不通先 comfyui_status、长视频用 wait=false + comfyui_history。

## 8. 测试(无 ComfyUI 也可全量验证)

- `test/mock-comfyui.mjs`:纯 node:http mock,实现 /system_stats /queue /object_info(内置 §5 全部节点 schema
  + 模型枚举)/prompt(入队,异步 1.2s 后完成)/history(含 outputs images+gifs)/view(返回小 PNG/PNG 字节)/upload
  (收 multipart,回 name)/interrupt。`--video-fail` 开关模拟 execution_error。
- `test/run-tests.mjs`:起 mock(18188)→ `apply(stubCtx, config)` 收集工具 →
  断言:status 可达性、models 列表、txt2img preset 产出 savedPath 且文件字节=mock 的 PNG、
  img2img 自动上传、wan_t2v 自适应尾、workflow 模式、wait=false、history 下载、interrupt、
  错误路径(坏 checkpoint 名→枚举错误;mock 关闭→连接错误;视频失败→execution_error 透出)。
- 全绿后 `node --check` 通过。

## 9. 后续方向(v2+)

- 客户端半边:设置卡片(baseUrl/输出目录)+ 会话内画廊(轮询 /history 渲染缩略图)。
- WebSocket /ws 实时进度(当前轮询已够用)。
- 清空队列(DELETE /queue)、/free 内存管理 UI 化、embeddings 列表、Flux 专用双文本编码模板。
- 把模板注册表开放成数据文件,用户自定义 preset。

## 10. 交付物清单

```
plugins/comfyui-bridge/
  DESIGN.md            ← 本文档
  README.md            ← 用户文档(安装/配置/用法/示例)
  lib/index.mjs        ← host 半边(单文件自包含,零 @deepseek-ai 依赖)
  test/mock-comfyui.mjs
  test/run-tests.mjs
dsh-home/cordis.patch.yml  ← 追加 comfyui-bridge 行(需重启 DSH 生效)
```
