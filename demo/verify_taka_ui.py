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
# 选项锚定对话框顶边（bottom: calc(100%+12px)），且作为 dialog 子元素——
# 文本变长时选项随对话框顶边上移，永不被对话框盖住；
# 离底边 ≥24px 由对话框自身 bottom:24px 结构性保证。
check("选项锚定对话框顶边", re.search(r"\.choices\s*\{[^}]*bottom:\s*calc\(100%", HTML))
check("按钮最小高度 40px", re.search(r"min-height:\s*40px", HTML))

# choices 必须嵌在 dialog 内（防遮挡修复的结构断言）
from html.parser import HTMLParser
class _Nest(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.ok = False
    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if d.get("id") == "choices":
            self.ok = any(a.get("id") == "dialog" for a in self.stack)
        self.stack.append(d)
    def handle_endtag(self, tag):
        if self.stack:
            self.stack.pop()
_n = _Nest(); _n.feed(HTML)
check("choices 嵌套在 dialog 内", _n.ok)
check("对话框固定高度 + 内部滚动", re.search(r"\.dialog\s*\{[^}]*height:\s*\d+px", HTML) and re.search(r"\.story-text\s*\{[^}]*overflow-y:\s*auto", HTML))

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
scenes = ["prologue", "start", "clean_branch", "dream", "surface", "ask_wind",
          "just_listen", "climax", "ending_a", "ending_b"]
for s in scenes:
    m = re.search(rf'\b{s}:\s*\{{[^}}]*?eyeState:\s*"(st-[a-z]+)"', HTML, re.S)
    check(f"scene {s} 有 eyeState", bool(m))
# --- ending_b 有 endState st-off ---
check("ending_b endState", re.search(r'ending_b:\s*\{[^}}]*?endState:\s*"st-off"', HTML, re.S))

# --- 关机演出（spec §5/§7）：高光熄灭 + 缓缓过渡 ---
check("高光点有 eyeHi class", 'class="eyeHi"' in HTML)
check("关机态高光熄灭", re.search(r"\.st-off[^{]*\.eyeHi", HTML))
check("关机切换有 1.2s 过渡", re.search(r"(^|\n)\s*\.takaBody\s*\{[^}]*transition", HTML))

# --- 双模式（spec §4.4）：水下悬浮接入引擎 ---
check("takaBodySwim 已定义", 'id="takaBodySwim"' in HTML)
check("引擎支持 mode 切换", "setFigureMode" in HTML)
check("场景均标注 swim（本故事全程水下/海面悬浮）", HTML.count('mode: "swim"') >= 10)

# --- AI 场景生成（spec 2026-08-02）：设置面板 + 生成管线 + 降级 ---
for frag in ['id="settings-btn"', 'id="settings-panel"', 'id="sp-baseurl"',
             'id="sp-key"', 'id="sp-model"', 'id="sp-enabled"', 'id="ai-status"']:
    check(f"ai dom {frag}", frag in HTML)
check("设置存 localStorage", "taka_ai_settings" in HTML)
check("OpenAI chat/completions 格式", "chat/completions" in HTML)
check("15s 超时 AbortController", "AbortController" in HTML and "15000" in HTML)
check("SYSTEM_PROMPT 注入红线", "SYSTEM_PROMPT" in HTML and "红线" in HTML)
check("SYSTEM_PROMPT 注入身体设定", "没有嘴" in HTML and "螺旋桨" in HTML)
check("中段场景有 beats", HTML.count("beats:") >= 5)
check("中段场景标记 ai", HTML.count("ai: true") >= 5)
check("失败回退内置文案", "回退" in HTML)

# --- 自由输入选项 C（2026-08-02）：打字/语音，编织进骨架 ---
check("选项 C 输入框 UI", '"choice-input"' in HTML and "你选" in HTML)
check("语音输入 SpeechRecognition", "SpeechRecognition" in HTML)
check("4 个场景开启 freeInput（start/clean_branch/dream/surface）", HTML.count("freeInput: true") == 4)
check("无 AI 时留在页面不 fallback", "塔卡还听不懂" in HTML)
check("自定义失败留在页面不 fallback", "再选一次" in HTML and "ctx.generated" in HTML)
check("max_tokens 足够推理模型", re.search(r"max_tokens:\s*([5-9]\d\d|\d{4,})", HTML))
check("DeepSeek 压低推理强度防空正文", "reasoning_effort" in HTML)
check("选项朗读补自由输入提示", "说说你的想法" in HTML)
check("自定义选择必须生效规则", "必须生效" in HTML)

# --- 语音输出（spec 2026-08-02 voice）：speechSynthesis 零配置离线 ---
check("语音开关按钮", 'id="speech-btn"' in HTML)
check("speechSynthesis 调用", "speechSynthesis" in HTML and "SpeechSynthesisUtterance" in HTML)
check("声音列表异步加载", "onvoiceschanged" in HTML)
check("优先本地声音（离线）", "localService" in HTML)
check("语音偏好存 localStorage", "taka_speech" in HTML)
check("选项朗读开关", 'id="sp-readchoices"' in HTML and "speakChoices" in HTML)
check("切场景打断旧语音", "stopSpeech" in HTML)
check("长文本拆段朗读（防 Chrome 中断）", re.search(r'split\(/\\n\+/\)', HTML))
check("朗读前剔除引号字符", "cleanForSpeech" in HTML and "「」" in HTML)
check("角色声线配置（pitch/rate）", "CHAR_PROFILE" in HTML)
check("台词解析（塔卡说）", "parseParagraph" in HTML and "DIALOG_RE" in HTML)

# --- 竖屏降级 ---
check("竖屏 media query", "@media" in HTML and "portrait" in HTML)

if failures:
    print("FAIL:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: all checks passed")
