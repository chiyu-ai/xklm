# -*- coding: utf-8 -*-
"""生成一张测试图（草地 + 4 只卡通鸡），用于验证摄像头识别链路"""
from PIL import Image, ImageDraw

W, H = 640, 400
img = Image.new("RGB", (W, H), "#7cb342")
d = ImageDraw.Draw(img)

# 草地纹理
for i in range(0, W, 40):
    d.line([(i, 0), (i + 20, H)], fill="#689f38", width=2)

# 4 只鸡（身体 + 头 + 喙 + 腿）
positions = [(110, 200), (250, 230), (390, 190), (520, 240)]
for (x, y) in positions:
    d.ellipse([x - 45, y - 30, x + 45, y + 30], fill="#a1887f", outline="#5d4037", width=3)
    d.ellipse([x + 30, y - 58, x + 66, y - 22], fill="#d7ccc8", outline="#5d4037", width=3)
    d.polygon([(x + 66, y - 42), (x + 88, y - 38), (x + 66, y - 32)], fill="#ef6c00")
    d.ellipse([x + 48, y - 48, x + 54, y - 42], fill="#212121")
    d.line([(x - 15, y + 28), (x - 15, y + 55)], fill="#ef6c00", width=4)
    d.line([(x + 15, y + 28), (x + 15, y + 55)], fill="#ef6c00", width=4)
    d.polygon([(x - 45, y - 10), (x - 70, y - 30), (x - 45, y + 5)], fill="#8d6e63")

img.save(r"D:\farm-test-image.png", "PNG")
print("saved: D:\\farm-test-image.png")
