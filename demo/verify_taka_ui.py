#!/usr/bin/env python3
"""结构断言：demo/taka.html 是否符合 UI spec。退出码 0 = 全部通过。"""
import re, sys

HTML = open("demo/taka.html", encoding="utf-8").read()
failures = []

def check(name, cond):
    if not cond:
        failures.append(name)

# --- token 完整性 ---
for tok in ["--bg-deep", "--bg-sea", "--bg-dialog", "--border",
            "--text-primary", "--text-secondary", "--accent-warm",
            "--accent-dim", "--choice-bg", "--choice-border",
            "--ok-green", "--low-orange"]:
    check(f"token {tok}", tok + ":" in HTML)

# --- 布局结构 ---
for frag in ['class="hud"', 'class="dialog"', 'class="choices"', 'class="speaker"']:
    check(f"dom {frag}", frag in HTML)
check('dom class="taka-figure"', re.search(r'class="taka-figure[ "]', HTML))

# --- 触控约束 ---
m = re.search(r"\.choices\s*\{[^}]*bottom:\s*(\d+)px", HTML)
check("选项离底边 >=24px", m and int(m.group(1)) >= 24)
check("按钮最小高度 40px", re.search(r"min-height:\s*40px", HTML))

# --- 暖黄面积约束：#ffb703 只允许出现在 eyeGrad / accent token / hover ---
warm_uses = [m.start() for m in re.finditer(r"#ffb703", HTML, re.I)]
check("暖黄使用处 <=4（token、渐变、高光、hover）", len(warm_uses) <= 4)

# --- SVG 立绘 ---
for frag in ['id="metalGrad"', 'id="eyeGrad"', 'id="nutRing"', 'id="rustNut"',
             'id="arms"', 'id="legs"', 'id="takaBody"', 'class="eyeGlow"']:
    check(f"svg {frag}", frag in HTML)

# --- 6 状态 class ---
for st in ["st-standby", "st-speaking", "st-thinking",
           "st-listening", "st-low", "st-off"]:
    check(f"state .{st}", f".{st}" in HTML)

# --- 形态红线：锈螺母只在 defs 定义一次（背视图/水下不出现第二个） ---
check("锈螺母唯一", HTML.count('id="rustNut"') == 1)

# --- 8 个场景都有 eyeState ---
scenes = ["start", "clean_branch", "surface", "ask_wind",
          "just_listen", "climax", "ending_a", "ending_b"]
for s in scenes:
    m = re.search(rf'\b{s}:\s*\{{[^}}]*?eyeState:\s*"(st-[a-z]+)"', HTML, re.S)
    check(f"scene {s} 有 eyeState", bool(m))
# --- ending_b 有 endState st-off ---
check("ending_b endState", re.search(r'ending_b:\s*\{[^}}]*?endState:\s*"st-off"', HTML, re.S))

# --- 竖屏降级 ---
check("竖屏 media query", "@media" in HTML and "portrait" in HTML)

if failures:
    print("FAIL:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: all checks passed")
