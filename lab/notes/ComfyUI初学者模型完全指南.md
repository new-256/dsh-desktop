# ComfyUI 文生图 / 图生图 · 模型完全指南（初学者版）

> 目标读者：刚接触 ComfyUI、被各种模型名词搞得头晕的人。
> 阅读方式：从头到尾读一遍，之后当字典查（最后一页是速查总表）。

---

## 一、先看懂全局：一张 AI 图是怎么"生"出来的

别急着记名词。先想象一条**照片冲印流水线**：

```
你说的话 ──→ ① 翻译官听懂 ──→ ② 画家在草稿纸上画画 ──→ ③ 冲印店洗出照片 ──→ 成品图
（提示词）    （文本编码器）      （扩散模型+采样器）        （VAE 解码）
```

- **翻译官（文本编码器）**：你说的是人话，画家只懂"数字密码"。翻译官负责把你的提示词变成一串数字向量。
- **画家（扩散模型）**：拿到密码后，在一张全是噪点的"草稿纸"（潜空间）上一笔一笔把图"擦"出来。
- **冲印店（VAE）**：画家画完的只是 128×128 的压缩草稿，冲印店把它解码放大成真正的图片文件。

这三个角色就是**三大核心模型**，缺一不可，合称"铁三角"。

**潜空间（Latent）** 这个词会一直出现，意思就是"画家的草稿纸"：一张 1024×1024 的图会被压成 128×128 的数字草稿，AI 实际是在草稿上作画，画完再由 VAE 还原成大图。这样做 purely 是为了省算力。

---

## 二、铁三角详解（缺一不可的基础模型）

### 2.1 扩散模型 —— 画家本人（决定画风的灵魂）

| 项目 | 说明 |
|---|---|
| 常见叫法 | 大模型、底模、Checkpoint、主模型、UNet、DiT |
| 文件形式 | `.safetensors` 或 `.ckpt` |
| 存放目录 | `ComfyUI/models/checkpoints`（一体式）或 `models/diffusion_models`（分离式，也叫 unet） |
| 加载节点 | **Load Checkpoint**（一体式）/ **Load Diffusion Model (UNET Loader)**（分离式） |
| 干的活 | 在潜空间草稿上，按你的提示词一步步去噪，把随机噪点变成图 |

**关键认知：它是整个画风的底子。** 写实风、二次元、国风水墨——你换 checkpoint 就是在换一个"学过不同流派的画家"。

**两种打包方式（非常重要，后面第八节细讲）：**
- **一体式 Checkpoint**（SD1.5 / SDXL 时代）：把画家+翻译官+冲印店打包在一个文件里。Load Checkpoint 一个节点吐出 MODEL / CLIP / VAE 三根线。
- **分离式三件套**（Flux / SD3.5 / Wan / 新模型时代）：画家单独一个文件（diffusion_models）、翻译官单独一个（text_encoders）、冲印店单独一个（vae）。好处是显存友好、可以单换某一件。

### 2.2 文本编码器 —— 翻译官（把人话变成密码）

| 项目 | 说明 |
|---|---|
| 常见叫法 | CLIP、T5、UMT5、text encoder |
| 存放目录 | `models/text_encoders`（新）或 `models/clip`（旧） |
| 加载节点 | SD1.5/SDXL：不单独加载（在 checkpoint 里）；Flux/SD3：**DualCLIPLoader**；Wan：**CLIPLoader (GGUF)** 选 umt5_xxl |
| 干的活 | 把"一个穿红裙子的女孩"变成 768/4096 维的数字向量，喂给画家 |

**架构与翻译官对照：**

| 架构家族 | 文本编码器 | 备注 |
|---|---|---|
| SD1.5 / SD2.x | CLIP ViT-L（单 CLIP） | 打包在 checkpoint 内 |
| SDXL | CLIP-L + OpenCLIP bigG（双 CLIP） | 打包在 checkpoint 内 |
| SD3 / SD3.5 | 双 CLIP + T5-XXL（三件） | 需单独下载 t5xxl |
| Flux | CLIP-L + T5-XXL（双件） | 需单独下载 t5xxl |
| Wan2.1/2.2 | UMT5-XXL | 单独下载 |
| MiniMax H3 等 | Qwen3-VL 等多模态编码器 | 单独下载 |

翻译官不同，"听得懂的话"也不同：CLIP 只吃 77 个 token（所以 SD1.5 的提示词写太长会被截断）；T5 能吃长文本，所以 Flux/Wan 可以写一大段自然语言描述。

### 2.3 VAE —— 冲印店（草稿 ↔ 照片的转换器）

| 项目 | 说明 |
|---|---|
| 常见叫法 | VAE、解码器 |
| 存放目录 | `models/vae` |
| 加载节点 | **Load VAE** → 接到 **VAE Decode**（或 VAE Encode）上 |
| 干的活 | 图生图时把你的照片**压缩**成潜空间草稿（VAE Encode）；出图时把草稿**还原**成照片（VAE Decode） |

