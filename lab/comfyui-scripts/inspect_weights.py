# -*- coding: utf-8 -*-
"""权重解剖: img_in / img_mod / time_text_embed 等前置层的三路对比"""
import sys, os, types, importlib
import numpy as np
import torch

COMFY = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI"
PLUG  = os.path.join(COMFY, "custom_nodes", "ComfyUI-GGUF")
UNET  = os.path.join(COMFY, "models", "diffusion_models", "qwen-v23-diffusion-NVFP4.gguf")

sys.path.insert(0, COMFY)
os.chdir(COMFY)
pkg = types.ModuleType("ComfyUI_GGUF")
pkg.__path__ = [PLUG]
sys.modules["ComfyUI_GGUF"] = pkg

import gguf
import comfy.sd
loader = importlib.import_module("ComfyUI_GGUF.loader")
gguf_nodes = importlib.import_module("ComfyUI_GGUF.nodes")
gguf_ops = importlib.import_module("ComfyUI_GGUF.ops")
import ComfyUI_GGUF.dequant as dq

NVFP4 = gguf.GGMLQuantizationType.NVFP4

print("=== 1. GGUF 原始张量(前置层) ===")
un_sd, _ = loader.gguf_sd_loader(UNET)
keys = [k for k in un_sd.keys() if ("img_in" in k or "txt_in" in k or "time_text_embed" in k
        or "blocks.0." in k or "norm_out" in k or "proj_out" in k)]
for k in sorted(keys):
    t = un_sd[k]
    tt = getattr(t, "tensor_type", None)
    print(f"    {k}: type={tt} shape={tuple(t.tensor_shape) if hasattr(t,'tensor_shape') else tuple(t.shape)}")

print("=== 2. 三路反量化对比(关键层) ===")
def stats(tag, x):
    x = x.float()
    print(f"    {tag}: zeros={100*(x==0).float().mean().item():.1f}% std={x.std().item():.4g} absmax={x.abs().max().item():.4g} mean={x.mean().item():.4g}")

for k in ["img_in.weight", "blocks.0.img_mod.weight", "blocks.0.scale_shift_table",
          "time_text_embed.timestep_embedder.linear_1.weight" if "time_text_embed.timestep_embedder.linear_1.weight" in un_sd else "time_text_embed.linear_1.weight"]:
    if k not in un_sd:
        # 模糊匹配
        cand = [kk for kk in un_sd if k.split(".")[-2] in kk and kk.split(".")[0] in ("blocks","time_text_embed","img_in","txt_in")]
        if not cand: 
            print(f"    [跳过 {k}: 不存在]"); continue
        k = cand[0]
    t = un_sd[k]
    if getattr(t, "tensor_type", None) not in (NVFP4,):
        w = t.float() if not hasattr(t, "tensor_type") else dq.dequantize_tensor(t, dtype=torch.float32)
        stats(f"{k} [{t.tensor_type}]", w)
        continue
    # 我的 LUT 路径
    mine = dq.dequantize_tensor(t, dtype=torch.float32)
    # numpy 权威参考
    raw = t.data.view(torch.uint8).flatten()
    nb = raw.numel() // 36
    blocks = raw[: nb * 36].reshape(nb, 36)
    ref = torch.from_numpy(gguf.quants.NVFP4.dequantize_blocks(blocks.numpy())).reshape(tuple(t.tensor_shape))
    diff = (mine - ref).abs().max().item()
    stats(f"{k} [我的LUT]", mine)
    stats(f"{k} [numpy参考]", ref)
    print(f"      最大差异={diff}")

print("=== 3. 加载进模型的实际参数 ===")
model = comfy.sd.load_diffusion_model_state_dict(un_sd, model_options={"custom_operations": gguf_ops.GGMLOps()})
dit = model.diffusion_model
for name, p in dit.named_parameters():
    if any(s in name for s in ["img_in", "img_mod", "scale_shift_table", "time_text_embed", "txt_in", "txt_mod"]):
        if "blocks.0." in name or "blocks.1." not in name:
            stats(f"model.{name}", p.data)
        if "blocks.5." in name:
            break
print("=== 完成 ===")
