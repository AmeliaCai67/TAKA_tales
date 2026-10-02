// 横屏绘本模式 renderer（2026-08-31，plan: docs/superpowers/plans/2026-08-31-landscape-book-mode.md）
// 职责只有「场景怎么画」：spread 双缓冲翻页、右页气泡流（stagger 揭示 + 点击补完）、
// 左页构图（art/decor/塔卡定位/hotspot 物化）。状态机、语音、进度全在 engine.ts。
// 反向依赖 engine 只有一处导航回调，由 engine 模块尾部 initBookNav 注入（防循环 import）。
import { pack } from "./pack";
import type { Scene, CollectItem } from "./story";
import { parseTextSegs } from "./speech";
import { wrapCodexIn } from "./codex";
import { entryUnlocked } from "./codex";
import { openCollectFlow, closeCollectFlow, type FlowCallbacks } from "./collect-flow";
import { preloadedSvg, warmAudio } from "./preload";
import { reportEvent } from "./events";
import { speechPref } from "./settings";
import { t, lang } from "./i18n";

/* ---------- 导航注入 ---------- */
let navFn: (next: string, choiceText: string) => void = () => {};
export function initBookNav(fn: (next: string, choiceText: string) => void): void { navFn = fn; }

/* 话筒 hotspot 点按注入（2026-09-28）：engine 持有语音识别控制器，book 只画入口不碰状态机 */
let voiceFn: (() => void) | null = null;
export function initBookVoice(fn: (() => void) | null): void { voiceFn = fn; }

/* ---------- DOM 常驻件借用（VN ↔ 绘本切换时来回挂载） ---------- */
const figure = () => document.getElementById("taka-figure")!;
const listenBar = () => document.getElementById("listen-bar")!;

/** VN 归位：立绘回 #stage，聆听条回 #dialog（choices 之前的原位置） */
export function parkChromeVN(): void {
    const stage = document.getElementById("stage")!;
    if (figure().parentElement !== stage) stage.appendChild(figure());
    const dialog = document.getElementById("dialog")!;
    if (listenBar().parentElement !== dialog) {
        dialog.insertBefore(listenBar(), document.getElementById("choices"));
    }
    const f = figure();
    f.style.left = ""; f.style.top = ""; f.style.width = ""; f.style.transform = "";
    f.querySelector("svg")!.style.transform = "";
}

/* ---------- 引擎内置件注册表（2026-09-30 全部独立为 public/characters/*.svg，不再内联） ----------
   故事包未注册、但此处登记的 actor 名 → 从引擎内置 characters/ 目录取（跨故事通用小物，如 mic 由引擎自注入）。
   加载优先级：故事包 characters 注册表 > 引擎内置件。 */
const PIECE_BASE = import.meta.env.BASE_URL + "characters/";
const PIECES = new Set(["light", "coral", "deep", "shell", "sun", "waves", "screen", "green", "door", "mic", "pixel-taka"]);
/** boot 预载用：引擎内置件全量 URL（含 pixel-taka——换装点同步读暖缓存依赖它先载） */
export const ENGINE_PIECE_URLS: string[] = [...PIECES].map(n => PIECE_BASE + n + ".svg");

/* ---------- 角色 SVG 懒加载缓存（actor → svg 文本；失败 = null，hotspot 退化为光点） ---------- */
const actorCache = new Map<string, string | null>();
async function loadActor(actor: string): Promise<string | null> {
    const rel = pack().characters?.[actor];
    const url = rel ? pack().baseUrl + rel : (PIECES.has(actor) ? PIECE_BASE + actor + ".svg" : null);
    if (!url) return null;
    if (actorCache.has(actor)) return actorCache.get(actor)!;
    const warm = preloadedSvg(url); // 预载缓存命中则省一次 304 往返（2026-09-28）
    if (warm !== undefined) { actorCache.set(actor, warm); return warm; }
    try {
        const res = await fetch(url);
        const svg = res.ok ? await res.text() : null;
        actorCache.set(actor, svg);
        return svg;
    } catch { actorCache.set(actor, null); return null; }
}

/* ---------- spread 双缓冲翻页 ---------- */
let front: HTMLElement | null = null;  // 当前展示中的 spread
let back: HTMLElement | null = null;   // 幕后填入下一页的 spread
let revealTimers: ReturnType<typeof setTimeout>[] = [];
let sceneSeq = 0; // 场景序号（废弃回调防串场：翻页动画未完成又进下一场景时丢弃旧回调）

export function resetBook(): void {
    for (const tmr of revealTimers) clearTimeout(tmr);
    revealTimers = [];
    sceneSeq++;
}

export function bookChoicesEl(): HTMLElement {
    return (front?.querySelector(".book-choices") as HTMLElement) || document.getElementById("choices")!;
}

function stage(): HTMLElement { return document.getElementById("book-stage")!; }

function ensureSpreads(): void {
    if (front && back) return;
    stage().innerHTML = "";
    front = document.createElement("div");
    back = document.createElement("div");
    front.className = "spread";
    back.className = "spread";
    back.style.visibility = "hidden";
    stage().append(front, back);
}