**VAE 出问题的典型症状（初学者必背）：**
- 整图**发灰发白**、像蒙了雾 → 没用对 VAE，或用了 SD1.5 的 VAE 去 decode SDXL 的图
- 图片**边缘有水波纹/棋盘格** → VAE 不匹配或该换 fine-tuned VAE
- 全黑全噪声 → 架构完全不对，直接报错或输出乱码图

同一个架构家族内 VAE 是通用的：SD1.5 系几百个 checkpoint，随便换哪个 VAE 都行（有些社区精调 VAE 如 `vae-ft-mse-840000` 就是专门让颜色更饱满的）。

---

## 三、文生图（txt2img）工作流逐节点拆解

以 SDXL checkpoint 为例，标准最简文生图工作流长这样。**注意每一类模型在哪个节点"上车"：**

```
[Load Checkpoint] ──MODEL──→ ┌──────────┐
        │                     │ KSampler │──latent──→ [VAE Decode] ──→ [Save Image]
        ├─CLIP──→ [正向 CLIP Text Encode]──┐        ↑                    ↑
        ├─CLIP──→ [负向 CLIP Text Encode]──┤        │                    │
        └─VAE ──────────────────────────→ (暂未用)   │                    │
                                          │        │                    │
[Empty Latent Image (宽×高)] ──latent──────┘        │                    │
                                                   └── VAE 在这里介入 ───┘
```

按数据流顺序讲一遍（这就是"每一类模型在哪一步介入"）：

1. **Load Checkpoint**：把画家+翻译官+冲印店三个模型装进显存，输出三根线（MODEL / CLIP / VAE）。**→ 扩散模型介入**
2. **CLIP Text Encode ×2**：翻译官分别翻译正向提示词（想要什么）和负向提示词（不想要什么），输出两根"条件线"。**→ 文本编码器介入**
3. **Empty Latent Image**：开一张空白的噪点草稿纸，设宽高（SD1.5 写 512×512，SDXL 写 1024×1024）。
4. **KSampler（采样器）**：整个工厂的核心车间。拿着 MODEL（画家）、正/负条件（翻译官的输出）、噪点草稿，开始一步步去噪。参数：steps（画多少笔）、cfg（听提示词话的程度）、denoise（重画程度，文生图固定 1.0）。**→ 扩散模型真正干活的地方**
5. **VAE Decode**：冲印店把画完的潜空间草稿解码成真实图片。**→ VAE 介入**
6. **Save Image**：存盘。

**一句话总结文生图需要的模型：一个 checkpoint（SD1.5/SDXL 时代，三合一）就够；新架构则需要 diffusion model + text encoder + VAE 三件套。**

---

## 四、图生图（img2img）工作流拆解

图生图 = "把你给的图当草稿，让画家照着再画一遍"。**模型种类和文生图完全一样，不多任何模型，只是多了两个节点、改一个参数：**

```
[Load Image 你的照片] ──→ [VAE Encode] ──→ 潜空间草稿 ──→ [KSampler, denoise=0.5] ──→ [VAE Decode] ──→ [Save]
                              ↑                                  ↑
                        VAE 在这里反向介入                扩散模型在这里重画
```

与文生图的**三个区别**：

1. **多了 Load Image**：上传你的原图。
2. **多了 VAE Encode**：方向反过来——把真实照片**压缩**成潜空间草稿（文生图是解码，图生图先编码）。**→ VAE 的第二份工作**
3. **KSampler 的 denoise 从 1.0 改小**，这是图生图的灵魂参数：
   - **denoise = 0.0**：画家完全不动，输出 = 原图
   - **denoise = 1.0**：草稿被完全打回噪点，等于文生图，原图基本没了
   - **denoise = 0.3~0.5**：保留构图和大形，改风格/材质（照片转插画常用）
   - **denoise = 0.6~0.8**：保留大轮廓，细节全重画（换装、改背景常用）
   - 初学者口诀：**想保留越多，denoise 越低。**

**局部重绘（inpaint）** 是图生图的特例：给图加一张蒙版（mask），画家只在涂白区域重画，其余保持。模型依然不变，只是 latent 过一个 Set Latent Noise Mask。

---

## 五、改善效果的模型（锦上添花类，全部可选）

铁三角保证"能出图"，下面这些负责"出得更好"。它们都**不改变架构，只是在流水线上加装设备**。

### 5.1 LoRA —— 给画家的"风格小抄" ⭐ 最常用

| 项目 | 说明 |
|---|---|
| 是什么 | 一个小体积的"技能补丁"，在不动主模型的情况下，教它画某个角色/画风/服装 |
| 文件大小 | 通常 70MB~700MB |
| 存放目录 | `models/loras` |
| 加载节点 | **LoRA Loader**（LoraLoaderModelOnly 或 LoraLoader） |
| 介入位置 | **必须插在 Checkpoint 之后、CLIP Text Encode 之前**，像一根串联的中间电缆：Checkpoint → LoRA → CLIP/KSampler |
| 关键参数 | strength（权重）0.6~1.0，越高越像、超过 1.2 容易崩坏 |
| 使用方法 | 加载后在提示词里写它的**触发词**（发布页会写，如 `guofeng style`） |

