# -*- coding: utf-8 -*-
"""黑图诊断 v2: B=VAE(5D噪声) C=完整采样(逐步数值+shift对照)"""
import sys, os, types, importlib, time
import numpy as np
import torch

COMFY = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI"
PLUG  = os.path.join(COMFY, "custom_nodes", "ComfyUI-GGUF")
TE    = os.path.join(COMFY, "models", "text_encoders", "text_encoder-NVFP4.gguf")
VAE_P = os.path.join(COMFY, "models", "vae", "vae.safetensors")
UNET  = os.path.join(COMFY, "models", "diffusion_models", "qwen-v23-diffusion-NVFP4.gguf")

sys.path.insert(0, COMFY)
os.chdir(COMFY)
pkg = types.ModuleType("ComfyUI_GGUF")
pkg.__path__ = [PLUG]
sys.modules["ComfyUI_GGUF"] = pkg

import comfy.utils
import comfy.sd
import comfy.sample
import comfy.model_sampling
loader = importlib.import_module("ComfyUI_GGUF.loader")
gguf_nodes = importlib.import_module("ComfyUI_GGUF.nodes")

PROMPT = "一只戴着墨镜的橘猫坐在木质冲浪板上乘风破浪"
from PIL import Image

def tstat(name, t):
    t = t.float()
    print(f"    {name}: shape={tuple(t.shape)} NaN={torch.isnan(t).sum().item()} "
          f"mean={t.mean().item():.4f} std={t.std().item():.4f} absmax={t.abs().max().item():.3f}")

def save_img(t, path):
    a = t.float().cpu()
    if a.ndim == 5:
        a = a[0, 0]                    # (b,t,h,w,c) -> (h,w,c)
    elif a.ndim == 4:
        a = a[0].permute(1, 2, 0)      # (b,c,h,w) -> (h,w,c)
    if a.ndim == 3 and a.shape[0] in (1, 3, 16) and a.shape[-1] not in (1, 3):
        a = a.permute(1, 2, 0)
    a = a.clamp(-1, 1).numpy()
    Image.fromarray(((a + 1) * 127.5).astype(np.uint8)).save(path)

print("=== 准备: TE 条件 ===")
te_sd = loader.gguf_clip_loader(TE)
clip = gguf_nodes.CLIPLoaderGGUF.load_patcher(None, [TE], comfy.sd.CLIPType.QWEN_IMAGE, [te_sd])
conds = clip.encode_from_tokens_scheduled(clip.tokenize(PROMPT))
neg = clip.encode_from_tokens_scheduled(clip.tokenize("低质量，模糊"))
tstat("正向条件", conds[0][0])
del te_sd, clip
import comfy.model_management
comfy.model_management.soft_empty_cache()

print("=== B. VAE 解码随机噪声 5D (应得噪点图而非黑图) ===")
vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(VAE_P, safe_load=True))
z = torch.randn(1, 16, 1, 166, 166, dtype=torch.bfloat16)
with torch.no_grad():
    img = vae.decode(z)
print(f"    解码输出: shape={tuple(img.shape)} NaN={torch.isnan(img.float()).sum().item()} "
      f"std={img.float().std().item():.3f}")
save_img(img, r"C:\Users\lcl\Desktop\DSH\debug_vae_random.png")
print("    已存 debug_vae_random.png")
del z, img

print("=== C1. 完整采样(5D latent): euler/simple/cfg1.0 (复现黑图参数) ===")
gguf_ops = importlib.import_module("ComfyUI_GGUF.ops")
un_sd, _ = loader.gguf_sd_loader(UNET)
model = comfy.sd.load_diffusion_model_state_dict(un_sd, model_options={"custom_operations": gguf_ops.GGMLOps()})
patcher = gguf_nodes.GGUFModelPatcher.clone(model)
del un_sd
latent = torch.zeros((1, 16, 1, 166, 166), dtype=torch.bfloat16)
noise = comfy.sample.prepare_noise(latent, 888888)

def cb(tag):
    def _cb(i, denoised, x, total_steps):
        d = denoised
        print(f"    [{tag}] step{i}/{total_steps}: denoised NaN={torch.isnan(d.float()).sum().item()} "
              f"mean={d.float().mean().item():.5f} std={d.float().std().item():.5f}")
    return _cb

t0 = time.time()
with torch.no_grad():
    out = comfy.sample.sample(
        patcher, noise, steps=8, cfg=1.0, sampler_name="euler", scheduler="simple",
        positive=conds, negative=neg, latent_image=latent, denoise=1.0,
        callback=cb("C1"), disable_pbar=True, seed=888888,
    )
lat = out["samples"]
tstat("C1 最终latent", lat)
print(f"    C1 采样耗时: {time.time()-t0:.0f}s")
with torch.no_grad():
    fin = vae.decode(lat)
print(f"    C1 解码: std={fin.float().std().item():.3f} min={fin.float().min().item():.2f} max={fin.float().max().item():.2f}")
save_img(fin, r"C:\Users\lcl\Desktop\DSH\debug_c1_default.png")

print("=== C2. Phr00t 官方参数: sa_solver/beta/cfg1.0 ===")
latent2 = torch.zeros((1, 16, 1, 166, 166), dtype=torch.bfloat16)
noise2 = comfy.sample.prepare_noise(latent2, 888888)
t0 = time.time()
with torch.no_grad():
    out2 = comfy.sample.sample(
        patcher, noise2, steps=8, cfg=1.0, sampler_name="sa_solver", scheduler="beta",
        positive=conds, negative=neg, latent_image=latent2, denoise=1.0,
        callback=cb("C2"), disable_pbar=True, seed=888888,
    )
lat2 = out2["samples"]
tstat("C2 最终latent", lat2)
print(f"    C2 采样耗时: {time.time()-t0:.0f}s")
with torch.no_grad():
    fin2 = vae.decode(lat2)
print(f"    C2 解码: std={fin2.float().std().item():.3f} min={fin2.float().min().item():.2f} max={fin2.float().max().item():.2f}")
save_img(fin2, r"C:\Users\lcl\Desktop\DSH\debug_c2_sa_solver.png")
print("=== 诊断完成 ===")