/** 说话人显示名：seg.who 是声线 id，反查 speakers 表；narrator 无名牌。
 *  场景级声线变体（voiceOverrides 产物，如 rivet-calm）不在表里——剥掉「-变体」后缀用基名再查 */
function whoLabel(who: string): { name: string; cls: string } {
    if (who === "narrator") return { name: "", cls: "narr" };
    const speakers = Object.entries(pack().speakers);
    const takaEntry = speakers.find(([, v]) => v === "taka");
    if (who === "taka") return { name: takaEntry?.[0] || "TAKA", cls: "taka-b" };
    const entry = speakers.find(([, v]) => v === who)
        ?? speakers.find(([, v]) => v === who.split("-")[0]);
    return { name: entry?.[0] || who, cls: "char-b" };
}

/** 左页氛围件 */
function decorEl(kind: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "decor decor-" + kind;
    d.setAttribute("aria-hidden", "true");
    if (kind === "waves") d.innerHTML = "<i></i><i></i><i></i>";
    if (kind === "bubbles") {
        let html = "";
        for (let i = 0; i < 10; i++) {
            const sz = 6 + Math.round(Math.random() * 14);
            html += `<i style="left:${20 + Math.random() * 55}%;width:${sz}px;height:${sz}px;` +
                    `animation-duration:${5 + Math.random() * 5}s;animation-delay:${Math.random() * 5}s"></i>`;
        }
        d.innerHTML = html;
    }
    return d;
}

/** 场景渲染：填入幕后 spread → 翻页。onTextDone 由 engine 传入（灯光归位 + 选项/聆听条）。 */
export function renderSceneBook(key: string, scene: Scene, text: string, onTextDone: () => void): void {
    resetBook();
    ensureSpreads();
    parkChromeVN(); // 共享节点（立绘/聆听条）先归位到 #stage/#dialog，避免清空 spread 时把它们一并销毁
    const seq = ++sceneSeq;
    const spread = back!;
    spread.innerHTML = "";
    spread.classList.remove("collect-mode"); // 清掉上一收集节点的整页布局（右页恢复显示）

    /* ----- 左页：画面 ----- */
    const left = document.createElement("div");
    left.className = "page-scene crayon";
    const art = scene.book?.art || scene.background;
    if (art) left.style.backgroundImage = `url("${pack().baseUrl + art}")`;
    for (const d of scene.book?.decor || []) left.appendChild(decorEl(d));
    // 常驻角色（非交互演出件）：背景之上、塔卡之下
    for (const a of scene.book?.actors || []) {
        const d = document.createElement("div");
        d.className = "scene-actor";
        d.style.left = a.x + "%";
        d.style.top = a.y + "%";
        d.style.width = (a.size ?? 20) + "%";
        const tf = [a.flip ? "scaleX(-1)" : "", a.rotate ? `rotate(${a.rotate}deg)` : ""].filter(Boolean).join(" ");
        if (tf) d.style.transform = tf;
        void loadActor(a.actor).then(svg => { if (svg) d.innerHTML = svg; });
        left.appendChild(d);
    }
    // 塔卡：同一 DOM 节点移入左页（6 态灯光/思考演出 CSS 零改动继承）
    const f = figure();
    const tp = scene.book?.taka || {};
    f.style.left = (tp.x ?? 14) + "%";
    f.style.top = (tp.y ?? 34) + "%";
    // 尺寸：优先场景级 book.taka.size；ch02 鲸鱼篇幅大，塔卡默认收一点；其他走 CSS 34%。
    const takaSize = tp.size !== undefined ? tp.size + "%" : (pack().id === "ch02-whale" ? "29%" : undefined);
    if (takaSize) f.style.width = takaSize;
    (f.querySelector("svg") as SVGSVGElement).style.transform = tp.rotate ? `rotate(${tp.rotate}deg)` : "";
    left.appendChild(f);
    spread.appendChild(left);

    /* ----- 右页：文字气泡 ----- */
    const right = document.createElement("div");
    right.className = "page-text";
    const bubblesBox = document.createElement("div");
    bubblesBox.className = "bubbles";
    right.appendChild(bubblesBox);
    // 聆听条挂右页底部（engine 的 runListenBar 只认 id，位置由这里决定）
    right.appendChild(listenBar());
    const choices = document.createElement("div");
    choices.className = "book-choices";
    right.appendChild(choices);
    const pagenum = document.createElement("div");
    pagenum.className = "pagenum";
    pagenum.textContent = pack().title;
    right.appendChild(pagenum);
    spread.appendChild(right);

    /* ----- 气泡流：stagger 揭示，点右页补完（对齐 VN 点对话框补完的习惯） ----- */
    const segs = parseTextSegs(text, scene.voiceOverrides);
    const bubbleEls: HTMLElement[] = segs.map(s => {
        const b = document.createElement("div");
        const w = whoLabel(s.who);
        b.className = "bubble " + w.cls;
        if (w.name) {
            const who = document.createElement("span");
            who.className = "who";
            who.textContent = w.name;
            b.appendChild(who);
        }
        const txt = document.createElement("span");
        txt.className = "bubble-text";
        txt.textContent = s.text;
        b.appendChild(txt);
        bubblesBox.appendChild(b);
        return b;
    });

    const finish = () => {
        if (seq !== sceneSeq) return; // 已切场景，旧回调作废
        for (const tmr of revealTimers) clearTimeout(tmr);
        revealTimers = [];
        bubbleEls.forEach(b => b.classList.add("in"));
        // 记忆库：逐气泡包关键词（气泡是纯文本节点容器，wrapCodexIn 直接可用）
        bubbleEls.forEach(b => wrapCodexIn(b.querySelector(".bubble-text") as HTMLElement, scene));
        right.onclick = null;
        onTextDone();
    };
    bubbleEls.forEach((b, i) => {
        revealTimers.push(setTimeout(() => {
            if (seq !== sceneSeq) return;
            b.classList.add("in");
            if (i === bubbleEls.length - 1) finish();
        }, 350 * (i + 1)));
    });
    if (!bubbleEls.length) finish();
    right.onclick = finish; // 点击补完

    /* ----- 翻页转场：旧页翻出，新页入 ----- */
    const old = front!;
    back!.style.visibility = "visible";
    if (old.innerHTML) {
        old.classList.add("turned");
        const oldRef = old;
        setTimeout(() => { oldRef.style.visibility = "hidden"; oldRef.classList.remove("turned"); }, 1000);
    }
    const tmp = front; front = back; back = tmp;
}

