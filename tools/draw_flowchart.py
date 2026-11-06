# -*- coding: utf-8 -*-
"""绘制养殖监测系统流程图（方框 + 箭头，非字符拼图）"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 1200
BG = "#ffffff"
SECTION_FILL = "#f4f8fd"
SECTION_BORDER = "#c8d8ea"
TEXT = "#1f2d3a"
SUBTEXT = "#5b6b7c"
ORANGE = "#e0762e"
BLUE = "#2f6fd0"
GREEN = "#2f9e5b"
PURPLE = "#8b5cf6"
GREY = "#8a97a6"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def pick_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


FONT_PATH = pick_font()


def font(size):
    if FONT_PATH:
        try:
            return ImageFont.truetype(FONT_PATH, size)
        except Exception:
            pass
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

F_TITLE = font(22)
F_BOX = font(19)
F_SUB = font(15)
F_TAG = font(16)
F_LABEL = font(15)


def center_text(draw, box, text, fnt, fill, dy=0):
    x0, y0, x1, y1 = box
    tw = draw.textlength(text, font=fnt)
    th = fnt.size
    draw.text(((x0 + x1 - tw) / 2, (y0 + y1 - th) / 2 + dy), text, font=fnt, fill=fill)


def box(draw, xy, w, h, title, sub=None, color=BLUE, fill="#ffffff"):
    x, y = xy
    draw.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=fill, outline=color, width=2)
    if sub:
        center_text(draw, (x, y + 6, x + w, y + h / 2 + 2), title, F_BOX, TEXT)
        lines = sub.split("\n")
        total = len(lines) * 20
        ty = y + h / 2 + 4 - total / 2 + 8
        for line in lines:
            tw = draw.textlength(line, font=F_SUB)
            draw.text((x + (w - tw) / 2, ty), line, font=F_SUB, fill=SUBTEXT)
            ty += 20
    else:
        center_text(draw, (x, y, x + w, y + h), title, F_BOX, TEXT)


def arrow(draw, p1, p2, color=GREY, width=3):
    import math
    x1, y1 = p1
    x2, y2 = p2
    draw.line([p1, p2], fill=color, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    L = 14
    a1 = ang + math.radians(155)
    a2 = ang - math.radians(155)
    draw.polygon([
        (x2, y2),
        (x2 + L * math.cos(a1), y2 + L * math.sin(a1)),
        (x2 + L * math.cos(a2), y2 + L * math.sin(a2)),
    ], fill=color)


def section(draw, xy, title, color):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle([x0, y0, x1, y1], radius=16, fill=SECTION_FILL, outline=SECTION_BORDER, width=2)
    draw.rounded_rectangle([x0 + 20, y0 - 2, x0 + 20 + 6, y1 - 2], radius=3, fill=color)
    draw.text((x0 + 38, y0 + 14), title, font=F_TITLE, fill=color)


# ============ ① 采集层 ============
section(d, (40, 40, 1560, 400), "① 采集层 · ESP32-S3 终端", ORANGE)

sensors = [
    "DHT11\n温湿度",
    "土壤湿度\n传感器",
    "光敏\n传感器",
    "火焰\n传感器",
    "JW01\n二氧化碳",
    "SC7A20H\n进食检测",
]
sw, sh, sy = 225, 60, 88
sx = 75
sensor_boxes = []
for i, name in enumerate(sensors):
    x = sx + i * (sw + 25)
    d.rounded_rectangle([x, sy, x + sw, sy + sh], radius=10, fill="#ffffff", outline=ORANGE, width=2)
    lines = name.split("\n")
    ty = sy + 12
    for line in lines:
        tw = d.textlength(line, font=F_TAG)
        d.text((x + (sw - tw) / 2, ty), line, font=F_TAG, fill=TEXT)
        ty += 20
    sensor_boxes.append((x, sy, x + sw, sy + sh))

# 汇聚总线
bus_y = 175
d.line([(100, bus_y), (1500, bus_y)], fill=ORANGE, width=2)
for (x0, y0, x1, y1) in sensor_boxes:
    cx = (x0 + x1) / 2
    d.line([(cx, y1), (cx, bus_y)], fill=ORANGE, width=2)

# ESP32
esp = (550, 235, 1050, 325)
d.rounded_rectangle(list(esp), radius=14, fill="#fff4ea", outline=ORANGE, width=3)
center_text(d, (esp[0], esp[1] + 8, esp[2], esp[1] + 52), "ESP32-S3 主控板（N16R8）", font(21), TEXT)
center_text(d, (esp[0], esp[1] + 48, esp[2], esp[3] - 6), "采集 · 逻辑判断 · WiFi 上报 · MJPEG 视频流", F_SUB, SUBTEXT)

arrow(d, (800, bus_y), (800, 235), ORANGE)

# 摄像头 / OLED
cam = (75, 230, 300, 315)
d.rounded_rectangle(cam, radius=12, fill="#ffffff", outline=ORANGE, width=2)
center_text(d, (cam[0], cam[1] + 6, cam[2], cam[1] + 46), "OV3660 摄像头", F_BOX, TEXT)
center_text(d, (cam[0], cam[1] + 42, cam[2], cam[3] - 2), "板载 FPC · 81 端口视频流", F_SUB, SUBTEXT)
arrow(d, (300, 272), (550, 272), ORANGE)

oled = (1300, 230, 1525, 315)
d.rounded_rectangle(oled, radius=12, fill="#ffffff", outline=ORANGE, width=2)
center_text(d, (oled[0], oled[1] + 6, oled[2], oled[1] + 46), "SSD1306 OLED", F_BOX, TEXT)
center_text(d, (oled[0], oled[1] + 42, oled[2], oled[3] - 2), "本地三页轮播显示", F_SUB, SUBTEXT)
arrow(d, (1300, 272), (1050, 272), ORANGE)

# ============ 传输 ============
arrow(d, (800, 325), (800, 500), BLUE, 4)
lbl = "WiFi 2.4GHz · HTTP POST /api/data · 每 1~3 秒"
tw = d.textlength(lbl, font=F_LABEL)
d.rounded_rectangle([800 - tw / 2 - 12, 395, 800 + tw / 2 + 12, 425], radius=8, fill="#eaf2fc", outline=BLUE, width=1)
d.text((800 - tw / 2, 398), lbl, font=F_LABEL, fill=BLUE)

# ============ ② 服务端 ============
section(d, (40, 470, 1560, 810), "② 服务端 · Node.js :3000（零第三方依赖）", BLUE)

srv = (600, 520, 1000, 600)
d.rounded_rectangle(list(srv), radius=14, fill="#eaf2fc", outline=BLUE, width=3)
center_text(d, (srv[0], srv[1] + 6, srv[2], srv[1] + 46), "Node.js 服务端", font(21), TEXT)
center_text(d, (srv[0], srv[1] + 42, srv[2], srv[3] - 2), "接口路由 · 数据持久化 · 智能体代理", F_SUB, SUBTEXT)

subs = [
    ("数据存储", "devices.json\n历史曲线 · 元数据", BLUE),
    ("SSE 实时推送", "/api/events\n秒级推送到页面", BLUE),
    ("本地知识库", "患病记录 · 查询记录\n预警 txt 归档", GREEN),
    ("扣子 Coze 智能体", "病因诊断 · 健康预警\n药品推荐", PURPLE),
]
subw, subh, suby = 330, 110, 650
for i, (t, s, c) in enumerate(subs):
    x = 75 + i * (subw + 35)
    d.rounded_rectangle([x, suby, x + subw, suby + subh], radius=12, fill="#ffffff", outline=c, width=2)
    center_text(d, (x, suby + 10, x + subw, suby + 50), t, F_BOX, TEXT)
    lines = s.split("\n")
    ty = suby + 56
    for line in lines:
        tw2 = d.textlength(line, font=F_SUB)
        d.text((x + (subw - tw2) / 2, ty), line, font=F_SUB, fill=SUBTEXT)
        ty += 20
    arrow(d, (800, 600), (x + subw / 2, suby), c if c != BLUE else BLUE, 2)

# ============ 应用到 Web ============
arrow(d, (800, 810), (800, 890), GREEN, 4)
lbl2 = "实时数据 + 诊断结果"
d.text((822, 818), lbl2, font=font(13), fill=GREEN)

# ============ ③ 应用层 ============
section(d, (40, 840, 1560, 1150), "③ 应用层 · Web 管理页面", GREEN)

web = (600, 880, 1000, 950)
d.rounded_rectangle(list(web), radius=14, fill="#e9f7ef", outline=GREEN, width=3)
center_text(d, (web[0], web[1] + 4, web[2], web[1] + 40), "Web 管理页面", font(20), TEXT)
center_text(d, (web[0], web[1] + 34, web[2], web[3] - 2), "登录 · 多设备 · 实时刷新", F_SUB, SUBTEXT)

feats = [
    ("实时监测", "指标卡片 · 趋势曲线"),
    ("AI 兽医问答", "个体档案 · 对话记忆"),
    ("健康预警", "病前 / 病中 / 病后"),
    ("养殖手册", "34 物种 · 市场行情"),
]
fw, fh, fy = 330, 90, 1010
for i, (t, s) in enumerate(feats):
    x = 75 + i * (fw + 35)
    d.rounded_rectangle([x, fy, x + fw, fy + fh], radius=12, fill="#ffffff", outline=GREEN, width=2)
    center_text(d, (x, fy + 10, x + fw, fy + 46), t, F_BOX, TEXT)
    tw3 = d.textlength(s, font=F_SUB)
    d.text((x + (fw - tw3) / 2, fy + 50), s, font=F_SUB, fill=SUBTEXT)
    arrow(d, (800, 950), (x + fw / 2, fy), GREEN, 2)

# 右上角标注
d.text((42, 1160), "养殖环境监测与智能诊断系统 · 整体流程图", font=font(17), fill=GREY)

out = r"D:\farm-flowchart.png"
img.save(out, "PNG")
print("saved:", out, img.size)
