# -*- coding: utf-8 -*-
"""新下载 Q4_K_M 文件健康体检: F32张量统计 + 偏移合理性"""
import numpy as np
import gguf

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\Qwen-Image-Edit-2509-Q4_K_M.gguf"
r = gguf.GGUFReader(PATH)
f = open(PATH, "rb")
import os
fsize = os.path.getsize(PATH)

print(f"张量数={len(r.tensors)}, 数据基址={r.data_offset}, 文件大小={fsize}")

# 1. 区间检查: 张量表声称的跨度 vs 文件大小
spans = sorted((t.data_offset, t.data_offset + t.n_bytes) for t in r.tensors)
print(f"数据总区间 [{spans[0][0]}, {spans[-1][1]}] vs 文件大小 {fsize} → "
      + ("✓ 吻合(无偏移bug)" if spans[-1][1] == fsize else f"✗ 差 {fsize - spans[-1][1]} 字节!"))

# 2. F32 张量统计 (bias/norm)
bad = ok = 0
for t in r.tensors:
    if t.tensor_type == gguf.GGMLQuantizationType.F32 and t.n_bytes > 0:
        f.seek(t.data_offset)
        v = np.frombuffer(f.read(t.n_bytes), dtype=np.float32)
        if not np.isfinite(v).all() or np.abs(v).max() > 100 or v.std() > 20:
            bad += 1
        else:
            ok += 1
print(f"F32 张量: 健康 {ok}, 异常 {bad}")

# 3. Q4_K_M 权重抽查 (gguf-py 参考解量化)
tmap = {t.name: t for t in r.tensors}
checked = 0
for i in [0, 15, 30, 45, 59]:
    for suffix in ["img_attn_qkv.weight", "img_mlp.net.0.proj.weight"]:
        name = f"transformer_blocks.{i}.{suffix}"
        t = tmap.get(name)
        if t is None: continue
        f.seek(t.data_offset)
        nb = t.n_bytes // t.shape[0] if len(t.shape) == 2 else None
        # 逐行解量化前 64 行
        rows = min(64, t.shape[0])
        f.seek(t.data_offset)
        raw = f.read(t.n_bytes)
        w = gguf.dequantize(raw, t.tensor_type, min(64*64, int(np.prod(t.shape))))
        if w is not None:
            w = np.asarray(w, dtype=np.float32)
            tag = "✓" if (np.isfinite(w).all() and w.std() < 5 and np.abs(w).max() < 50) else "✗异常!"
            print(f"  {name}: std={w.std():.4f} absmax={np.abs(w).max():.3f} {tag}")
            checked += 1
print(f"Q4_K_M 抽查 {checked} 层完成")
f.close()
