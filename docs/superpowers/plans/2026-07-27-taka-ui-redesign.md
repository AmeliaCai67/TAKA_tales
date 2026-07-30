# 塔卡 Demo UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（`docs/superpowers/specs/2026-07-27-taka-visual-novel-ui-design.md`）重写 `demo/taka.html` 的 UI 层：视觉小说式布局 + SVG 立绘 + 6 态灯光 + 配色 token，故事数据与分支逻辑保留。

**Architecture:** 单文件 HTML，零依赖。结构分四层：① CSS token + 横屏布局（方向 A + 变体 2 选项浮层）；② 内联 SVG 立绘（`<defs>` + `<use>`，眼睛的光独立叠加以便动画）；③ 6 态灯光 CSS（class 切换）；④ 故事引擎（原 storyData 增加 `eyeState` / `endState` 字段，renderScene 重写为「打字机 → 思考预告 → 浮出选项」流水线）。

**Tech Stack:** 原生 HTML/CSS/JS；验证脚本用 Python 3 标准库（`html.parser` + 正则），无第三方依赖。

## Global Constraints

- 单文件、零依赖，浏览器直接打开 `demo/taka.html` 可运行
- 配色只用 spec §6 的 12 个 token；暖黄（#ffb703 / #cca025）只允许出现在：塔卡眼睛、「塔卡」名字标签、选中态高亮
- 选项离底边 ≥24px、按钮最小高度 40px
- 形态红线：无底座站姿、风扇正面不可见、锈螺母只在正面右下角、螺钉 9 颗
- 故事数据 8 个场景（start / clean_branch / surface / ask_wind / just_listen / climax / ending_a / ending_b）文本与分支逻辑一字不改
- SVG 立绘的最终确认稿在本地 `.superpowers/brainstorm/47692-1785144551/content/taka-states-final.html`（gitignored，仅作拷贝源），其中 `#metal8` `#eyeGrad8` `#nutRing8` `#rustNut8` `#arms8` `#legs8` `#takaFinal` 的坐标即为定稿坐标

## File Structure

| 文件 | 责任 |
|------|------|
| `demo/taka.html`（重写） | 全部 UI：token、布局、SVG 立绘、状态动画、故事引擎 |
| `demo/verify_taka_ui.py`（新建） | 结构断言脚本：解析 HTML，检查 token、形态红线、场景字段等 spec 验收项，非交互项全部自动化 |

---

### Task 1: 骨架 + 配色 token + 横屏布局

**Files:**
- Modify: `demo/taka.html`（整体重写）
- Test: `demo/verify_taka_ui.py`

**Interfaces:**
- Produces: CSS 变量 `--bg-deep --bg-sea --bg-dialog --border --text-primary --text-secondary --accent-warm --accent-dim --choice-bg --choice-border --ok-green --low-orange`；DOM 结构 `#stage > .hud, .taka-figure, .choices, .dialog`（供 Task 2/3 挂载）

- [ ] **Step 1: 写验证脚本（失败）**

`demo/verify_taka_ui.py`，用 `html.parser` 收集标签/id/class，正则查 CSS。首轮断言（此时文件还没重写，应失败）：

```python
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
for frag in ['class="hud"', 'class="taka-figure"', 'class="dialog"',
             'class="choices"', 'class="speaker"']:
    check(f"dom {frag}", frag in HTML)

# --- 触控约束 ---
check("选项离底边 >=24px", re.search(r"\.choices\s*\{[^}]*bottom:\s*(2[4-9]|[3-9]\d)\d*px", HTML))
check("按钮最小高度 40px", re.search(r"min-height:\s*40px", HTML))

# --- 暖黄面积约束：#ffb703 只允许出现在 eyeGrad / accent token / hover ---
warm_uses = [m.start() for m in re.finditer(r"#ffb703", HTML, re.I)]
check("暖黄使用处 <=4（token、渐变、高光、hover）", len(warm_uses) <= 4)

if failures:
    print("FAIL:"); [print(" -", f) for f in failures]; sys.exit(1)
print("OK: all checks passed")
```

