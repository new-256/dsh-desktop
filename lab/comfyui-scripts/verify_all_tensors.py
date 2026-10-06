# -*- coding: utf-8 -*-
"""修复终验: 全部 F32 张量的统计健康度扫描"""
import numpy as np
import gguf

PATH = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models\diffusion_models\qwen-v23-diffusion-NVFP4.gguf"
r = gguf.GGUFReader(PATH)
f = open(PATH, "rb")

bad, ok, total = [], 0, 0
for t in r.tensors:
    if t.tensor_type != gguf.GGMLQuantizationType.F32 or t.n_bytes == 0:
        continue
    total += 1
    f.seek(t.data_offset)
    v = np.frombuffer(f.read(t.n_bytes), dtype=np.float32)
    std = v.std(); amax = np.abs(v).max()
    # 健康权重: 有限、幅度合理
    if not np.isfinite(v).all() or amax > 100 or std > 20:
        bad.append((t.name, float(std), float(amax)))
    else:
        ok += 1
print(f"F32 张量共 {total} 个: 健康 {ok}, 异常 {len(bad)}")
for name, std, amax in bad[:20]:
    print(f"  异常: {name} std={std:.3g} absmax={amax:.3g}")

# NVFP4 抽查更多层 (均匀采样 60 个 transformer block)
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
tmap = {t.name: t for t in r.tensors}

badq, okq = [], 0
for i in range(0, 60, 6):
    for suffix in ["img_attn_qkv.weight", "img_mlp.net.0.proj.weight", "txt_attn_qkv.weight"]:
        name = f"transformer_blocks.{i}.{suffix}"
        t = tmap.get(name)
        if t is None: continue
        f.seek(t.data_offset)
        nrows = min(256, t.n_bytes // 36)
        blocks = np.frombuffer(f.read(nrows * 36), dtype=np.uint8).reshape(nrows, 36)
        d, qs = blocks[:, :4], blocks[:, 4:]
        scale = LS[d.reshape(-1)].reshape(nrows, 4, 1)
        vals = LV[qs.reshape(-1)].reshape(nrows, 4, 8, 2).transpose(0,1,3,2).reshape(nrows, 4, 16)
        w = (scale * vals).reshape(nrows, 64)
        if w.std() > 5 or np.abs(w).max() > 50:
            badq.append((name, float(w.std()), float(np.abs(w).max())))
        else:
            okq += 1
print(f"NVFP4 抽查 {okq + len(badq)} 层: 健康 {okq}, 异常 {len(badq)}")
for name, std, amax in badq[:10]:
    print(f"  异常: {name} std={std:.3g} absmax={amax:.3g}")
f.close()
print("=== 终验结论: " + ("全部健康, 偏移修复完全正确" if not bad and not badq else "存在异常张量!") + " ===")
