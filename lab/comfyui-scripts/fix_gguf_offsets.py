# -*- coding: utf-8 -*-
"""UNET GGUF 原位修复: 所有张量 offset 字段 +5 (附备份)"""
import json, struct, shutil
import numpy as np
import gguf

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"
BAK  = PATH + ".offsets.bak.json"
DELTA = 5

# 1. 用 reader 收集每个张量 offset 字段的绝对文件位置与当前值
r = gguf.GGUFReader(PATH)
patches = []  # (abs_pos, old_value)
for t in r.tensors:
    fld = t.field
    pos = fld.offset
    for part in fld.parts[:-1]:
        pos += part.nbytes
    # parts[-1] = offset_tensor (u64)
    old = int(fld.parts[-1][0])
    patches.append((pos, old, t.name))
    assert fld.parts[-1].nbytes == 8
print(f"收集到 {len(patches)} 个张量的 offset 字段位置")
print(f"首尾: {patches[0][2]} @ {patches[0][0]} (旧值 {patches[0][1]}); 最后 {patches[-1][2]} @ {patches[-1][0]} (旧值 {patches[-1][1]})")

# 2. 备份原始值
with open(BAK, "w") as fp:
    json.dump({"delta": DELTA, "patches": [[p, o, n] for p, o, n in patches]}, fp)
print(f"已备份原始值到 {BAK}")

# 3. 原位写入 old+DELTA
with open(PATH, "r+b") as fp:
    for pos, old, name in patches:
        fp.seek(pos)
        fp.write(struct.pack("<Q", old + DELTA))
print(f"已写入 {len(patches)} 个修正 (+{DELTA})")

# 4. 验证: 重新读取, 检查统计与区间
del r
r2 = gguf.GGUFReader(PATH)
tmap = {t.name: t for t in r2.tensors}
import os
spans = sorted((t.data_offset, t.data_offset + t.n_bytes) for t in r2.tensors)
fsize = os.path.getsize(PATH)
print(f"验证: 数据区间 [{spans[0][0]}, {spans[-1][1]}] vs 文件大小 {fsize} → {'✓ 吻合' if spans[-1][1] == fsize else '✗ 不吻合!'}")

f = open(PATH, "rb")
# F32 验证
t = tmap["img_in.bias"]
f.seek(t.data_offset)
v = np.frombuffer(f.read(t.n_bytes), dtype=np.float32)
print(f"img_in.bias 修复后: std={v.std():.4f} absmax={np.abs(v).max():.4f} 前4值={v[:4]}")

# NVFP4 验证 (numpy 参考)
KV = np.array([0,1,2,3,4,6,8,12,0,-1,-2,-3,-4,-6,-8,-12], dtype=np.float32)
LV = np.zeros((256, 2), dtype=np.float32)
for b in range(256):
    LV[b,0] = KV[b & 15]; LV[b,1] = KV[(b >> 4) & 15]
def ue4m3_half(b):
    if b in (0x00, 0x7F): return 0.0
    e = (b >> 3) & 0xF; m = b & 7
    raw = m * 2.0**-9 if e == 0 else (1.0 + m/8.0) * 2.0**(e-7)
    return raw * 0.5
LS = np.array([ue4m3_half(b) for b in range(256)], dtype=np.float32)
def dequant_check(name, nrows=1024):
    t = tmap[name]
    f.seek(t.data_offset)
    blocks = np.frombuffer(f.read(nrows * 36), dtype=np.uint8).reshape(nrows, 36)
    d, qs = blocks[:, :4], blocks[:, 4:]
    scale = LS[d.reshape(-1)].reshape(nrows, 4, 1)
    vals = LV[qs.reshape(-1)].reshape(nrows, 4, 8, 2).transpose(0,1,3,2).reshape(nrows, 4, 16)
    w = (scale * vals).reshape(nrows, 64)
    print(f"{name} 修复后: std={w.std():.4f} absmax={np.abs(w).max():.4f} zeros={100*(w==0).mean():.0f}%")
dequant_check("img_in.weight")
dequant_check("transformer_blocks.30.img_mlp.net.0.proj.weight")
dequant_check("transformer_blocks.59.txt_mlp.net.2.weight")
f.close()
print("=== 修复完成 ===")
