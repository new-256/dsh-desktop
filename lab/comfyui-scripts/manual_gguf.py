# -*- coding: utf-8 -*-
"""手工解析 GGUF: 计算数据段真实起点, 定位偏移差值"""
import struct, os

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"
ALIGN = 32

f = open(PATH, "rb")
data = f.read(300000)  # 头部足够

magic = data[0:4]; ver = struct.unpack_from("<I", data, 4)[0]
tensor_count, kv_count = struct.unpack_from("<QQ", data, 8)
print(f"magic={magic} ver={ver} tensors={tensor_count} kvs={kv_count}")

def read_str(off):
    n = struct.unpack_from("<I", data, off)[0]
    s = data[off+4:off+4+n].decode("utf-8")
    return s, off + 4 + n

def read_kv(off):
    key, off = read_str(off)
    t = struct.unpack_from("<I", data, off)[0]; off += 4
    # 只处理标量类型
    if t == 0: v = struct.unpack_from("<B", data, off)[0]; off += 1
    elif t == 1: v = struct.unpack_from("<b", data, off)[0]; off += 1
    elif t == 2: v = struct.unpack_from("<H", data, off)[0]; off += 2
    elif t == 3: v = struct.unpack_from("<h", data, off)[0]; off += 2
    elif t == 4: v = struct.unpack_from("<I", data, off)[0]; off += 4
    elif t == 5: v = struct.unpack_from("<i", data, off)[0]; off += 4
    elif t == 6: v = struct.unpack_from("<f", data, off)[0]; off += 4
    elif t == 7: v = struct.unpack_from("<B", data, off)[0]; off += 1
    elif t == 8: v, off = read_str(off)
    elif t == 9:
        et = struct.unpack_from("<I", data, off)[0]; off += 4
        n = struct.unpack_from("<Q", data, off)[0]; off += 8
        v = f"[array t={et} n={n}]"; off += n * {4:4, 5:4, 6:4, 10:8, 11:8}.get(et, 4)
    elif t == 10: v = struct.unpack_from("<Q", data, off)[0]; off += 8
    elif t == 11: v = struct.unpack_from("<q", data, off)[0]; off += 8
    elif t == 12: v = struct.unpack_from("<d", data, off)[0]; off += 8
    else: raise ValueError(f"未知KV类型 {t} at {off}")
    return (key, v), off

off = 24
for _ in range(kv_count):
    kv, off = read_kv(off)
    print(f"  KV: {kv[0]} = {str(kv[1])[:60]}")
print(f"元数据结束于 {off}")

tensors = []
for _ in range(tensor_count):
    name, off = read_str(off)
    ttype = struct.unpack_from("<I", data, off)[0]; off += 4
    nd = struct.unpack_from("<I", data, off)[0]; off += 4
    dims = struct.unpack_from(f"<{nd}Q", data, off); off += 8 * nd
    toff = struct.unpack_from("<Q", data, off)[0]; off += 8
    tensors.append((name, ttype, dims, toff))
E = off
print(f"张量信息表结束于 E={E}, align{ALIGN}(E)={(E + ALIGN - 1)//ALIGN*ALIGN}")

# 找 img_in.bias 和它的相邻张量
for i, (name, ttype, dims, toff) in enumerate(tensors):
    if name in ("__index_timestep_zero__", "img_in.bias", "img_in.weight"):
        print(f"  [{i}] {name}: type={ttype} dims={dims} offset={toff}")

# 在文件中搜索真实 bias 字节签名 (0.1733, 0.03125, 0.0400, 0.0475 的 f32 LE 字节)
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
    if len(hits) > 5: break
print(f"签名绝对位置 hits: {hits[:6]}")
bias_off = [t for t in tensors if t[0] == "img_in.bias"][0][3]
base_reader = (E + ALIGN - 1) // ALIGN * ALIGN
for h in hits[:3]:
    print(f"  hit {h}: 真实数据基址 = {h - bias_off} (reader基址={base_reader}, 差={h - bias_off - base_reader})")
f.close()