/* ---------- hotspot 物化（选项打字播完后上左页；engine.mountChoices 调用） ----------
   第二参 voiceHotspot：freeInput 场景且语音可用时，追加内置话筒 hotspot（2026-09-28 发现率优化）。
   它是引擎行为而非包数据（不动 story.json schema）——「说话」也是一种选择，用孩子已会的「点发光的东西」语言表达。 */
export function renderHotspots(scene: Scene, voiceHotspot = false): void {
    const left = front?.querySelector(".page-scene");
    if (!left) return;
    left.querySelectorAll(".hotspot").forEach(h => h.remove());
    const choices = scene.choices || [];
    let any = false;
    for (const h of scene.book?.hotspots || []) {
        const c = choices[h.choice];
        if (!c) continue;
        any = true;
        const btn = document.createElement("button");
        btn.className = "hotspot";
        btn.style.left = h.x + "%";
        btn.style.top = h.y + "%";
        btn.style.width = (h.size ?? 14) + "%";
        const halo = document.createElement("span");
        halo.className = "halo";
        btn.appendChild(halo);
        const art = document.createElement("span");
        art.className = "actor";
        void loadActor(h.actor).then(svg => { if (svg) art.innerHTML = svg; });
        btn.appendChild(art);
        const label = document.createElement("span");
        label.className = "label" + (h.y < 40 ? " below" : ""); // 上半页的 hotspot 标签放下方，防顶出舞台
        label.textContent = c.text;
        btn.appendChild(label);
        btn.onclick = (e) => {
            e.stopPropagation();
            navFn(c.next, c.text);
        };
        left.appendChild(btn);
    }
    // 话筒 hotspot：freeInput 场景的语音入口物化（固定左页右下角沙地，远离选项 hotspot 群；点按=开始/停止录音）
    const voiceTap = voiceFn; // 局部捕获：TS 不对模块级 let 在闭包内收窄
    if (voiceHotspot && voiceTap) {
        const btn = document.createElement("button");
        btn.className = "hotspot mic-hotspot";
        btn.style.left = "86%";
        btn.style.top = "88%";
        btn.style.width = "11%";
        const halo = document.createElement("span");
        halo.className = "halo";
        btn.appendChild(halo);
        const art = document.createElement("span");
        art.className = "actor";
        art.innerHTML = ""; // mic 走引擎内置件（public/characters/mic.svg），异步注入
        void loadActor("mic").then(svg => { if (svg) art.innerHTML = svg; });
        btn.appendChild(art);
        const label = document.createElement("span");
        label.className = "label"; // 页面底部：标签在按钮上方（默认），防戳出页底
        label.textContent = t("engine.voice_hotspot_label");
        btn.appendChild(label);
        btn.onclick = (e) => { e.stopPropagation(); voiceTap(); };
        left.appendChild(btn);
    }
    // 有物化选项时给第一次读绘本的孩子一句提示
    if (any && !sessionStorage.getItem("taka_book_hinted")) {
        sessionStorage.setItem("taka_book_hinted", "1");
        const hint = document.createElement("div");
        hint.className = "flip-hint";
        hint.textContent = t("book.tap_glow");
        left.appendChild(hint);
        setTimeout(() => hint.remove(), 6000);
    }
}

/* ---------- 收集小游戏节点（2026-09 第四章「你好，757」） ----------
   横屏/整页/塔卡可拖动/物化物品可交互收集/集满 N 解锁成就。
   只支持横屏：collect-mode 下 .page-scene 占满 100%、右页 .page-text 隐藏。
   收集完成后调用 collectComplete 回调（engine 侧解锁成就 + toast），并显示「继续」。 */
let collectCompleteCb: ((ach: string) => void) | null = null;
export function initCollectComplete(fn: ((ach: string) => void) | null): void { collectCompleteCb = fn; }

