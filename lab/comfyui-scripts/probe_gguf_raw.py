# -*- coding: utf-8 -*-
"""底层 GGUF 解剖: 元数据 + 张量偏移 + 区间重叠检查 + 直接字节读取"""
import sys, os, struct
import numpy as np
import gguf

UNET = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"
TE   = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\text_encoders\text_encoder-NVFP4.gguf"

for path in [UNET, TE]:
    print(f"===== {os.path.basename(path)} =====")
    r = gguf.GGUFReader(path)
    print(f"  元数据字段: {list(r.fields.keys())}")
    if "general.alignment" in r.fields:
        print(f"  alignment = {r.fields['general.alignment'].parts}")
    print(f"  reader 内部 alignment = {r.alignment}")
    # 张量区间重叠检查
    spans = []
    for t in r.tensors:
        spans.append((t.data_offset, t.data_offset + t.n_bytes, t.name, str(t.tensor_type), t.shape))
    spans.sort()
    overlaps = []
    for i in range(len(spans) - 1):
        if spans[i][1] > spans[i+1][0]:
            overlaps.append((spans[i], spans[i+1]))
    print(f"  张量数={len(spans)}, 数据总区间=[{spans[0][0]}, {spans[-1][1]}] 文件大小={os.path.getsize(path)}")
    print(f"  重叠张量对数={len(overlaps)}")
    for a, b in overlaps[:5]:
        print(f"    重叠: {a[2]}[{a[0]}:{a[1]}] vs {b[2]}[{b[0]}:{b[1]}]")
    # 目标张量直接读取
    for want in (["img_in.bias", "img_in.weight"] if path == UNET else ["token_embd.weight"]):
        for t in r.tensors:
            if t.name == want:
                print(f"  {t.name}: type={t.tensor_type} shape={t.shape} n_bytes={t.n_bytes} data_offset={t.data_offset}")
                raw = bytes(t.data[:32])
                print(f"    前32字节hex: {raw.hex()}")
                if t.tensor_type == 0:
                    v = np.frombuffer(t.data, dtype=np.float32)
                    print(f"    as-f32: std={v.std():.4g} absmax={np.abs(v).max():.4g} 前4值={v[:4]}")
                elif t.tensor_type == 1:
                    v = np.frombuffer(t.data, dtype=np.float16)
                    print(f"    as-f16: std={v.std():.4g} absmax={np.abs(v).max():.4g} 前4值={v[:4]}")
                break
    # 检查 reader 的 data 段起点推断是否与手算一致
    print(f"  (对照) 第一个张量 {spans[0][2]} offset={spans[0][0]}")
    del r
