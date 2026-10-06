# -*- coding: utf-8 -*-
"""NVFP4 块内字节布局实验: 用 img_in.weight 的统计特征判定正确布局"""
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
loader = importlib.import_module("ComfyUI_GGUF.loader")

un_sd, _ = loader.gguf_sd_loader(UNET)
t = un_sd["img_in.weight"]
raw = t.data.view(torch.uint8).flatten().cpu()
nb = raw.numel() // 36
blocks = raw[: nb * 36].reshape(nb, 36).numpy()   # (nb, 36) uint8

# 参考: F32 偏置的统计特征(正常量级)
bias = un_sd["img_in.bias"].float()
print(f"参照 img_in.bias (F32): std={bias.std().item():.4f} absmax={bias.abs().max().item():.4f}")

KV = np.array([0,1,2,3,4,6,8,12,0,-1,-2,-3,-4,-6,-8,-12], dtype=np.float32)

def ue4m3_half(b):
    if b in (0x00, 0x7F): return np.float32(0.0)
    exp = (b >> 3) & 0xF; man = np.float32(b & 7)
    if exp == 0: raw_ = man * np.float32(2.0 ** -9)
    else: raw_ = (np.float32(1.0) + man / np.float32(8.0)) * np.float32(2.0 ** (exp - 7))
    return (raw_ * np.float32(0.5)).astype(np.float32)

LS = np.array([ue4m3_half(b) for b in range(256)], dtype=np.float32)
LV = np.zeros((256, 2), dtype=np.float32)
for b in range(256):
    LV[b, 0] = KV[b & 0x0F]; LV[b, 1] = KV[(b >> 4) & 0x0F]

def dequant_layout(blocks, mode):
    """mode: A=[4尺度][32数据] B=[32数据][4尺度] C=[1尺度][8数据]x4交错"""
    n = blocks.shape[0]
    if mode == "A":
        d, qs = blocks[:, :4], blocks[:, 4:]
        sub_d = d.reshape(n, 4, 1)
        sub_q = qs.reshape(n, 4, 8)
    elif mode == "B":
        qs, d = blocks[:, :32], blocks[:, 32:]
        sub_d = d.reshape(n, 4, 1)
        sub_q = qs.reshape(n, 4, 8)
    elif mode == "C":
        r = blocks.reshape(n, 4, 9)
        sub_d = r[:, :, :1]
        sub_q = r[:, :, 1:]
    vals = LV[sub_q.reshape(-1)].reshape(n, 4, 8, 2).transpose(0, 1, 3, 2).reshape(n, 4, 16)
    out = (sub_d.astype(np.float32) * vals).reshape(n, 64)
    return out

for mode in ["A", "B", "C"]:
    out = dequant_layout(blocks, mode)
    o = out.reshape(tuple(t.tensor_shape))
    print(f"布局{mode}: zeros={100*(o==0).mean():.1f}% std={o.std():.5f} absmax={np.abs(o).max():.4f} mean={o.mean():.5f}")

# 额外: 块内前4字节 vs 后4字节的分布特征(判断谁是尺度)
head4 = blocks[:, :4].reshape(-1)
tail4 = blocks[:, 32:].reshape(-1)
mid   = blocks[:, 4:32].reshape(-1)
for tag, arr in [("前4字节(头部)", head4), ("中间32字节", mid), ("后4字节(尾部)", tail4)]:
    u, c = np.unique(arr, return_counts=True)
    top = sorted(zip(u, c), key=lambda x: -x[1])[:4]
    print(f"  {tag}: 均值={arr.mean():.1f} 分布top4={top}")
