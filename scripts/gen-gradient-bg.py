#!/usr/bin/env python3
"""ch04 海底农场隧道背景生成器（2026-09-07，spec: docs/superpowers/specs/2026-09-07-ch04-tunnel-console-and-tagging.md）

纯色渐变 + 极少量元素，PIL 程序化生成，脚本参数即母带（可复跑调参）。
输出 1440×810 JPEG：
  tunnel-intro.jpg  观光隧道口：深海蓝外框 + 远处农场暖光漫出 + 一弯拱线
  tunnel-deep.jpg   农场内部：顶部灯带暖光域 → 水草绿中段 → 底部暗，四角暗角
  tunnel-vortex.jpg 漩涡变体：deep 压暗 + 暖光熄灭（危机时刻灯开始不稳）
"""
from PIL import Image, ImageDraw, ImageFilter
import math, os

W, H = 1440, 810
OUT = os.path.join(os.path.dirname(__file__), "../content/stories/ch04-hello757/backgrounds")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(w, h, stops):
    """竖向多段渐变 stops=[(pos0-1, (r,g,b)), ...]"""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                c = lerp(c0, c1, (t - p0) / max(p1 - p0, 1e-6))
                break
        else:
            c = stops[-1][1]
        for x in range(w):
            px[x, y] = c
    return img


def radial_glow(size, color, peak_alpha):
    """柔和径向光斑（中心亮向外消散）"""
    g = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(g)
    steps = 48
    for i in range(steps, 0, -1):
        r = size / 2 * i / steps
        a = int(peak_alpha * (1 - i / steps) ** 1.6)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=a)
    g = g.filter(ImageFilter.GaussianBlur(size / 10))
    layer = Image.new("RGBA", (size, size), color + (0,))
    layer.putalpha(g)
    return layer


def vignette(img, strength=120):
    """四角暗角，收拢管道感"""
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([-W * 0.25, -H * 0.25, W * 1.25, H * 1.25], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new("RGB", (W, H), (2, 6, 10))
    return Image.composite(img, dark, m.point(lambda v: 255 - (255 - v) * strength // 255))


def tunnel_intro():
    # 底：深海蓝竖向渐变（上稍亮 → 下压暗）
    img = vgrad(W, H, [(0.0, (24, 52, 74)), (0.55, (14, 34, 52)), (1.0, (7, 16, 26))])
    # 远处农场暖光：画面纵向中上、水平居中偏右，像隧道尽头漫出来的灯
    glow = radial_glow(1100, (245, 230, 200), 150)
    img.paste(glow, (int(W * 0.5 - 550), int(H * 0.30 - 550)), glow)
    core = radial_glow(520, (250, 240, 214), 120)
    img.paste(core, (int(W * 0.5 - 260), int(H * 0.30 - 260)), core)
    # 拱形结构线：一弯极淡的拱，暗示隧道口（只画上半弧）
    d = ImageDraw.Draw(img, "RGBA")
    d.arc([W * 0.18, H * 0.06, W * 0.82, H * 1.10], start=200, end=340, fill=(190, 215, 230, 46), width=10)
    d.arc([W * 0.24, H * 0.13, W * 0.76, H * 1.02], start=205, end=335, fill=(190, 215, 230, 26), width=6)
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    return vignette(img, 90)


def tunnel_deep():
    # 底：顶部暖白灯带 → 中段水草绿 → 底部暗
    img = vgrad(W, H, [
        (0.0, (214, 222, 200)),   # 灯带暖白（微粉绿的植物灯感）
        (0.22, (128, 158, 128)),
        (0.52, (42, 90, 74)),     # 水草绿
        (0.80, (16, 42, 40)),
        (1.0, (7, 18, 20)),
    ])
    # 顶部三条柔光带（模拟日照灯带的条带感，很淡）
    d = ImageDraw.Draw(img, "RGBA")
    for i, cx in enumerate((0.24, 0.5, 0.76)):
        band = radial_glow(560, (246, 238, 210), 66)
        img.paste(band, (int(W * cx - 280), int(-H * 0.16)), band)
    # 中央偏上主光域：收集物舞台光
    stage = radial_glow(1250, (240, 234, 205), 96)
    img.paste(stage, (int(W * 0.5 - 625), int(H * 0.30 - 625)), stage)
    img = img.filter(ImageFilter.GaussianBlur(1.0))
    return vignette(img, 130)


def tunnel_vortex():
    # 压暗变体：暖光近乎熄灭，整体沉入冷蓝黑
    img = tunnel_deep()
    cold = Image.new("RGB", (W, H), (4, 10, 18))
    img = Image.blend(img, cold, 0.62)
    return img


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fn in [("tunnel-intro", tunnel_intro), ("tunnel-deep", tunnel_deep), ("tunnel-vortex", tunnel_vortex)]:
        p = os.path.join(OUT, f"{name}.jpg")
        fn().save(p, "JPEG", quality=80)
        print("✓", p, f"{os.path.getsize(p) // 1024}K")