比喻：主模型是个全能画家，LoRA 是塞给他的一页参考图——"这个角色长这样"。可以同时塞好几页（多个 LoRA 叠加），但风格 LoRA 之间可能互相打架。

### 5.2 Embedding（Textual Inversion）—— 翻译官的"小词典"

| 项目 | 说明 |
|---|---|
| 是什么 | 一个极小的文件（几 KB~几 MB），把一长串描述压缩成一个"词" |
| 存放目录 | `models/embeddings` |
| 介入位置 | **不用任何节点！直接把文件名当单词写进提示词**，如 `embedding:easy-negative`（著名的负向词包） |
| 与 LoRA 的区别 | LoRA 改画家的手法，Embedding 只是给翻译官一个缩写词；Embedding 更轻但能力更弱 |

### 5.3 ControlNet —— 构图教练（拿骨架/线稿逼画家照着画）

| 项目 | 说明 |
|---|---|
| 是什么 | 一个中型模型，把参考图的"结构信息"（轮廓/深度/姿势）提取出来，强迫画家保持同样的构图 |
| 存放目录 | `models/controlnet` |
| 加载节点 | **Load ControlNet Model** + **Apply ControlNet**，前面还要接一个**预处理器**（如 CannyEdgePreprocessor、OpenposePreprocessor） |
| 介入位置 | Apply ControlNet 节点接在 CLIP Text Encode 之后、KSampler 之前，往"条件线"上再绑一根结构条件 |
| 常见类型 | canny（边缘线）、depth（深度）、openpose（人体姿势）、lineart（线稿）、tile（保持构图放大）、scribble（涂鸦） |

用途示例：给一张跳舞的人物照片 → openpose 提取骨架 → 生成的图人物姿势一样但服装场景全变。**这是控制构图最有效的武器。**

### 5.4 放大模型（Upscaler）—— 精修放大师

| 项目 | 说明 |
|---|---|
| 是什么 | 传统超分辨率模型（不是扩散模型），把 1024 的小图放大到 4096 且保持清晰 |
| 存放目录 | `models/upscale_models` |
| 加载节点 | **Upscale Model Loader** + **Upscale Image (using Model)**，接在 VAE Decode **之后**（像素域） |
| 常见文件 | 4x-UltraSharp、RealESRGAN_x4、4x_NMKD-Siax、SwinIR |
| 高清修复（Hires Fix） | "先生成 → 放大 → 再用 KSampler 低 denoise（0.3 左右）精修一遍"的两段式套路 |

### 5.5 IPAdapter —— "照这个感觉画"

| 项目 | 说明 |
|---|---|
| 是什么 | 把一张参考图喂给 CLIP Vision 提取"图像语义"，当作条件注入，实现风格迁移/角色一致性 |
| 需要的文件 | IPAdapter 模型本体（`models/ipadapter`）+ **CLIP Vision 模型**（`models/clip_vision`），两个都要 |
| 加载节点 | IPAdapterUnifiedLoader + IPAdapter Advanced |
| 介入位置 | 作用在 MODEL 线上（串在 KSampler 之前），参考图从 Apply 节点进 |

### 5.6 面部修复（FaceDetailer）—— 专治崩脸

原理：自动检测出图中的脸 → 把脸裁出来 → 用同一模型小图重画一遍 → 贴回去。Impact Pack 的 **FaceDetailer** 节点还额外需要一个检测模型（如 `face_yolov8m.pt`，放 `models/ultralytics`）。介入位置在 VAE Decode 之后。

### 5.7 Refiner（SDXL 时代的两段式，现已少用）

SDXL 官方曾配一个专用 refiner checkpoint：第一个模型画大形，第二个模型精修细节。原理上就是"两次 KSampler 串联"，现在社区基本用高清修复替代了。

### 5.8 视频类增强（一句话带过）

文生视频（如 Wan2.2、SVD）本质还是铁三角：视频扩散模型 + UMT5 编码器 + 3D VAE，LoRA/ControlNet 的思路同样适用；AnimateDiff 则是给 SD 画家加一个"运动模块"。

---

## 六、通用性大盘点：哪些模型能跨工作流复用？

**判断原则只有一条：看"架构家族"。** 同一家族内大量通用，跨家族基本不通用（个别例外标注如下）。