- [ ] **Step 2: 运行确认失败**

Run: `python3 demo/verify_taka_ui.py`
Expected: FAIL（token / dom 断言不通过）

- [ ] **Step 3: 重写 HTML 骨架**

`demo/taka.html` 整体重写。结构（样式细节按 spec §3/§6）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>塔卡 (TAKA) - 第一次听见风声</title>
<style>
:root {
  --bg-deep:#0a141f; --bg-sea:#13283a; --bg-dialog:rgba(8,14,20,.88);
  --border:#2d3a4a; --text-primary:#e2e8f0; --text-secondary:#8d99a8;
  --accent-warm:#ffb703; --accent-dim:#cca025;
  --choice-bg:#182432; --choice-border:#3d4c5e;
  --ok-green:#48bb78; --low-orange:#c77b1e;
}
/* body: 100vh, linear-gradient(180deg, var(--bg-deep), var(--bg-sea)), overflow:hidden */
/* #stage: position:relative; width:100%; height:100vh; max-width:1200px; margin:0 auto */
/* .hud: position:absolute; top:14px; right:20px; font-size:11px; color:var(--text-secondary); letter-spacing:2px */
/* .taka-figure: position:absolute; left:12%; top:10%; （Task 2 填 SVG） */
/* .dialog: position:absolute; left:24px; right:24px; bottom:24px;
   background:var(--bg-dialog); border:1px solid var(--border); border-radius:14px;
   padding:16px 20px; min-height:110px */
/* .speaker: font-size:11px; color:var(--accent-dim); letter-spacing:4px; margin-bottom:8px */
/* .story-text: font-size:17px; line-height:2; letter-spacing:1px; color:var(--text-primary);
   white-space:pre-line; min-height:68px; cursor:pointer （点击补完打字机） */
/* .choices: position:absolute; right:32px; bottom:170px; display:flex; flex-direction:column;
   gap:10px; min-width:200px （bottom 170px = 对话框高+间距，保证离底边 ≥24px 的选项落点） */
/* .choice-btn: min-height:40px; padding:10px 16px; border-radius:12px;
   border:1px solid var(--choice-border); background:var(--choice-bg);
   color:var(--text-primary); font-size:15px; text-align:center; cursor:pointer;
   box-shadow:0 4px 12px rgba(0,0,0,.4); transition:all .15s */
/* .choice-btn:hover: border-color:var(--accent-warm); transform:translateY(-2px) */
/* .choice-btn 初始 opacity:0，浮出时 fade-in */
</style>
</head>
<body>
<div id="stage">
  <div class="hud">ENERGY <span id="battery-text">100%</span></div>
  <div class="taka-figure" id="taka-figure"><!-- Task 2: SVG 立绘 --></div>
  <div class="choices" id="choices"></div>
  <div class="dialog" id="dialog">
    <div class="speaker">塔 卡</div>
    <div class="story-text" id="story-text"></div>
    <div class="listen-bar" id="listen-bar" style="display:none">
      <span>风声。呼呼。正在收听...</span>
      <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
    </div>
  </div>
</div>
<script>
// Task 3: 故事数据 + 引擎
</script>
</body>
</html>
```

- [ ] **Step 4: 运行验证脚本通过 + 浏览器目检**

Run: `python3 demo/verify_taka_ui.py`
Expected: `OK: all checks passed`
目检：`open demo/taka.html`，横屏窗口下确认：深海渐变底、右上小 HUD、底部对话框、右下选项浮层区（此时选项为空）。

- [ ] **Step 5: Commit**

```bash
git add demo/taka.html demo/verify_taka_ui.py
git commit -m "Rewrite demo skeleton: visual-novel layout + color tokens"
```

---

### Task 2: TAKA SVG 立绘 + 6 态灯光

**Files:**
- Modify: `demo/taka.html`（`<style>` 增加状态动画；`.taka-figure` 内填 SVG）
- Test: `demo/verify_taka_ui.py`（追加断言）

**Interfaces:**
- Consumes: Task 1 的 `.taka-figure` 容器
- Produces: 状态 class `st-standby st-speaking st-thinking st-listening st-low st-off`（设置在 `#taka-figure` 上，Task 3 的故事引擎通过 `figure.className = 'taka-figure ' + state` 切换）；SVG 中眼睛的光为独立 `<circle class="eyeGlow">`