/** 离开 collect 场景时卸掉塔卡拖拽监听（防止串到普通书台/VN 场景）+ 关掉收集闭环面板 + 还原像素塔卡 */
export function cleanupCollectDrag(): void {
    if (detachDrag) detachDrag();
    closeCollectFlow();
    const f = document.getElementById("taka-figure");
    if (f && f.classList.contains("px-mode") && takaOrigHtml !== null) {
        f.innerHTML = takaOrigHtml; // 还原普通立绘（像素塔卡是 collect 场景的监控画质限定）
        f.classList.remove("px-mode", "px-swim", "px-scan", "px-interested");
    }
}

let detachDrag: (() => void) | null = null; // 塔卡拖拽清理函数（离开 collect 时卸掉旧监听）

/* ===== 拱门边界模型（2026-09-28 pixel-taka，plan: docs/ux/ch4-pixel-taka.md）=====
   tunnel-deep.jpg 金色窗框内缘 ≈ 半椭圆（页面 % 坐标，书台固定 16:9 与图同比例，% 线性对齐）。
   archVal > 1 = 墙外海水（塔卡可达）；≤ 1 = 墙内农场（塔卡禁入）。
   （v2 曾改对角墙带+自绘 SVG，用户否决后回滚椭圆——背景不动，物品全在拱门内按真实关系摆放。） */
const ARCH = { cx: 50, cy: 90, rx: 45, ry: 70 };
const archVal = (x: number, y: number): number =>
    ((x - ARCH.cx) / ARCH.rx) ** 2 + ((y - ARCH.cy) / ARCH.ry) ** 2;
/** 目标点收进墙外：墙内 → 沿「椭圆中心→目标」径向投影回墙线，再外推 2.5% 余量（贴玻璃而非穿墙） */
function clampOutsideArch(x: number, y: number): [number, number] {
    if (archVal(x, y) > 1) return [x, y];
    const dx = x - ARCH.cx, dy = y - ARCH.cy;
    const t = 1 / Math.sqrt((dx / ARCH.rx) ** 2 + (dy / ARCH.ry) ** 2);
    const bx = ARCH.cx + dx * t, by = ARCH.cy + dy * t;
    const k = 1 + 2.5 / Math.max(1, Math.hypot(bx - ARCH.cx, by - ARCH.cy));
    return [ARCH.cx + (bx - ARCH.cx) * k, ARCH.cy + (by - ARCH.cy) * k];
}
/** 收集物的「玻璃锚点」：物品中心（在墙内）径向投影到墙线外——塔卡观察它的对应贴墙位 */
function glassAnchorOf(it: CollectItem): [number, number] { return clampOutsideArch(it.x, it.y); }

/** 像素塔卡（2026-09-28 造型，2026-09-30 独立为 public/characters/pixel-taka.svg）：
 *  对齐 experiments/3d/taka_3d.html 建模：竖向圆角方体/凸面观察窗大独眼/六角螺母/三灯条/
 *  波纹软管手臂+钳爪/收腿小脚垫/右下锈螺母。collect 场景限定（「老机器接入隧道旧摄像头」监控画质）；
 *  三态靠 #taka-figure 上的 px-idle / px-swim / px-scan / px-interested class 切换，纯 CSS 帧动画不跑 JS。
 *  换装走预载暖缓存同步注入（boot 已预载引擎内置件）；未命中才异步补拉。 */
const PIXEL_TAKA_URL = PIECE_BASE + "pixel-taka.svg";
let takaOrigHtml: string | null = null; // 像素换装的还原底片（离开 collect 场景恢复普通立绘）