| 模型类型 | 同家族内通用？ | 跨家族通用？ | 说明 |
|---|---|---|---|
| **Checkpoint（画家）** | —（它自己就是家族本体） | ❌ | 一个 checkpoint = 一个完整画风 |
| **文本编码器** | ✅ 完全通用 | ⚠️ 个别例外 | t5xxl 同一文件可在 Flux 与 SD3.5 间共用（它们恰好用了同一款翻译官）；除此之外别混 |
| **VAE** | ✅ 完全通用 | ❌ | SD1.5 系所有模型共用一个 VAE 没问题；拿 1.5 的 VAE 给 SDXL 用就是灰图 |
| **LoRA** | ✅ 可叠加多个 | ❌ | **SD1.5 的 LoRA 插到 SDXL 上会直接报错或无效**，这是新手第一大坑 |
| **Embedding** | ✅ | ❌ | 按家族区分，写在提示词里如果家族不对会没效果 |
| **ControlNet** | ✅（同家族换控制类型） | ❌ | 每种架构都要下对应版本的 ControlNet |
| **像素放大模型（Upscaler）** | ✅ | ✅ **全局通用** | 它处理的是普通图片，与扩散架构无关——**最通用的模型，没有之一** |
| **CLIP Vision（IPAdapter 用）** | ✅ | ✅ 大多数通用 | ViT-H 版在 SD1.5/SDXL 的 IPAdapter 间可共用 |
| **检测模型（ultralytics 等）** | ✅ | ✅ | 只是通用目标检测，与画图架构无关 |

> 一句话记忆：**放大模型和检测模型随便用；编码器/VAE/LoRA/Embedding/ControlNet 全部认"家族"。**

---

## 七、如何判断两个模型能不能接（接口匹配实操）

### 7.1 唯一核心概念：接口 = 三根线的"形状"

模型之间传的是三种数据：**MODEL（画家技能）→ CONDITION（文字/结构条件）→ LATENT（草稿）**。所谓"接口匹配"，本质是这三根线的规格（通道数、维度）必须一致。而规格由**架构家族**决定，所以判断匹配 = 判断家族。

### 7.2 五种判断方法（从快到慢）

1. **看文件名**：好文件名自带家族标签——`xxx_sdxl.safetensors`、`flux1-dev`、`sd15`、`wan2.2`、`t5xxl_fp8`。
2. **看文件大小**（很准的土办法）：
   - Checkpoint 约 2GB → SD1.5
   - 约 6.5~7GB → SDXL
   - 约 10~13GB（fp8）或 20~24GB（fp16/bf16）→ Flux / SD3.5 Large
   - 约 4~5GB → SD3.5 Medium / 一些 fp8 主模型；5B 视频模型 fp16 约 10GB
   - VAE：100~400MB；LoRA：70~700MB；t5xxl：fp8 约 4.9GB / fp16 约 9.8GB
3. **看下载页**：Civitai / HF 每个模型都标注 **Base Model**（SD 1.5 / SDXL / Flux…），下载前先看这一栏。
4. **在 ComfyUI 里看下拉列表**：Load VAE / LoRA Loader 只显示对应目录的文件，但不会帮你过滤家族——所以要结合上面三条。
5. **看报错信息**：
   - `size mismatch` / `shape mismatch` → 架构不匹配（如 1.5 的 LoRA 插进 SDXL）
   - 输出全灰/全黑 → VAE 用错家族
   - 图能出但 LoRA 完全没效果 → 家族不对（没报错的情况更隐蔽）
   - `t5xxl not loaded` / 文本条件报错 → text encoder 没配或配错
   - 生成慢且结果崩 → 可能 fp8/fp16 混用不适配你的显卡（N 卡老卡对 fp8 支持差）

### 7.3 分辨率也要"匹配"

分辨率不是接口，但直接影响出图质量（也常被当作"兼容问题"）：
- SD1.5 家族：总像素按 512×512 训练（横图 768×512 没问题，拉到 1024 就会出现**重复的人/变形的四肢**）
- SDXL / Flux：按 1024×1024（约 100 万像素）训练
- 出现"重复人物"九成是分辨率超出了训练范围，不是模型坏。

### 7.4 症状速诊表

| 症状 | 病因 | 药方 |
|---|---|---|
| 整图灰白像蒙雾 | VAE 家族不对 / 没接 VAE | 换对应家族 VAE，Load VAE 接到 VAE Decode |
| 边缘水波纹/格子 | VAE 质量差 | 换社区精调 VAE（如 vae-ft-mse） |
| 报 shape/size mismatch | LoRA 或 ControlNet 家族不对 | 下载对应家族版本 |
| LoRA 无报错但无效果 | 家族不对或触发词没写 | 检查 base model + 加触发词 |
| 图里出现重复人物 | 分辨率超出训练范围 | 降到家族标准像素，用放大模型二次放大 |
| 图生图后原图完全没了 | denoise = 1.0 | 降到 0.4~0.7 |
| 出图糊、脸崩 | 步数太低/模型太老 | steps 提到 20~30，或加 FaceDetailer |

---

## 八、老架构 vs 新架构：为什么有的工作流只要 1 个加载器，有的要 3 个？

这是新手看教程时最大的困惑来源。

**SD1.5 / SDXL 时代（一体式）：**
```
[Load Checkpoint] 一个节点 → 同时输出 MODEL + CLIP + VAE
```
翻译官和冲印店被打包进 checkpoint 文件里了，省心。