- [ ] **Step 1: 追加验证断言（失败）**

`demo/verify_taka_ui.py` 追加：

```python
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
```

Run: `python3 demo/verify_taka_ui.py` → Expected: FAIL（svg/state 断言不通过）

- [ ] **Step 2: 填入 SVG 立绘**

从定稿 mockup `.superpowers/brainstorm/47692-1785144551/content/taka-states-final.html` 拷贝（id 重命名：metal8→metalGrad、eyeGrad8→eyeGrad、nutRing8→nutRing、rustNut8→rustNut、arms8→arms、legs8→legs、takaFinal→takaBody）：

- `<defs>`：metalGrad、eyeGrad、nutRing（9 颗）、rustNut（1 颗，旋转 20°、锈色）、arms、legs（陆地伸出）、legsStub（水下收回，只露 8px 一节）、takaBody（= arms + legs + 身体 rect + nutRing + rustNut + 眼睛外环 r27 无填充光 + 胸口面板 + 地面阴影）
- `.taka-figure` 内联 SVG（viewBox `0 0 220 210`，CSS 高度约 300px）：
  `<g class="takaBody"><use href="#takaBody"/></g>`
  `<circle class="eyeGlow" cx="110" cy="92" r="17" fill="url(#eyeGrad)"/>`
  `<circle cx="103.5" cy="85.5" r="3.5" fill="#fff" opacity="0.85"/>`
- 水下模式备用：`takaBodySwim`（legs 换成 legsStub），本故事不接入引擎

- [ ] **Step 3: 填入 6 态 CSS 动画**

keyframes 直接拷贝 mockup（参数已在 spec §5 确认）：

```css
.eyeGlow { transform-box:fill-box; transform-origin:center; }
.st-standby  .eyeGlow { animation:breathe 3.2s infinite alternate ease-in-out; }
@keyframes breathe { from{opacity:.55;filter:drop-shadow(0 0 2px rgba(255,183,3,.4))} to{opacity:1;filter:drop-shadow(0 0 7px rgba(255,183,3,.8))} }
.st-speaking .takaBody { animation:bob 1.6s infinite ease-in-out; transform-box:fill-box; transform-origin:center; }
@keyframes bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
.st-thinking .eyeGlow { animation:think 2.4s infinite; }
@keyframes think { 0%{opacity:1} 6%{opacity:.15} 12%{opacity:1} 18%{opacity:.15} 24%{opacity:1} 30%{opacity:.15} 36%{opacity:1} 100%{opacity:1} }
.st-listening .eyeGlow { animation:listen 4.5s infinite ease-in-out; }
@keyframes listen { 0%,100%{opacity:.35;filter:drop-shadow(0 0 1px rgba(255,183,3,.3))} 50%{opacity:.8;filter:drop-shadow(0 0 5px rgba(255,183,3,.6))} }
.st-low .eyeGlow { fill:var(--low-orange); animation:low 2s infinite; }
@keyframes low { 0%,100%{opacity:.3} 50%{opacity:.65} }
.st-off .takaBody { transform:rotate(-3deg); transform-box:fill-box; transform-origin:center; opacity:.75; }
.st-off .eyeGlow { display:none; }
```

注意：`.st-speaking .eyeGlow` 不透明度恒为 1（standby 的 breathe 动画被 class 覆盖后自动停止）。

- [ ] **Step 4: 验证 + 目检**

Run: `python3 demo/verify_taka_ui.py` → `OK: all checks passed`
目检：浏览器 DevTools 给 `#taka-figure` 手动切换 6 个 class，确认动画与 mockup 一致。

