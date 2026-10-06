# -*- coding: utf-8 -*-
"""NVFP4 反量化变体基准赛: A=算术不分块, B=LUT(int64索引), B8=LUT(uint8直索引)"""
import sys, os, types, importlib, time
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
import ComfyUI_GGUF.dequant as dq
NVFP4 = gguf.GGMLQuantizationType.NVFP4

# ---------- 预计算 LUT (与 numpy 参考逐位一致) ----------
def _ue4m3_half(b):
    if b in (0x00, 0x7F):
        return np.float32(0.0)
    exp = (b >> 3) & 0xF
    man = np.float32(b & 7)
    if exp == 0:
        raw = man * np.float32(2.0 ** -9)
    else:
        raw = (np.float32(1.0) + man / np.float32(8.0)) * np.float32(2.0 ** (exp - 7))
    return (raw * np.float32(0.5)).astype(np.float32)

def build_luts():
    kv = np.array([0,1,2,3,4,6,8,12,0,-1,-2,-3,-4,-6,-8,-12], dtype=np.float32)
    lv = np.zeros((256, 2), dtype=np.float32)
    for b in range(256):
        lv[b, 0] = kv[b & 0x0F]
        lv[b, 1] = kv[(b >> 4) & 0x0F]
    ls = np.array([_ue4m3_half(b) for b in range(256)], dtype=np.float32)
    return torch.from_numpy(lv), torch.from_numpy(ls)

LUT_VALS_CPU, LUT_SCALE_CPU = build_luts()
_lut_cache = {}
def get_luts(device):
    key = str(device)
    if key not in _lut_cache:
        _lut_cache[key] = (LUT_VALS_CPU.to(device), LUT_SCALE_CPU.to(device))
    return _lut_cache[key]

# ---------- 变体实现 ----------
def var_A(blocks, dtype=torch.bfloat16):
    """算术版, 不分块"""
    n = blocks.shape[0]
    d_bytes, qs = torch.split(blocks.view(torch.uint8), [4, 32], dim=1)
    e = d_bytes.to(torch.int32)
    exp = (e >> 3) & 0xF
    man = (e & 0x7).to(torch.float32)
    raw = torch.where(exp == 0, man * (2.0 ** -9), (1.0 + man / 8.0) * torch.exp2(exp.to(torch.float32) - 7.0))
    scale = torch.where((d_bytes == 0) | (d_bytes == 0x7F), torch.zeros_like(raw), raw * 0.5).reshape(n, 4, 1)
    c = qs.reshape(n, 4, 8)
    nib = torch.cat((c & 0x0F, torch.bitwise_right_shift(c, 4)), dim=-1)
    mag_u8 = nib & 0x7
    mag = mag_u8.to(torch.float32)
    q = torch.bitwise_right_shift(mag_u8, 1).to(torch.float32)
    odd = (mag_u8 & 1).to(torch.float32)
    f = torch.where(mag < 4.0, mag, torch.exp2(q) * torch.where(odd > 0.0, 1.5, 1.0))
    sign = 1.0 - 2.0 * torch.bitwise_right_shift(nib, 3).to(torch.float32)
    out = (scale * (f * sign)).reshape(n, 64)
    return out.to(dtype) if dtype is not None else out

def var_B(blocks, dtype=torch.bfloat16):
    """LUT 版, int64 索引"""
    LUT_VALS, LUT_SCALE = get_luts(blocks.device)
    n = blocks.shape[0]
    u8 = blocks.view(torch.uint8)
    scale = LUT_SCALE[u8[:, :4].to(torch.int64)].reshape(n, 4, 1)
    vals = LUT_VALS[u8[:, 4:].to(torch.int64)].reshape(n, 4, 8, 2).permute(0, 1, 3, 2).reshape(n, 4, 16)
    out = (scale * vals).reshape(n, 64)
    return out.to(dtype) if dtype is not None else out

def var_B8(blocks, dtype=torch.bfloat16):
    """LUT 版, uint8 直索引"""
    LUT_VALS, LUT_SCALE = get_luts(blocks.device)
    n = blocks.shape[0]
    u8 = blocks.view(torch.uint8)
    scale = LUT_SCALE[u8[:, :4]].reshape(n, 4, 1)
    vals = LUT_VALS[u8[:, 4:]].reshape(n, 4, 8, 2).permute(0, 1, 3, 2).reshape(n, 4, 16)
    out = (scale * vals).reshape(n, 64)
    return out.to(dtype) if dtype is not None else out

# ---------- 准备真实张量 ----------
un_sd, _ = loader.gguf_sd_loader(UNET)
nv = [t for t in un_sd.values() if t.tensor_type == NVFP4]
big = max(nv, key=lambda t: t.numel())
raw = big.data.view(torch.uint8).flatten()
nb = raw.numel() // 36
blocks_cpu = raw[: nb * 36].reshape(nb, 36)
blocks = blocks_cpu.cuda()
oshape = tuple(big.tensor_shape)
ref_np = torch.from_numpy(gguf.quants.NVFP4.dequantize_blocks(blocks_cpu.numpy()))  # (nb, 64) fp32

print(f"张量: {raw.numel()/1e6:.0f}MB, {nb} 超块, 输出形状 {oshape}")
print(f"LUT_SCALE 抽查: byte 0x00={LUT_SCALE_CPU[0]:.6g} 0x28={LUT_SCALE_CPU[0x28]:.6g} 0x7F={LUT_SCALE_CPU[0x7F]:.6g}")

for name, fn in [("A 算术不分块", var_A), ("B LUT", var_B)]:
    try:
        out = fn(blocks, dtype=torch.float32)
        diff = (out.cpu() - ref_np).abs().max().item()
        # 计时
        for _ in range(3): fn(blocks, dtype=torch.bfloat16)
        torch.cuda.synchronize(); t0 = time.time()
        for _ in range(10): fn(blocks, dtype=torch.bfloat16)
        torch.cuda.synchronize()
        dt = (time.time() - t0) / 10
        gb_s = (raw.numel() / 1e9) / dt
        est = 11.5 / gb_s
        print(f"[{name}] 最大差异={diff:.2e}  单次={dt*1000:.1f}ms  吞吐={gb_s:.2f}GB/s  全模型每步≈{est:.1f}s")
    except Exception as ex:
        print(f"[{name}] 失败: {type(ex).__name__}: {ex}")