**Flux / SD3.5 / Wan / 新模型时代（分离式三件套）：**
```
[Load Diffusion Model] → MODEL        （画家，放 diffusion_models/）
[DualCLIPLoader]        → CLIP        （翻译官，放 text_encoders/）
[Load VAE]              → VAE         （冲印店，放 vae/）
三根线在 KSampler / VAE Decode 汇合
```
为什么拆开？①这些模型太大，拆开可以按需量化加载（fp8 省一半显存）；②翻译官 T5/UMT5 可以在多个模型间复用；③社区可以单独升级某一件。

**识别技巧：看到教程里有 "UNET Loader / DualCLIPLoader / CLIPLoader"，说明是三件套架构，三个模型都要下齐，缺一个跑不起来。**

---

## 九、初学者十大常见错误（每条都是真实踩坑）

1. SD1.5 的 LoRA 用在 SDXL 上 → 报错或无效。**LoRA 认家族。**
2. 用错家族的 VAE → 灰图。**VAE 认家族。**
3. SDXL 出 512×512 → 画质糊（训练在 1024）。**分辨率认家族。**
4. 图生图 denoise 拉满 → 原图没保留。**想保留就调低。**
5. LoRA 权重拉到 1.5 求效果 → 画面烤焦（饱和度爆炸、肢体崩坏）。**0.7~1.0 之间找。**
6. 忘写 LoRA 触发词 → 感觉"没变化"。
7. 提示词写小作文配 SD1.5 → 超 77 token 被截断，后面全白写。（Flux/Wan 没这个问题）
8. 以为放大模型也是认家族的 → 不敢用。其实**放大模型全局通用**。
9. 三件套架构只下了主模型没下 text encoder → 直接跑不起来，报缺模型。
10. 同一个 LoRA 在不同 checkpoint 上效果差很多 → 风格 LoRA 与底模有"适配度"，在它训练用的底模上效果最好。

---

## 十、终极速查表（打印贴墙上）

| 模型类型 | 打个比方 | 存放目录 | 加载节点 | 介入位置/时机 | 干什么 | 认家族吗 |
|---|---|---|---|---|---|---|
| Checkpoint / Diffusion Model | 画家 | checkpoints / diffusion_models | Load Checkpoint / UNET Loader | KSampler（全程） | 决定画风，在潜空间去噪出图 | 它就是家族本体 |
| Text Encoder (CLIP/T5/UMT5) | 翻译官 | text_encoders / clip | （打包）或 DualCLIPLoader / CLIPLoader | CLIP Text Encode | 提示词→数字向量 | ✅ 认 |
| VAE | 冲印店 | vae | Load VAE | VAE Encode（图生图入）/ VAE Decode（出图） | 照片↔潜空间草稿互转 | ✅ 认 |
| LoRA | 风格小抄 | loras | LoRA Loader | Checkpoint 之后、Text Encode 之前，串在线上 | 教主模型特定画风/角色 | ✅ 认 |
| Embedding | 翻译官的小词典 | embeddings | 无需节点（写进提示词） | 提示词内部 | 长描述压缩成一个词 | ✅ 认 |
| ControlNet | 构图教练 | controlnet | Load ControlNet + Apply | CLIP Encode 之后、KSampler 之前（条件线上） | 锁定构图/姿势/线稿 | ✅ 认 |
| Upscaler | 精修放大师 | upscale_models | Upscale Model Loader | VAE Decode 之后（像素域） | 小图放大变清晰 | ❌ 全局通用 |
| IPAdapter (+CLIP Vision) | "照这个感觉画" | ipadapter / clip_vision | IPAdapterUnifiedLoader | MODEL 线上（KSampler 前） | 参考图风格迁移 | ✅ 认（CLIP Vision 较通用） |
| FaceDetailer 检测模型 | 崩脸专科医生 | ultralytics | FaceDetailer 内部 | 出图后 | 自动检测重画脸部 | ❌ 基本通用 |

**三大铁三角：扩散模型 + 文本编码器 + VAE —— 必需。**
**其余全部是改善效果的增强件：LoRA 改风格、ControlNet 锁构图、Upscaler 提清晰度、IPAdapter 抄感觉、FaceDetailer 救脸、Embedding 省提示词。**

---

## 十一、实战：把"三件套"文生图工作流改成图生图（以 Qwen-Image / Flux / Wan 为例）

**先记住结论：图生图不需要下载任何新模型！三个文件一个都不用换。**
你的三件套（比如 `qwen-…-diffusion-NVFP4` + `text_encoder` + `vae.safetensors`）在图生图里干的活和文生图**一字不差**，要改的只有一件事：**画布从哪来**。

**你的文生图工作流里必有这几个关键节点：**

```
[Load Diffusion Model] → MODEL ─┐
[CLIP Loader]         → CLIP ──┤   这三个加载器和它们
[VAE Loader]          → VAE ──┼─→ 后面全部不用动
[Empty Latent 节点]   → 空白噪点画布 → [KSampler denoise=1.0] → [VAE Decode] → 保存
                                 ↑ 要动的只有这一根线
```

