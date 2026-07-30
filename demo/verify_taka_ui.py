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

if failures:
    print("FAIL:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: all checks passed")