- [ ] **Step 5: Commit**

```bash
git add demo/taka.html demo/verify_taka_ui.py
git commit -m "Add TAKA SVG figure with 6 eye-light states"
```

---

### Task 3: 故事引擎（数据 + 打字机 + 状态流水线）

**Files:**
- Modify: `demo/taka.html`（`<script>` 部分）
- Test: `demo/verify_taka_ui.py`（追加断言）

**Interfaces:**
- Consumes: Task 2 的状态 class、`#story-text #choices #battery-text #listen-bar #progress-fill #taka-figure`
- Produces: `renderScene(sceneKey)`；场景 schema `{ text, battery, eyeState, endState?, choices?, isSpecialListen?, next? }`

- [ ] **Step 1: 追加验证断言（失败）**

```python
# --- 8 个场景都有 eyeState ---
scenes = ["start", "clean_branch", "surface", "ask_wind",
          "just_listen", "climax", "ending_a", "ending_b"]
for s in scenes:
    m = re.search(rf'\b{s}:\s*\{{[^}}]*?eyeState:\s*"(st-[a-z]+)"', HTML, re.S)
    check(f"scene {s} 有 eyeState", bool(m))
# --- ending_b 有 endState st-off ---
check("ending_b endState", re.search(r'ending_b:\s*\{[^}}]*?endState:\s*"st-off"', HTML, re.S))
```

Run → Expected: FAIL

- [ ] **Step 2: 故事数据（文本一字不改，仅加状态字段）**

原 `storyData` 8 场景文本/分支/battery 保留，映射：

| 场景 | eyeState | endState | 说明 |
|------|----------|----------|------|
| start | `st-standby` | — | |
| clean_branch | `st-thinking` | — | 夜里睡不着，灯闪（原 blink-fast 的语义） |
| surface | `st-standby` | — | |
| ask_wind | `st-standby` | — | |
| just_listen | `st-listening` | — | isSpecialListen 保留 |
| climax | `st-low` | — | 电池 10% |
| ending_a | `st-standby` | — | |
| ending_b | `st-standby` | `st-off` | 文本播完缓缓关机 |

- [ ] **Step 3: renderScene 流水线**

```javascript
let typing = null; // 打字机 timer

function setFigureState(state) {
  document.getElementById("taka-figure").className = "taka-figure " + state;
}

function typeText(text, onDone) {
  const el = document.getElementById("story-text");
  el.innerText = "";
  let i = 0;
  clearInterval(typing);
  typing = setInterval(() => {
    el.innerText = text.slice(0, ++i);
    if (i >= text.length) { clearInterval(typing); typing = null; onDone(); }
  }, 45);
  // 点击对话框立即补完
  document.getElementById("dialog").onclick = () => {
    if (typing) { clearInterval(typing); typing = null; el.innerText = text; onDone(); }
  };
}

function showChoices(scene) {
  const box = document.getElementById("choices");
  box.innerHTML = "";
  (scene.choices || []).forEach(c => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.innerText = c.text;
    btn.onclick = () => renderScene(c.next);
    box.appendChild(btn);
  });
}

function renderScene(key) {
  const scene = storyData[key];
  if (!scene) return;
  document.getElementById("choices").innerHTML = "";
  document.getElementById("listen-bar").style.display = "none";
  document.getElementById("battery-text").innerText = scene.battery + "%";

  // 打字机期间 standby 临时切 speaking（spec §7）
  const duringTyping = scene.eyeState === "st-standby" ? "st-speaking" : scene.eyeState;
  setFigureState(duringTyping);

  typeText(scene.text, () => {
    setFigureState(scene.endState || scene.eyeState);
    if (scene.isSpecialListen) {
      runListenBar(scene.next); // 4s 进度条 → 浮出「继续」
    } else if (scene.choices && !scene.endState) {
      // 思考预告：闪三下（约 0.9s）再浮出选项
      const prev = scene.eyeState;
      setFigureState("st-thinking");
      setTimeout(() => { setFigureState(prev); showChoices(scene); }, 900);
    } else {
      showChoices(scene); // endState 场景（结局 B）直接给「重新开始」
    }
  });
}

function runListenBar(next) {
  const bar = document.getElementById("listen-bar");
  const fill = document.getElementById("progress-fill");
  bar.style.display = "flex";
  let p = 0;
  const t = setInterval(() => {
    fill.style.width = (p += 2) + "%";
    if (p >= 100) {
      clearInterval(t);
      document.getElementById("choices").innerHTML =
        `<button class="choice-btn" onclick="renderScene('${next}')">睁开眼睛，太阳升起来了...</button>`;
    }
  }, 80);
}

renderScene("start");
```