- **文生图的画布** = Empty Latent 节点造的"纯随机噪点纸"，denoise 1.0 = 画家从零画到 100%。
- **图生图的画布** = 你的照片经 VAE Encode 压成的"半成品纸"，denoise 0.5 = 画家只重画 50%。

**三步改造（在 ComfyUI 画布上直接操作）：**

1. **加两个节点**：右键画布 → Add Node → `image` → **Load Image**（上传照片）；再 Add Node → `latent` → **VAE Encode**。
2. **接三根线**：
   - Load Image 的 `IMAGE` → VAE Encode 的 `pixels`
   - 已有的 VAE Loader 的 `VAE` 输出 → 再拖一根分叉到 VAE Encode 的 `vae`（一个输出可以接多个节点，放心拖）
   - 原本连到 KSampler 的 `latent_image` 那根线**拔掉**，改接 VAE Encode 的 `LATENT`
3. **调一个参数**：KSampler 的 denoise 从 `1.0` 改成 `0.5`。原来的 Empty Latent 节点删掉或空着不管都行。

**denoise 旋钮：**

| 值 | 效果 |
|---|---|
| 0.2~0.35 | 只换质感色调，构图人物几乎不动 |
| 0.4~0.6 | 保留构图和人物，改风格/服装/背景（最常用） |
| 0.7~0.85 | 只保留大致轮廓，细节全重画 |
| 1.0 | 原图没了 = 变回文生图 |

**三个必知的坑：**
1. **照片先缩小再喂**：缩到 1024~1536 左右（Qwen-Image 原生 1328×1328）。4000px 原图直接塞 → 显存爆、人物结构乱。可在 Load Image 和 VAE Encode 之间夹一个 `Image Scale To Total Pixels` 节点。
2. **CFG 听模型的**：Qwen-Image 系用低 CFG（2~4），别套 SD1.5 教程里的 7。
3. **denoise 越低步数越要给够**：steps 保持 20~30，步数太少时低 denoise 会出"没画完"的糊图。

**一个岔路口**：如果你的 diffusion 文件名带 **Edit**（如 Qwen-Image-Edit），那它是"指令编辑"模型——官方路线是把图片直接喂给文本编码器、写一句编辑指令、denoise 保持 1.0，比标准图生图更精准。去模型下载页找配套工作流照着搭，不要自己硬改。

---

## 十二、模型怎么存：官方分类 vs 按家族归组？

攒了三五套模型后必撞的问题：按官方目录分（checkpoints/、vae/、loras/…），还是按平台分（Qwen 一套放一起、Z-Image 一套放一起）？

**答案：骨架必须按官方分类，家族归组用子文件夹实现——两个愿望同时满足。**

### 12.1 为什么不能按家族放一个大文件夹

- 每种加载器节点**只扫描自己的目录**：VAE Loader 只翻 `models/vae/`，LoRA Loader 只翻 `models/loras/`。文件放错抽屉，节点下拉列表里**直接看不见**（不报错，是消失）。
- **有些模型跨家族复用，按家族存要拷好几份**：t5xxl 编码器被 Flux 和 SD3.5 共用（约 5GB），放大模型全家通用。按类型存只需一份。
- 目录 = "类型的接口"（接哪个节点），家族 = "搭配关系"（跟谁一组）。这是两个维度，别混在一个文件夹里。

### 12.2 正确姿势：类型做骨架，家族做子目录

ComfyUI **递归扫描子文件夹**，节点列表里会显示成 `qwen_image/vae.safetensors`：

```
ComfyUI/models/
├─ diffusion_models/            ← 画家们
│   ├─ qwen_image/qwen-…-diffusion-NVFP4.safetensors
│   └─ z_image/z_image_dit.safetensors
├─ text_encoders/               ← 翻译官们
│   ├─ qwen_image/text_encoder-NVFP4.safetensors
│   └─ z_image/qwen3_4b_fp8.safetensors
├─ vae/                         ← 冲印店们
│   ├─ qwen_image/vae.safetensors
│   └─ z_image/vae.safetensors
├─ loras/                       ← 风格小抄们
│   ├─ qwen_image/lightning_lora.safetensors
│   └─ z_image/xxx.safetensors
└─ upscale_models/              ← 放大师（全局通用，不用分家族）
```

**一句话：目录回答"它是哪种零件"（接哪个节点），子目录/文件名回答"它属于哪个家族"（跟谁搭配）。**

### 12.3 三个老手习惯

1. **下载一套新模型时照配套工作流/README 写的路径放**：官方工作流 JSON 的每个 Load 节点都记了相对路径，照抄就能直接跑。
2. **真正把"一套"绑在一起的是配套工作流 JSON，不是文件夹**：建个自己的工作流收藏目录，每套模型配一份官方模板，比任何文件夹归类都可靠。
3. **子文件夹/文件名用英文小写+下划线**，别用中文和空格，防插件路径坑。

