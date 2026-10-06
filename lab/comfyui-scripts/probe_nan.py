# -*- coding: utf-8 -*-
"""NaN 探针: 单次 DiT 前向, 钩子定位第一个非有限值的模块"""
import sys, os, types, importlib, time
import numpy as np
import torch

COMFY = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI"
PLUG  = os.path.join(COMFY, "custom_nodes", "ComfyUI-GGUF")
TE    = os.path.join(COMFY, "models", "text_encoders", "text_encoder-NVFP4.gguf")
UNET  = os.path.join(COMFY, "models", "diffusion_models", "qwen-v23-diffusion-NVFP4.gguf")

sys.path.insert(0, COMFY)
os.chdir(COMFY)
pkg = types.ModuleType("ComfyUI_GGUF")
pkg.__path__ = [PLUG]
sys.modules["ComfyUI_GGUF"] = pkg

import comfy.sd
import comfy.model_management
loader = importlib.import_module("ComfyUI_GGUF.loader")
gguf_nodes = importlib.import_module("ComfyUI_GGUF.nodes")
gguf_ops = importlib.import_module("ComfyUI_GGUF.ops")

print("=== 1. 准备条件向量 ===")
te_sd = loader.gguf_clip_loader(TE)
clip = gguf_nodes.CLIPLoaderGGUF.load_patcher(None, [TE], comfy.sd.CLIPType.QWEN_IMAGE, [te_sd])
conds = clip.encode_from_tokens_scheduled(clip.tokenize("一只橘猫"))
context = conds[0][0]
print(f"    context: shape={tuple(context.shape)} std={context.float().std().item():.3f}")
del te_sd, clip, conds
comfy.model_management.soft_empty_cache()

print("=== 2. 加载 DiT ===")
t0 = time.time()
un_sd, _ = loader.gguf_sd_loader(UNET)
model = comfy.sd.load_diffusion_model_state_dict(un_sd, model_options={"custom_operations": gguf_ops.GGMLOps()})
patcher = gguf_nodes.GGUFModelPatcher.clone(model)
del un_sd
dit = patcher.model.diffusion_model
cfg = patcher.model.model_config
print(f"    加载耗时 {time.time()-t0:.0f}s; unet_config={cfg.unet_config}")
print(f"    sampling_settings={cfg.sampling_settings}")

print("=== 3. 挂钩子并前向 (t=1.0) ===")
stats = []
def mk_hook(name):
    def hook(mod, inp, out):
        try:
            o = out[0] if isinstance(out, (tuple, list)) else out
            if isinstance(o, torch.Tensor) and o.numel() > 0:
                of = o.float()
                stats.append((name, o.__class__.__name__, torch.isnan(of).sum().item(),
                              torch.isinf(of).sum().item(), of.abs().max().item(), of.std().item()))
        except Exception:
            pass
    return hook

handles = []
for name, mod in dit.named_modules():
    handles.append(mod.register_forward_hook(mk_hook(name)))

device = comfy.model_management.get_torch_device()
x = torch.randn(1, 16, 1, 64, 64, dtype=torch.bfloat16, device=device)
t = torch.tensor([1.0], device=device)
ctx = context.to(device=device, dtype=torch.bfloat16)
t0 = time.time()
with torch.no_grad():
    out = dit(x, t, context=ctx)
dt = time.time() - t0
out_f = out.float() if isinstance(out, torch.Tensor) else torch.cat([o.float() for o in out if isinstance(o, torch.Tensor)])
print(f"    前向耗时 {dt:.1f}s; 输出: shape={tuple(out_f.shape)} NaN={torch.isnan(out_f).sum().item()} absmax={out_f.abs().max().item():.3f}")

print("=== 4. 分析: 第一个非有限值模块及其前后 ===")
first_bad = None
for i, (name, cls, nan, inf, absmax, std) in enumerate(stats):
    if nan > 0 or inf > 0 or (absmax == float('inf')):
        first_bad = i
        break
if first_bad is None:
    print("    没有任何模块输出 NaN/Inf !! (那问题在采样循环或后处理)")
else:
    lo = max(0, first_bad - 6)
    hi = min(len(stats), first_bad + 4)
    for i in range(lo, hi):
        name, cls, nan, inf, absmax, std = stats[i]
        mark = " >>>" if i == first_bad else "    "
        print(f"{mark} [{i}] {name} ({cls}) NaN={nan} Inf={inf} absmax={absmax:.4g} std={std:.4g}")

print("=== 5. transformer_blocks 激活增长曲线 ===")
for i, (name, cls, nan, inf, absmax, std) in enumerate(stats):
    if ".transformer_blocks." in name and name.endswith(("scale_shift_table" not in name, )[-1] if False else True):
        pass
bi = 0
for i, (name, cls, nan, inf, absmax, std) in enumerate(stats):
    import re
    m = re.search(r"transformer_blocks\.(\d+)\.norm1\.norm$", name)
    if m and bi < 60:
        print(f"    block{m.group(1):>3} 入口: absmax={absmax:.4g} std={std:.4g} NaN={nan}")
        bi += 1

print("=== 6. 时间步尺度对照 (t=1000) ===")
stats.clear()
with torch.no_grad():
    out2 = dit(x, torch.tensor([1000.0], device=device), context=ctx)
out2_f = out2.float() if isinstance(out2, torch.Tensor) else torch.cat([o.float() for o in out2 if isinstance(o, torch.Tensor)])
print(f"    t=1000 输出: NaN={torch.isnan(out2_f).sum().item()} absmax={out2_f.abs().max().item():.3f}")
fb = None
for i, (name, cls, nan, inf, absmax, std) in enumerate(stats):
    if nan > 0 or inf > 0:
        fb = i; break
if fb is not None:
    name, cls, nan, inf, absmax, std = stats[fb]
    print(f"    t=1000 第一个坏模块: [{fb}] {name} NaN={nan} absmax={stats[max(0,fb-1)][4]:.4g}(前一模块)")
for h in handles:
    h.remove()
print("=== 探针完成 ===")
