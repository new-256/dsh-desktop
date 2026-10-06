# -*- coding: utf-8 -*-
"""图片质量量化诊断: 锐度/对比/饱和/噪点"""
import numpy as np
from PIL import Image, ImageFilter

def metrics(path, label):
    img = Image.open(path).convert("RGB")
    # 统一到 1024 再算, 避免分辨率影响可比性
    img = img.resize((1024, 1024), Image.LANCZOS)
    a = np.asarray(img).astype(np.float32)
    gray = a.mean(axis=2)

    # 1. 锐度: 拉普拉斯方差 (越高越清晰)
    lap = (-4 * gray
           + np.roll(gray, 1, 0) + np.roll(gray, -1, 0)
           + np.roll(gray, 1, 1) + np.roll(gray, -1, 1))[2:-2, 2:-2]
    sharpness = lap.var()

    # 2. 对比度: 灰度标准差
    contrast = gray.std()

    # 3. 饱和度: RGB 通道间离散度
    mx = a.max(axis=2); mn = a.min(axis=2)
    saturation = ((mx - mn) / (mx + 1e-6)).mean() * 100

    # 4. 噪点感: 与中值滤波版的差异 (高频毛刺)
    med = np.asarray(Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.MedianFilter(3))).astype(np.float32)
    noise = np.abs(a - med).mean()

    # 5. 死区: 过曝/死黑像素占比
    dead = ((a.max(axis=2) >= 254) | (a.min(axis=2) <= 1)).mean() * 100

    print(f"{label}")
    print(f"   锐度(拉普拉斯方差): {sharpness:8.0f}   (清晰>150, 柔软 60~150, 糊 <60)")
    print(f"   对比度: {contrast:6.1f}   (健康 40~90)")
    print(f"   饱和度: {saturation:5.1f}%   (健康 15~45%)")
    print(f"   高频毛刺: {noise:6.2f}   (干净 <3, 多 3~8, 噪点重 >8)")
    print(f"   过曝/死黑: {dead:5.1f}%   (正常 <8%)")
    print()

O = r"D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\output"
metrics(O + r"\QwenTest_00004_.png", "① Qwen 文生图 (euler/simple 8步) —— 本次质疑对象")
metrics(O + r"\QwenImg2Img_00001_.png", "② Qwen 图生图 (denoise 0.55) —— 本次质疑对象")
metrics(O + r"\zimg_zimage_00001_.png", "③ 基线: Z-Image 模型 (本机其他模型)")
metrics(O + r"\nsfw_pony_smoke_00001_.png", "④ 基线: Pony SDXL (本机其他模型)")