> 用词提醒：Qwen / Z-Image / Flux 这类新架构**没有 Checkpoint**——Checkpoint 特指 SD1.5/SDXL 的三合一打包文件。新架构的"一套"叫**三件套**：diffusion model + text encoder + VAE（+ 可选 LoRA）。

---

## 十三、GGUF 是什么？——"文件格式"和"模型类型"是两回事

**真实案例**：`qwen-v23-diffusion-NVFP4.gguf` 被放进 `models/checkpoints/`，结果任何加载节点的下拉列表里都不出现，"无法加载"。

### 13.1 一句话分清两个概念

- **类型**（画家/翻译官/冲印店）决定**住哪个目录**：diffusion_models、text_encoders、vae……
- **格式**（.safetensors / .gguf）决定**用哪个加载节点**：
  - `.safetensors` = 原生格式 → 用 ComfyUI 自带的 Load Diffusion Model / CLIP Loader
  - `.gguf` = 社区量化格式（4bit/8bit，省显存，适合小显卡）→ **必须**用 ComfyUI-GGUF 插件的 **Unet Loader (GGUF)** / **CLIP Loader (GGUF)**

两个都错位就"人间蒸发"：GGUF 放进 checkpoints 目录 = 原生加载器不认这个格式、GGUF 加载器不扫这个目录，**两头都不认**。

### 13.2 GGUF 各类型的正确住址（来自 ComfyUI-GGUF 插件源码）

| GGUF 文件 | 正确目录 | 加载节点 |
|---|---|---|
| 画家（diffusion/unet） | `models/diffusion_models/` 或 `models/unet/` | Unet Loader (GGUF) |
| 翻译官（text encoder/clip） | `models/text_encoders/` 或 `models/clip/` | CLIP Loader (GGUF)，type 按家族选（如 qwen_image） |
| 冲印店（vae） | 一般不做成 GGUF，safetensors 直接用 | Load VAE |

> checkpoints 目录只属于 SD1.5/SDXL 老架构的"三合一"文件——新架构三件套（无论 safetensors 还是 GGUF）永远不进 checkpoints。

### 13.3 排查口诀：模型在节点列表里"消失"了

1. 查**目录**住对了没（对照上一节目录表）
2. 查**格式**配的加载器对不对（.gguf 就找带 GGUF 字样的节点）
3. 都对还看不见 → 重启 ComfyUI（目录缓存）

### 13.4 进阶坑：加载工作流后节点报"模型缺失"（红色）

**真实案例**：下载了官方/社区的 Qwen-Image-Edit 工作流，明明模型都放进去了，节点还是一片红说找不到模型。

**原理**：工作流 JSON 里**写死了模型文件的精确文件名**。官方模板写的是 `qwen_image_edit_2509_fp8_e4m3fn.safetensors`，你下载的叫 `Qwen-Image-Edit-2509-Q4_K_M.gguf`——ComfyUI **不做模糊匹配**，名字对不上就报缺失。

**解决**（二选一）：
1. **点红色节点的文件下拉框**，手动选中你实际拥有的文件（下拉列表 = 该目录下真实存在的文件）——推荐，永不过时
2. 把你的文件**重命名**成工作流要求的名字——适合不想逐个点的情况

**特别注意**：`.gguf` 格式的模型对**原生加载节点**（Load Diffusion Model / CLIP Loader）完全隐形——它只认 `.safetensors`。GGUF 必须换成带 "GGUF" 字样的节点（Unet Loader (GGUF) 等）。反之，`.safetensors` 的文本编码器要用原生 CLIPLoader（type 选 qwen_image），不能用 CLIPLoaderGGUF。

**一图记住对应关系**：
```
Qwen-Image-Edit-2509-Q4_K_M.gguf        → Unet Loader (GGUF)      [diffusion_models]
qwen_2.5_vl_7b_fp8_scaled.safetensors   → CLIPLoader (原生)        [text_encoders, type=qwen_image]
Qwen-Image-Edit-2509-Lightning-*.safetensors → LoraLoaderModelOnly [loras]
qwen_image_vae.safetensors              → Load VAE                [vae]
```

---

## 十四、实战案例：黑图之谜——一次教科书级的排障全过程

> 这是本指南写作时的**真实排查记录**：Qwen 三件套（GGUF 版）加载一切正常、采样正常跑完、最后存出**纯黑图片**。真相远比想象的深——模型文件本身是坏的。整个过程展示了"分层排除法"的完整用法。

### 14.1 黑图的两种典型原因（先背下来）

| 现象 | 原因 | 排查 |
|---|---|---|
| 图全黑但流程不报错 | **VAE 不匹配**（画家画得好好的，冲印店把底片洗黑了） | 换正确配套 VAE |
| 图全黑 + 输出文件异常小（10KB 级） | **潜空间全是 NaN**（画家疯了，草稿纸上是"非数字"） | 见下文 |

判断方法：用 Python/PIL 看输出图的**像素标准差**。真图 std 通常 40~80；纯黑图 std=0。文件大小也是信号：1328×1328 的真 PNG 约 1~3MB，纯黑图只有几 KB。

