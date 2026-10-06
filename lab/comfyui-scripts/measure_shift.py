# -*- coding: utf-8 -*-
"""测量 GGUF 数据偏移规律: 多张量错位扫描"""
import struct
import numpy as np

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"
ALIGN = 32

f = open(PATH, "rb")
HEAD = f.read(1 << 26)  # 64MB 头部缓冲(元数据+张量信息表足够)
f.seek(0)

def u64(off): return struct.unpack_from("<Q", HEAD, off)[0]
def u32(off): return struct.unpack_from("<I", HEAD, off)[0]

tc, kc = struct.unpack_from("<QQ", HEAD, 8)
off = 24
def read_str(off):
    n = u32(off)
    if u32(off + 4) == 0 and n > 0:
        n = u64(off)
        return HEAD[off+8:off+8+n].decode(), off + 8 + n
    return HEAD[off+4:off+4+n].decode(), off + 4 + n

def read_kv(off):
    key, off = read_str(off)
    t = u32(off); off += 4
    if t in (0, 1, 7): off += 1
    elif t in (2, 3): off += 2
    elif t in (4, 5, 6): off += 4
    elif t == 8: _, off = read_str(off)
    elif t == 9:
        et = u32(off); off += 4
        n = u64(off); off += 8
        sz = {0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}.get(et, 4)
        off += n * sz
    elif t in (10, 11, 12): off += 8
    return off

for _ in range(kc):
    off = read_kv(off)
print(f"KV 结束于 {off}")

tensors = []
for _ in range(tc):
    name, off = read_str(off)
    ttype = u32(off); off += 4
    nd = u32(off); off += 4
    dims = struct.unpack_from(f"<{nd}q", HEAD, off); off += 8 * nd
    toff = u64(off); off += 8
    tensors.append((name, ttype, dims, toff))
E = off
base = (E + ALIGN - 1) // ALIGN * ALIGN
print(f"张量信息表结束 E={E}, reader 数据基址 align{ALIGN}={base}")
fsize = f.seek(0, 2)
print(f"文件大小 {fsize}")

# reader 视角下各张量的绝对位置 = base + toff
tmap = {t[0]: t for t in tensors}
marker = tmap.get("__index_timestep_zero__")
if marker: print(f"标记张量: type={marker[1]} dims={marker[2]} offset={marker[3]}")

def f32_stats_at(abs_off, count, shift):
    f.seek(abs_off + shift)
    b = f.read(count * 4)
    v = np.frombuffer(b, dtype=np.float32)
    return v

print("\n=== F32 张量错位扫描 (寻找正常权重统计: |x|<5, std 0.005~1, 无巨值) ===")
targets = ["img_in.bias", "proj_out.bias", "norm_out.linear.bias",
           "transformer_blocks.30.img_mod.1.bias", "transformer_blocks.59.txt_mod.1.bias"]
for name in targets:
    if name not in tmap:
        print(f"  [缺] {name}"); continue
    _, ttype, dims, toff = tmap[name]
    n = int(np.prod(dims)) if dims else 1
    abs_off = base + toff
    good = []
    for s in range(-8, 9):
        v = f32_stats_at(abs_off, n, s)
        if len(v) < n: continue
        std = v.std(); amax = np.abs(v).max()
        if 0.001 < std < 2.0 and amax < 5.0 and np.isfinite(v).all():
            good.append((s, round(float(std), 4), round(float(amax), 4)))
    print(f"  {name} (n={n}, 声称offset={toff}): 可行偏移={good}")

print("\n=== NVFP4 张量错位扫描 (img_in.weight) ===")
import sys, os, types
sys.path.insert(0, r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI")
os.chdir(r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI")
import gguf
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

def dequant_nvfp4_at(abs_off, n_rows, shift):
    f.seek(abs_off + shift)
    blocks = np.frombuffer(f.read(n_rows * 36), dtype=np.uint8).reshape(n_rows, 36)
    d, qs = blocks[:, :4], blocks[:, 4:]
    scale = LS[d.reshape(-1)].reshape(n_rows, 4, 1)
    vals = LV[qs.reshape(-1)].reshape(n_rows, 4, 8, 2).transpose(0,1,3,2).reshape(n_rows, 4, 16)
    return (scale * vals).reshape(n_rows, 64)

name = "img_in.weight"
_, ttype, dims, toff = tmap[name]
n_rows = int(np.prod(dims))
abs_off = base + toff
for s in [0, 1, 2, 3, 4, 5]:
    w = dequant_nvfp4_at(abs_off, min(n_rows, 2048), s)
    print(f"  shift={s}: std={w.std():.4f} absmax={np.abs(w).max():.3f} zeros={100*(w==0).mean():.0f}%")

print("\n=== 末尾 F32 (proj_out.bias) 用 reader 视角核对 ===")
f.close()