/** 塔卡在 collect 页内可拖拽（pointer + setPointerCapture，移动端灵敏） */
function makeTakaDraggable(taka: HTMLElement, left: HTMLElement): void {
    if (detachDrag) detachDrag();
    let dragging = false, sx = 0, sy = 0, startL = 0, startT = 0;
    taka.style.touchAction = "none";
    const down = (e: PointerEvent) => {
        taka.style.transition = ""; // 拖动立即接管游动（高效路径优先，2026-09-28）
        dragging = true; sx = e.clientX; sy = e.clientY;
        startL = parseFloat(taka.style.left) || 0; startT = parseFloat(taka.style.top) || 0;
        try { taka.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    };
    const move = (e: PointerEvent) => {
        if (!dragging) return;
        const w = left.clientWidth || 1, h = left.clientHeight || 1;
        const nl = Math.max(0, Math.min(100, startL + ((e.clientX - sx) / w) * 100));
        const nt = Math.max(4, Math.min(95, startT + ((e.clientY - sy) / h) * 100));
        // 拱门闸口（2026-09-28 pixel-taka）：拖动也永远不出墙——中心点过椭圆判定
        const tw = (taka.offsetWidth / w) * 100, th = (taka.offsetHeight / h) * 100;
        const [cx, cy] = clampOutsideArch(nl + tw / 2, nt + th / 2);
        taka.style.left = Math.max(0, Math.min(100 - tw, cx - tw / 2)) + "%";
        taka.style.top = Math.max(4, Math.min(95 - th, cy - th / 2)) + "%";
    };
    const stop = () => { dragging = false; };
    taka.addEventListener("pointerdown", down);
    taka.addEventListener("pointermove", move);
    taka.addEventListener("pointerup", stop);
    taka.addEventListener("pointercancel", stop);
    detachDrag = () => {
        taka.removeEventListener("pointerdown", down);
        taka.removeEventListener("pointermove", move);
        taka.removeEventListener("pointerup", stop);
        taka.removeEventListener("pointercancel", stop);
        detachDrag = null;
    };
}

/** 直线段是否穿过拱门（禁入区）：等距采样，任一点 archVal<1 即穿越 */
function crossesArch(x1: number, y1: number, x2: number, y2: number): boolean {
    for (let i = 1; i < 12; i++) {
        const t = i / 12;
        if (archVal(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t) < 1) return true;
    }
    return false;
}
/* 绕行点（拱门上方海水区，椭圆外必合法）：左顶 / 顶 / 右顶。
   端点钳制只管落点不管路径——左右穿场时会从拱门正中游过去（用户 2026-09-28 圈出「塔卡不能走到这片区域内」），
   因此长途移动一律路由：同侧穿越→本侧绕行点；左右穿场→左→顶→右三点。 */
const BYPASS: [number, number][] = [[15, 10], [50, 4], [85, 10]];
function routeOutside(sx: number, sy: number, tx: number, ty: number): [number, number][] {
    if (!crossesArch(sx, sy, tx, ty)) return [[tx, ty]];
    const leftOf = (v: number) => v < 50;
    if (leftOf(sx) === leftOf(tx)) return [leftOf(sx) ? BYPASS[0] : BYPASS[2], [tx, ty]];
    return [leftOf(sx) ? BYPASS[0] : BYPASS[2], BYPASS[1], leftOf(tx) ? BYPASS[0] : BYPASS[2], [tx, ty]];
}

/** 单段直线游（页内钳制）；路由由 swimTakaTo 负责 */
function swimLeg(taka: HTMLElement, left: HTMLElement, cxPct: number, cyPct: number, durMs: number): Promise<void> {
    const tw = (taka.offsetWidth / (left.clientWidth || 1)) * 100;
    const th = (taka.offsetHeight / (left.clientHeight || 1)) * 100;
    const x = Math.max(0, Math.min(100 - tw, cxPct - tw / 2));
    const y = Math.max(4, Math.min(95 - th, cyPct - th / 2));
    taka.style.transition = `left ${durMs}ms ease-in-out, top ${durMs}ms ease-in-out`;
    taka.style.left = x + "%";
    taka.style.top = y + "%";
    return new Promise(res => setTimeout(() => { taka.style.transition = ""; res(); }, durMs + 40));
}

/** 塔卡游动动画（2026-09-28 点击兜底，spec: collect-ux-drag-and-feedback；pixel-taka 起过拱门闸口+绕行路由）：
 *  目标点先过 clampOutsideArch（永远不落墙内），再算 routeOutside（路径也不穿墙——长途从拱门顶部绕行）。
 *  默认落点略低于目标（offsetY=4% 页高，别压着目标物）；贴玻璃传 0。拖动可随时接管（down 清 transition）。 */
function swimTakaTo(taka: HTMLElement, left: HTMLElement, cxPct: number, cyPct: number, durMs = 1000, offsetY = 4): Promise<void> {
    [cxPct, cyPct] = clampOutsideArch(cxPct, cyPct + offsetY);
    const tw = (taka.offsetWidth / (left.clientWidth || 1)) * 100;
    const th = (taka.offsetHeight / (left.clientHeight || 1)) * 100;
    const sx = (parseFloat(taka.style.left) || 0) + tw / 2;
    const sy = (parseFloat(taka.style.top) || 0) + th / 2;
    const legs = routeOutside(sx, sy, cxPct, cyPct);
    taka.classList.add("px-swim"); // 游动态（非像素模式时无对应样式，无副作用）
    let p: Promise<void> = Promise.resolve();
    const per = durMs / legs.length;
    for (const [lx, ly] of legs) p = p.then(() => swimLeg(taka, left, lx, ly, per));
    return p.then(() => { taka.classList.remove("px-swim"); });
}

/** 收集即时音效：WebAudio 合成上行双音「叮-咚」（零网络零资产）；语音总开关兼总音量，关则不响 */
function playCollectSfx(): void {
    if (!speechPref.on) return;
    try {
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        const ctx: AudioContext = new AC();
        const t0 = ctx.currentTime;
        [523.25, 783.99].forEach((f, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = "sine";
            o.frequency.value = f;
            const s = t0 + i * 0.09;
            g.gain.setValueAtTime(0.0001, s);
            g.gain.exponentialRampToValueAtTime(0.16, s + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
            o.connect(g).connect(ctx.destination);
            o.start(s); o.stop(s + 0.24);
        });
        setTimeout(() => void ctx.close(), 700);
    } catch { /* 无音频环境静默 */ }
}

/** 横屏收集页渲染（engine.renderScene 识别 scene.collect 时调用） */
export function renderSceneCollect(scene: Scene, onDone: () => void): void {
    resetBook();
    ensureSpreads();
    parkChromeVN(); // 共享节点先归位，避免清空 spread 时销毁立绘/聆听条
    spreadSceneSeqGuard(); // 防旧翻页回调串场
    const spread = back!;
    spread.innerHTML = "";
    spread.classList.add("collect-mode"); // 左页全幅、右页隐藏

    const col = scene.collect!;
    const colState = new Set<string>();
    const recordedState = new Set<string>();  // 已录入记忆库的物品（2026-09-07 闭环）
    // 恢复：词条已解锁过的物品直接是「已录入」态（断点续玩/重进故事）
    for (const it of col.items) {
        if (it.codexId && entryUnlocked(pack().id, it.codexId)) { colState.add(it.id); recordedState.add(it.id); }
    }
    const flowCb: FlowCallbacks = {
        onRecorded: (item) => {
            recordedState.add(item.id);
            left.querySelector(`.collect-item[data-id="${item.id}"]`)?.classList.add("recorded");
            // 全部录入 → 成就（2026-09-07 拍板：ch04_remember 触发点从「集满」改为「录满」）
            if (recordedState.size >= col.required) collectCompleteCb?.(col.achievement || "");
        },
    };

    /* 左页：背景 + 氛围件 */
    const left = document.createElement("div");
    left.className = "page-scene crayon collect-page";
    const art = scene.book?.art || scene.background;
    if (art) left.style.backgroundImage = `url("${pack().baseUrl + art}")`;
    for (const d of scene.book?.decor || []) left.appendChild(decorEl(d));
    // 常驻角色（如 757 在隧道里等塔卡）
    for (const a of scene.book?.actors || []) {
        const d = document.createElement("div");
        d.className = "scene-actor";
        d.style.left = a.x + "%";
        d.style.top = a.y + "%";
        d.style.width = (a.size ?? 20) + "%";
        const tf = [a.flip ? "scaleX(-1)" : "", a.rotate ? `rotate(${a.rotate}deg)` : ""].filter(Boolean).join(" ");
        if (tf) d.style.transform = tf;
        void loadActor(a.actor).then(svg => { if (svg) d.innerHTML = svg; });
        left.appendChild(d);
    }
    spread.appendChild(left);

    /* 收集进度角标 */
    const countEl = document.createElement("div");
    countEl.className = "collect-count";
    countEl.textContent = `${colState.size} / ${col.required}`;  // 恢复态计入（已录入的物品）
    left.appendChild(countEl);

    /* 塔卡：移入左页 + 像素换装（本场景限定「老机器接入隧道旧摄像头」画质；离开由 cleanupCollectDrag 还原） */
    const taka = figure();
    left.appendChild(taka);
    const tp = scene.book?.taka || {};
    taka.style.left = (tp.x ?? 28) + "%";
    taka.style.top = (tp.y ?? 52) + "%";
    taka.style.width = (tp.size ?? 30) + "%";
    (taka.querySelector("svg") as SVGSVGElement).style.transform = "";
    if (takaOrigHtml === null) takaOrigHtml = taka.innerHTML;
    // 同步读 boot 预载暖缓存（engine pieces 已随 splash 预载）；万一未命中则异步补拉，
    // px-mode 守卫防「已离开 collect 才到货」把像素版注回普通立绘
    taka.innerHTML = preloadedSvg(PIXEL_TAKA_URL) ?? "";
    if (!taka.innerHTML) void loadActor("pixel-taka").then(svg => {
        if (svg && taka.classList.contains("px-mode")) taka.innerHTML = svg;
    });
    taka.classList.add("px-mode", "px-idle");

    const tEnter = Date.now(); // 埋点基准：首次成功交互耗时
    reportEvent({ type: "collect_scene_enter" });

    /* 扫描线转场：接入旧摄像头信号（~900ms 自毁） */
    const scanIn = document.createElement("div");
    scanIn.className = "collect-scanin";
    spread.appendChild(scanIn);
    setTimeout(() => scanIn.remove(), 900);

    // 塔卡中心 % 坐标（style.left/top 是左上角；拱门判定/兴趣侦测都用中心）
    const takaCenter = (): [number, number] => {
        const tl = parseFloat(taka.style.left) || 0, tt = parseFloat(taka.style.top) || 0;
        const tw = (taka.offsetWidth / (left.clientWidth || 1)) * 100;
        const th = (taka.offsetHeight / (left.clientHeight || 1)) * 100;
        return [tl + tw / 2, tt + th / 2];
    };

    // 桌面端（fine pointer）：塔卡跟随光标游动，拖拽手势下线（2026-09-28 拍板统一）；
    // 移动端：保留直接拖动 + 点按游哪
    const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;
    if (FINE_POINTER) {
        let lastFollow = 0;
        left.addEventListener("pointermove", (e) => {
            const now = Date.now();
            if (now - lastFollow < 90) return; // 节流：跟随=连续重定向
            lastFollow = now;
            const r = left.getBoundingClientRect();
            void swimTakaTo(taka, left,
                ((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100, 380, 0);
        });
    } else {
        makeTakaDraggable(taka, left);
    }

    // 首次进入收集页提示（flip-hint 同款漂浮）：桌面=跟随光标（拖拽已下线），触屏=点按/拖动
    if (!sessionStorage.getItem("taka_collect_hinted")) {
        sessionStorage.setItem("taka_collect_hinted", "1");
        const h = document.createElement("div");
        h.className = "flip-hint collect-hint";
        h.textContent = t(FINE_POINTER ? "book.collect_hint_follow" : "book.collect_hint");
        left.appendChild(h);
        setTimeout(() => h.remove(), 9000);
    }

    /* ===== 2026-09-28 收集 UX（spec: collect-ux-drag-and-feedback）+ 拱门边界（pixel-taka）===== */
    // 水域/墙内点击：点哪游哪；点墙内 = 塔卡贴到最近玻璃位（规则 3：进不去，这不是失败提示）
    left.addEventListener("click", (e) => {
        const el = e.target as HTMLElement;
        if (el !== left && !el.classList.contains("decor")) return; // 只接水域/氛围件（物品/塔卡自己有 handler）
        const r = left.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * 100, py = ((e.clientY - r.top) / r.height) * 100;
        reportEvent({ type: "collect_click", payload: { x: +px.toFixed(1), y: +py.toFixed(1), in_arch: archVal(px, py) <= 1 } });
        void swimTakaTo(taka, left, px, py, 900); // 拱门闸口在 swimTakaTo 内部
    });
    // idle 演示：6s 无操作，塔卡自己游向最近未收集物的玻璃位（不收集；任何按下取消且本场景不再演示）
    const demoTimer = setTimeout(() => {
        const remain = col.items.filter(i => !colState.has(i.id));
        if (!remain.length) return;
        const [tl, tt] = takaCenter();
        const near = remain.reduce((a, b) => {
            const ga = glassAnchorOf(a), gb = glassAnchorOf(b);
            return Math.hypot(ga[0] - tl, ga[1] - tt) < Math.hypot(gb[0] - tl, gb[1] - tt) ? a : b;
        });
        const [gx, gy] = glassAnchorOf(near);
        void swimTakaTo(taka, left, gx, gy, 1600, 0); // 慢速，演示感
    }, 6000);
    left.addEventListener("pointerdown", () => clearTimeout(demoTimer), { once: true });
    // 兴趣侦测（规则 4）：塔卡中心靠近某未收集物的玻璃锚点 → 自动兴趣态（灯亮+贴近+物品 halo 增强）
    const INTEREST_R = 14; // 页 % 距离（宽高混合单位，书台 16:9 下近似圆）
    const interestSeen = new Set<string>(); // collect_interest 每物品每场景只报一次
    const interestTimer = setInterval(() => {
        const [tx, ty] = takaCenter();
        // 半径内取最近者（2026-09-30 新布局右侧物品聚集，first-match 会抢错——如猫/水稻锚点都在右墙）
        let hotId: string | null = null, best = INTEREST_R;
        for (const it of col.items) {
            if (colState.has(it.id)) continue;
            const [gx, gy] = glassAnchorOf(it);
            const d = Math.hypot(tx - gx, ty - gy);
            if (d < best) { best = d; hotId = it.id; }
        }
        taka.classList.toggle("px-interested", !!hotId);
        left.querySelectorAll(".collect-item").forEach(el =>
            el.classList.toggle("px-interest", (el as HTMLElement).dataset.id === hotId));
        if (hotId && !interestSeen.has(hotId)) {
            interestSeen.add(hotId);
            reportEvent({ type: "collect_interest", payload: { item: hotId } });
        }
    }, 150);
    // 场景离开清理链：演示计时器 + 兴趣侦测 + （移动端）拖拽监听
    const prevDetach = detachDrag;
    detachDrag = () => { clearTimeout(demoTimer); clearInterval(interestTimer); prevDetach?.(); };
    // 收集物音频后台预热：observe+facts 全段暖 HTTP 缓存，弱网下播放链不再等 buffering
    warmAudio(col.items.flatMap(it => {
        const base = pack().baseUrl + (lang === "en" ? "audio-en" : "audio") + "/collect/" + it.id;
        return [
            ...(it.observe || []).map((_, i) => `${base}.observe_${String(i + 1).padStart(2, "0")}.mp3`),
            ...(it.facts || []).map((_, i) => `${base}.fact_${String(i + 1).padStart(2, "0")}.mp3`),
        ];
    }));

    /* 集满后可点「继续」 */
    const continueEl = document.createElement("button");
    continueEl.className = "collect-continue";
    continueEl.hidden = true;
    continueEl.textContent = t("book.collect_continue");
    continueEl.onclick = () => navFn(col.next!, "");
    spread.appendChild(continueEl);
    if (colState.size >= col.required) continueEl.hidden = false;  // 恢复态：早已集满

    /* 物化物品 */
    let collectBusy = false; // 游动收集进行中（点击防抖）
    let firstSuccess = false; // 埋点：本场景首次成功交互（collect_first_success）
    col.items.forEach((it) => {
        const btn = document.createElement("button");
        btn.className = "collect-item";
        btn.style.left = it.x + "%";
        btn.style.top = it.y + "%";
        btn.style.width = (it.size ?? 16) + "%";
        btn.dataset.id = it.id;
        const halo = document.createElement("span");
        halo.className = "halo";
        btn.appendChild(halo);
        const a = document.createElement("span");
        a.className = "actor";
        void loadActor(it.actor).then(svg => { if (svg) a.innerHTML = svg; });
        btn.appendChild(a);
        if (it.label) {
            const label = document.createElement("span");
            label.className = "label" + (it.y < 40 ? " below" : "");
            // 收集后揭晓（2026-09-28，联动记忆库悬念）：收集前只显示？？？
            label.textContent = colState.has(it.id) ? it.label : t("codex.unknown");
            btn.appendChild(label);
        }
        // 收集成功统一出口：贴玻璃扫描演出 + 即时音效 + 扫描扩散环 + 灯闪 + 揭晓标签 + 计数 + 观察小剧本
        const doCollect = () => {
            if (!firstSuccess) { // 埋点：首次成功交互耗时（自场景进入）
                firstSuccess = true;
                reportEvent({ type: "collect_first_success", payload: { elapsed_ms: Date.now() - tEnter, item: it.id } });
            }
            taka.classList.add("px-scan"); // 贴玻璃扫描（像素塔卡：扫描线扫过全身）
            setTimeout(() => taka.classList.remove("px-scan"), 1000);
            colState.add(it.id);
            btn.classList.add("collected");
            playCollectSfx(); // 即时音效（WebAudio 合成，零网络）
            const ring = document.createElement("span"); // 扫描扩散环：点击瞬间的视觉反馈
            ring.className = "scan-ring";
            btn.appendChild(ring);
            setTimeout(() => ring.remove(), 750);
            const labelEl = btn.querySelector(".label"); // 揭晓真名
            if (labelEl && it.label) { labelEl.textContent = it.label; labelEl.classList.add("revealed"); }
            const n = colState.size;
            countEl.textContent = `${n} / ${col.required}`;
            taka.classList.add("collect-flash"); // 塔卡灯闪，收集反馈
            setTimeout(() => taka.classList.remove("collect-flash"), 700);
            if (n >= col.required) {
                continueEl.hidden = false; // 集满即解锁继续（不强制录入——不惩罚跳过）
            }
            // (a) 收集成功 → 观察小剧本 → 控制台 → 打标签 → 录入（2026-09-07 闭环）
            openCollectFlow(it, flowCb, "chat");
        };
        btn.onclick = (e) => {
            e.stopPropagation();
            if (colState.has(it.id)) { // 已收集：重开控制台（补录入 / 回看资料）
                openCollectFlow(it, flowCb, "console", recordedState.has(it.id));
                return;
            }
            if (collectBusy) return;
            // 贴玻璃收集（2026-09-28 pixel-taka 规则 5）：塔卡游到该物的玻璃锚点贴上，再扫描收集。
            // 塔卡永远进不了墙内——nearTaka 旧门槛已随拱门边界模型退役。
            collectBusy = true;
            const [gx, gy] = glassAnchorOf(it);
            void swimTakaTo(taka, left, gx, gy, 900, 0).then(() => {
                collectBusy = false;
                if (!colState.has(it.id)) doCollect();
            });
        };
        if (colState.has(it.id)) btn.classList.add("collected");       // 恢复态样式
        if (recordedState.has(it.id)) btn.classList.add("recorded");   // 恢复态：暖黄常亮 ✓
        left.appendChild(btn);
    });

    /* 玻璃罩（2026-09-30 横切面世界观）：拱门弧线以下为隧道内部、塔卡永远进不去——
       统一光学处理（淡蓝 tint + 斜向高光 + 内缘细线）让「玻璃那边」一眼可辨。
       形状与 ARCH 同一数据源；罩在收集物/演员之上、塔卡之下（z 见 styles.css）。 */
    const glass = document.createElement("div");
    glass.className = "tunnel-glass";
    glass.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="tg-sheen" x1="0" y1="0" x2="0.85" y2="1">
            <stop offset="0" stop-color="rgba(255,255,255,0.15)"/>
            <stop offset="0.45" stop-color="rgba(255,255,255,0.03)"/>
            <stop offset="1" stop-color="rgba(150,205,245,0.12)"/>
        </linearGradient></defs>
        <ellipse cx="${ARCH.cx}" cy="${ARCH.cy}" rx="${ARCH.rx}" ry="${ARCH.ry}"
            fill="url(#tg-sheen)" stroke="rgba(235,248,255,0.26)" stroke-width="0.5"/>
    </svg>`;
    left.appendChild(glass);

    /* 翻页转场 */
    const old = front!;
    back!.style.visibility = "visible";
    if (old.innerHTML) {
        old.classList.add("turned");
        const oldRef = old;
        setTimeout(() => { oldRef.style.visibility = "hidden"; oldRef.classList.remove("turned"); }, 1000);
    }
    const tmp = front; front = back; back = tmp;

    // 窄屏（手机竖屏）提示横过来；横屏/平板由 CSS 隐藏
    if (window.innerWidth < 700) {
        const tip = document.createElement("div");
        tip.className = "collect-rotate";
        tip.innerHTML = `<div class="cr-phone" aria-hidden="true"></div><div class="cr-text">${t("book.collect_rotate")}</div>`;
        spread.appendChild(tip);
    }

    onDone(); // collect 节点无打字机文本，直接收尾
}

/** 防翻页回调串场：renderSceneBook 里已用 sceneSeq 守卫，这里对齐 */
function spreadSceneSeqGuard(): void { sceneSeq++; }