### 14.2 分层排除法：一层一层把嫌疑人排掉

```
黑图
 ├─ 翻译官(TE)出问题？ → 单独跑文本编码：输出 std 正常 ✓ 排除
 ├─ 冲印店(VAE)出问题？ → 用随机噪声喂 VAE：能解出正常图 ✓ 排除
 ├─ 采样器/调度器问题？ → 换参数、换时间步：照样全 NaN ✓ 排除
 └─ 画家(DiT)本身疯了？ → 挂钩子逐层探测：第 0 层 img_mod 就爆出 1e36，第一层注意力就 NaN ✗ 锁定！
```

### 14.3 深挖：权重解剖发现"惊天真相"

对画家的**权重数值本身**做体检（解量化后算统计量），发现所有权重都离谱到荒谬（std=260，正常应 ~0.02-0.2）。更惊人的是：**连未经量化的 F32 偏置（bias）都是天文数字**——F32 数据根本不经过任何解量化代码，直接从文件读的！

**结论：不是算法错，是文件里的数据根本没读对位置。**

### 14.4 真凶落网：全体张量偏移 5 字节

用十六进制直接解剖文件，发现真实权重值（0.172、0.031…典型 bias 分布）出现在**声称位置 +5 字节**处。三条铁证：

1. **文件头/中部/尾部的 F32 与 NVFP4 张量，全部 +5 才能读出正常权重**（NVFP4 的 36 字节块对错位极其敏感，+4 是垃圾、+5 完美——排除了一切巧合）
2. 文件大小比张量表声称的总跨度**恰好多 5 字节**
3. 量化文件转换工具在数据段开头插入了 5 字节却**忘记更新 1934 个张量的偏移字段**

**修复方式**（没有重下 11GB，没有复制文件）：张量信息表就在文件头部几百 KB 里，写脚本把每个 offset 字段原位 +5，原始值备份成 `*.offsets.bak.json`（十几 KB，可随时回滚）。修复后：数据区间与文件大小精确吻合，全部权重统计正常，DiT 前向零 NaN。

**成果**：同一份工作流、同一颗随机种子，98 秒后输出 2.27MB 的真图。

### 14.5 这个案例教给我们的事

1. **"官方下载、别人能用"不等于文件没毛病**——转换工具的 bug 会原样传递给每个下载者。
2. **黑图 ≠ 玄学**，永远可以从"翻译官→冲印店→画家"的流水线逐层验证，每层都能单独测试。
3. **权重统计是最底层的体检**：正常神经网络权重 std ≈ 0.01~0.5、绝对值 < 5。数字离谱 = 模型废，与提示词无关。
4. 遇到社区量化版（尤其 NVFP4 这类新格式）集体黑图时，先怀疑**文件**，再怀疑自己。
5. 修复脚本保留在 `Desktop\DSH\fix_gguf_offsets.py`；备份在模型同目录 `qwen-v23-diffusion-NVFP4.gguf.offsets.bak.json`。

### 14.6 加分题：画质调优配方（同模型出图质量翻倍的三板斧）

修好文件只是"能出图"，画质还想再上一个台阶，按这个顺序调：

| 顺序 | 调什么 | 怎么调 | 实测效果 |
|---|---|---|---|
| ① | **提示词长度** | Qwen 系模型按长文案训练，要像写作文：主体+姿态+环境+光线+镜头+色调。加"色调自然通透、色彩真实"压制艳俗感 | 饱和度 52%→40%（回到健康区） |
| ② | **采样器用官方配方** | 加速版(Rapid)模型：`sa_solver` + `beta` 调度器、CFG=1、步数 4~12 | 锐度 664→935 |
| ③ | **步数细节** | 同一构图觉得细节熔毁（毛发/水花糊成团），从 8 步加到 12 步试试 | 锐度 916→1032 |

**量化档位的物理天花板**：NVFP4 = 4-bit 压缩，是"20B 模型塞进 16GB 显存"的妥协。修好文件、调好参数后细节仍崩坏 → 不是你的问题，是精度档位上限。出路：同模型的 Q5/Q8 量化版（更精确但更慢/更占显存）、或换原生小模型。

**画质客观自检**（不用肉眼猜）：`image_quality_diag.py` 一键测锐度/对比度/饱和度/噪点，健康基线：锐度>150、对比 40~90、饱和 15~45%、毛刺<3。

---

## 附：一图流总览

```
你写的提示词 ──→ [文本编码器 翻译] ──→ 条件
                                        │
你的照片(图生图) → [VAE Encode 压缩] → 潜空间草稿 ─→ [扩散模型+KSampler 去噪] ←─ LoRA / ControlNet / IPAdapter 在此之前并入
                                        │                              (denoise 控制改多少)
                                        ↓
                            [VAE Decode 冲印] → 成品图 → [Upscaler 放大] / [FaceDetailer 修脸] → 保存
```

记住这条流水线，任何工作流拆开看，都只是在这条线上加零件。