- [ ] **Step 4: 验证 + 全流程手测**

Run: `python3 demo/verify_taka_ui.py` → `OK: all checks passed`
手测 4 条路径（浏览器）：① start→surface→ask_wind→climax→ending_a→重新开始；② start→clean_branch→surface；③ surface→just_listen（进度条）→climax→ending_b（关机态）→重新开始；④ 打字机中点击对话框补完。每条路径确认：状态切换正确、选项浮出前有闪三下、ENERGY 数字更新。

- [ ] **Step 5: Commit**

```bash
git add demo/taka.html demo/verify_taka_ui.py
git commit -m "Wire story engine: typewriter, think-preview, 6-state pipeline"
```

---

### Task 4: 竖屏降级 + 最终验收

**Files:**
- Modify: `demo/taka.html`（`<style>` 末尾加 media query）
- Test: `demo/verify_taka_ui.py`（追加断言）

**Interfaces:**
- Consumes: Task 1-3 全部

- [ ] **Step 1: 追加断言（失败）**

```python
check("竖屏 media query", "@media" in HTML and "portrait" in HTML)
```

Run → Expected: FAIL

- [ ] **Step 2: 竖屏样式**

```css
@media (orientation: portrait) {
  body { overflow:auto; }
  #stage { height:auto; min-height:100vh; }
  .taka-figure { left:50%; transform:translateX(-50%); top:4%; }
  .taka-figure svg { height:220px; }
  .choices { position:static; margin:0 24px 12px; min-width:0; }
  .choice-btn { width:100%; }
  .dialog { position:static; margin:0 16px 16px; }
  /* 竖屏改为文档流：figure → choices → dialog 顺序重排为 figure → dialog → choices */
}
```

竖屏用文档流重排时 DOM 顺序是 figure/choices/dialog，需要用 flex `order` 或调整 DOM；实现时把 `#stage` 竖屏设为 `display:flex; flex-direction:column`，`.taka-figure{order:1} .dialog{order:2} .choices{order:3}`，横屏保持绝对定位不变。

- [ ] **Step 3: 验收清单（对照 spec §9）**

- Run: `python3 demo/verify_taka_ui.py` → `OK: all checks passed`
- 横屏（约 4:3 / 16:10 窗口）：视线动线立绘→文本→右下选项；选项离底边 ≥24px；按钮 ≥40px ✅
- 暖黄只出现在：眼睛、名字标签、选项 hover ✅
- 竖屏（DevTools 切竖屏比例）：上下堆叠、选项通栏 ✅
- 4 条故事路径重跑一遍 ✅

- [ ] **Step 4: Commit**

```bash
git add demo/taka.html demo/verify_taka_ui.py
git commit -m "Add portrait fallback; UI redesign complete per spec"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 布局→Task 1；§4 体型→Task 2；§5 状态→Task 2；§6 token→Task 1；§7 交互→Task 3；§2 设备约束→Task 1/4；§9 验收→Task 4 Step 3。无遗漏。
- **类型一致**：状态 class（st-*）在 Task 2 定义、Task 3 消费，名称一致；`renderScene`/`showChoices`/`typeText`/`setFigureState` 签名一致。
- **placeholder**：无 TBD/TODO；SVG 坐标以定稿 mockup 为拷贝源（Task 2 Step 2 指明路径与 id 映射）。
