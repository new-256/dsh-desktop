# -*- coding: utf-8 -*-
"""验证 v3:块级位级对比(只针对 NVFP4 张量) + GPU 速度基准 + TE/UNet 完整加载"""
import sys, os, types, importlib, traceback, time
from collections import Counter
import torch

COMFY = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI"
PLUG  = os.path.join(COMFY, "custom_nodes", "ComfyUI-GGUF")
TE    = os.path.join(COMFY, "models", "text_encoders", "text_encoder-NVFP4.gguf")
UNET  = os.path.join(COMFY, "models", "diffusion_models", "qwen-v23-diffusion-NVFP4.gguf")

sys.path.insert(0, COMFY)
os.chdir(COMFY)

pkg = types.ModuleType("ComfyUI_GGUF")
pkg.__path__ = [PLUG]
sys.modules["ComfyUI_GGUF"] = pkg

def step(msg):
    print(f"\n=== {msg} ===", flush=True)

try:
    step("导入")
    import gguf
    loader = importlib.import_module("ComfyUI_GGUF.loader")
    nodes_mod = importlib.import_module("ComfyUI_GGUF.nodes")
    import ComfyUI_GGUF.dequant as dq
    import comfy.sd
    NVFP4 = gguf.GGMLQuantizationType.NVFP4
    assert NVFP4 in dq.dequantize_functions, "NVFP4 快速路径未注册!"

    step("1/5 统计两文件的量化类型分布")
    te_sd, _ = loader.gguf_sd_loader(TE, is_text_model=True)
    un_sd, _ = loader.gguf_sd_loader(UNET)
    def qstat(sd, tag):
        c = Counter(getattr(v.tensor_type, "name", "?") for v in sd.values())
        print(f"    {tag}: " + ", ".join(f"{k} x{v}" for k, v in c.most_common()))
    qstat(te_sd, "TE ")
    qstat(un_sd, "UNet")

    step("2/5 块级位级对比: torch 移植 vs numpy 权威 (NVFP4 张量)")
    te_nv = [t for t in te_sd.values() if t.tensor_type == NVFP4]
    un_nv = [t for t in un_sd.values() if t.tensor_type == NVFP4]
    print(f"    NVFP4 张量: TE {len(te_nv)} 个, UNet {len(un_nv)} 个")
    checks = (te_nv[:4] + un_nv)[:12]
    max_diff_all, checked = 0.0, 0
    for t in checks:
        raw = t.data.view(torch.uint8).flatten()
        n_blocks = raw.numel() // 36
        blocks = raw[: n_blocks * 36].reshape(n_blocks, 36)
        torch_out = dq.dequantize_blocks_NVFP4(blocks, 64, 36, dtype=torch.float32)
        np_ref = torch.from_numpy(gguf.quants.NVFP4.dequantize_blocks(blocks.cpu().numpy()))
        d = (torch_out - np_ref).abs().max().item()
        max_diff_all = max(max_diff_all, d)
        checked += 1
    print(f"    {checked} 个张量、共 {sum(1 for _ in checks)} 项, 最大差异 = {max_diff_all}")
    assert max_diff_all < 1e-6, "存在位级不一致!"

    step("3/5 GPU 反量化速度基准 (UNet 最大 NVFP4 张量)")
    big = max(un_nv, key=lambda t: t.numel())
    raw = big.data.view(torch.uint8).flatten()
    n_blocks = raw.numel() // 36
    blocks_cuda = raw[: n_blocks * 36].reshape(n_blocks, 36).cuda()
    oshape = tuple(big.tensor_shape)
    torch.cuda.synchronize(); t0 = time.time()
    for _ in range(5):
        out = dq.dequantize(blocks_cuda, NVFP4, oshape, dtype=torch.bfloat16)
    torch.cuda.synchronize()
    dt_torch = (time.time() - t0) / 5
    nv_bytes = sum(t.data.view(torch.uint8).numel() for t in un_nv)
    thr = (raw.numel() / 1e9) / dt_torch
    est_step = (nv_bytes / 1e9) / thr
    print(f"    最大张量 {raw.numel()/1e6:.0f}MB, 单次反量化 {dt_torch*1000:.1f}ms")
    print(f"    GPU 吞吐 {thr:.1f} GB/s; UNet NVFP4 总量 {nv_bytes/1e9:.1f}GB → 每采样步反量化约 {est_step:.1f}s")
    t0 = time.time()
    _ = gguf.quants.NVFP4.dequantize_blocks(blocks_cuda[: n_blocks // 4].cpu().numpy())
    dt_np = time.time() - t0
    print(f"    对照: numpy 处理 1/4 同量数据 {dt_np:.1f}s → 全量约 {dt_np*4:.1f}s")

    step("4/5 TE 完整加载 + 前向推理")
    t0 = time.time()
    sd = loader.gguf_clip_loader(TE)
    clip = nodes_mod.CLIPLoaderGGUF.load_patcher(None, [TE], comfy.sd.CLIPType.QWEN_IMAGE, [sd])
    print(f"    加载通过! {time.time()-t0:.1f}s")
    t0 = time.time()
    tokens = clip.tokenize("a cat sitting on a beach")
    cond = clip.encode_from_tokens(tokens)
    print(f"    前向通过! shape={tuple(cond.shape)}, 耗时 {time.time()-t0:.1f}s")

    step("5/5 UNet 完整加载")
    t0 = time.time()
    from ComfyUI_GGUF.ops import GGMLOps
    model = comfy.sd.load_diffusion_model_state_dict(un_sd, model_options={"custom_operations": GGMLOps()})
    from ComfyUI_GGUF.nodes import GGUFModelPatcher
    model = GGUFModelPatcher.clone(model)
    print(f"    通过! MODEL = {type(model).__name__}, 耗时 {time.time()-t0:.1f}s")

    print("\n" + "=" * 52)
    print("v3 全部通过: 位级一致 + GPU 加速 + 两模型完整加载")
    print("=" * 52)
except Exception:
    print("\n!!!!! 测试失败 !!!!!")
    traceback.print_exc()
    sys.exit(1)
