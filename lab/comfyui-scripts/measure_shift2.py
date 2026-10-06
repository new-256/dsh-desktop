# -*- coding: utf-8 -*-
"""用 reader 内部基址 + 签名扫描 + 多张量错位扫描, 一锤定音"""
import struct
import numpy as np
import gguf

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"

r = gguf.GGUFReader(PATH)
print(f"reader.data_offset (数据段基址) = {r.data_offset}")
print(f"reader.alignment = {r.alignment}")

tmap = {t.name: t for t in r.tensors}
bias = tmap["img_in.bias"]
print(f"img_in.bias: data_offset字段={bias.field.parts[-1][0]}, 绝对位置={bias.data_offset}, n_bytes={bias.n_bytes}")

f = open(PATH, "rb")
# 签名: 0.1733, 0.03125, 0.0400, 0.0475
sig = bytes.fromhex("0000303e" + "0000003d" + "0000203d" + "0000403d")
f.seek(0)
CH = 1 << 22
pos = 0
hits = []
while True:
    chunk = f.read(CH)
    if not chunk: break
    idx = chunk.find(sig)
    while idx >= 0:
        hits.append(pos + idx)
        idx = chunk.find(sig, idx + 1)
    pos += len(chunk)
    if len(hits) > 3: break
print(f"签名命中绝对位置: {hits[:4]}")
for h in hits[:2]:
    print(f"  hit={h}: 相对声称位置偏差 = {h - bias.data_offset - 4} (按首值为0.0) 或 {h - bias.data_offset} (签名为首值)")

# 多张量错位扫描
def f32_scan(name, maxn=4096):
    t = tmap[name]
    n = min(t.n_elements, maxn)
    res = []
    for s in range(-8, 9):
        f.seek(t.data_offset + s)
        v = np.frombuffer(f.read(n * 4), dtype=np.float32)
        if len(v) < n: continue
        std, amax = v.std(), np.abs(v).max()
        if np.isfinite(v).all() and 0.001 < std < 2.0 and amax < 5.0:
            res.append((s, round(float(std), 4), round(float(amax), 4)))
    print(f"  {name} (声称offset={t.field.parts[-1][0]}): 可行偏移 {res}")

print("=== F32 错位扫描 ===")
for name in ["img_in.bias", "proj_out.bias", "norm_out.linear.bias",
             "transformer_blocks.30.img_mod.1.bias", "transformer_blocks.59.txt_mod.1.bias",
             "time_text_embed.timestep_embedder.linear_1.bias"]:
    try: f32_scan(name)
    except KeyError: print(f"  [缺] {name}")

# NVFP4 错位扫描
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

def nvfp4_scan(name, nrows=1024):
    t = tmap[name]
    res = []
    for s in range(0, 6):
        f.seek(t.data_offset + s)
        blocks = np.frombuffer(f.read(nrows * 36), dtype=np.uint8).reshape(nrows, 36)
        d, qs = blocks[:, :4], blocks[:, 4:]
        scale = LS[d.reshape(-1)].reshape(nrows, 4, 1)
        vals = LV[qs.reshape(-1)].reshape(nrows, 4, 8, 2).transpose(0,1,3,2).reshape(nrows, 4, 16)
        w = (scale * vals).reshape(nrows, 64)
        res.append((s, round(float(w.std()), 4), round(float(np.abs(w).max()), 3)))
    print(f"  {name}: " + " | ".join(f"s={s}:std={st},absmax={am}" for s, st, am in res))

print("=== NVFP4 错位扫描 (正常权重 std 应 ~0.02-0.05, absmax < 2) ===")
nvfp4_scan("img_in.weight")
nvfp4_scan("transformer_blocks.30.img_mlp.net.0.proj.weight")
f.close()
