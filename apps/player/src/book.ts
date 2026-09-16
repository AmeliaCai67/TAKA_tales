// 横屏绘本模式 renderer（2026-08-31，plan: docs/superpowers/plans/2026-08-31-landscape-book-mode.md）
// 职责只有「场景怎么画」：spread 双缓冲翻页、右页气泡流（stagger 揭示 + 点击补完）、
// 左页构图（art/decor/塔卡定位/hotspot 物化）。状态机、语音、进度全在 engine.ts。
// 反向依赖 engine 只有一处导航回调，由 engine 模块尾部 initBookNav 注入（防循环 import）。
import { pack } from "./pack";
import type { Scene } from "./story";
import { parseTextSegs } from "./speech";
import { wrapCodexIn } from "./codex";
import { entryUnlocked } from "./codex";
import { openCollectFlow, closeCollectFlow, type FlowCallbacks } from "./collect-flow";
import { t } from "./i18n";

/* ---------- 导航注入 ---------- */
let navFn: (next: string, choiceText: string) => void = () => {};
export function initBookNav(fn: (next: string, choiceText: string) => void): void { navFn = fn; }

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

/* ---------- 角色 SVG 懒加载缓存（actor → svg 文本；失败 = null，hotspot 退化为光点） ---------- */
const actorCache = new Map<string, string | null>();
async function loadActor(actor: string): Promise<string | null> {
    const rel = pack().characters?.[actor];
    if (!rel) return null;
    if (actorCache.has(actor)) return actorCache.get(actor)!;
    try {
        const res = await fetch(pack().baseUrl + rel);
        const svg = res.ok ? await res.text() : null;
        actorCache.set(actor, svg);
        return svg;
    } catch { actorCache.set(actor, null); return null; }
}

/* ---------- 内置 hotspot 件（无需故事包资产的通用小物） ---------- */
const BUILTIN: Record<string, string> = {
    // 光斑：海面透下来的光（海底场景「游上去」的化身）
    light: `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="14" fill="rgba(255,240,190,.95)"/><circle cx="30" cy="30" r="24" fill="none" stroke="rgba(255,240,190,.5)" stroke-width="4"/></svg>`,
    // 珊瑚丛
    coral: `<svg viewBox="0 0 70 60" fill="none" stroke="#e2703a" stroke-width="7" stroke-linecap="round"><path d="M35 55 V30 M35 40 L20 26 M35 34 L50 20 M20 26 L14 14 M20 26 L28 15 M50 20 L56 9"/></svg>`,
    // 海下深处（回海底的化身）：向下的深蓝涡
    deep: `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="22" fill="rgba(10,30,56,.85)" stroke="rgba(140,190,225,.7)" stroke-width="3"/><path d="M30 16 V38 M20 30 L30 40 L40 30" fill="none" stroke="rgba(190,220,240,.95)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    // 贝壳（安静倾听的化身）
    shell: `<svg viewBox="0 0 100 90"><path d="M50 8 C78 8 92 34 92 52 C92 72 74 84 50 84 C26 84 8 72 8 52 C8 34 22 8 50 8 Z" fill="#f5dfc0" stroke="#d8b48a" stroke-width="4"/><path d="M50 14 L50 80 M30 20 L38 78 M70 20 L62 78" stroke="#d8b48a" stroke-width="3.5" fill="none"/></svg>`,
    // 太阳（再听一分钟的化身）
    sun: `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="14" fill="#ffd670" stroke="#f0a83e" stroke-width="3"/><g stroke="#f0a83e" stroke-width="3.5" stroke-linecap="round"><path d="M30 4 V10 M30 50 V56 M4 30 H10 M50 30 H56 M11 11 L15 15 M45 45 L49 49 M49 11 L45 15 M15 45 L11 49"/></g></svg>`,
    // 风/波纹（只是听的化身）
    waves: `<svg viewBox="0 0 70 40" fill="none" stroke="rgba(240,248,252,.95)" stroke-width="4.5" stroke-linecap="round"><path d="M6 12 Q20 4 34 12 T 62 12"/><path d="M6 24 Q20 16 34 24 T 62 24"/><path d="M14 35 Q26 28 38 35 T 62 35" opacity=".6"/></svg>`,
    // 旧屏幕（闪雪花的电视，ch03 explore：the old screen）
    screen: `<svg viewBox="0 0 70 56" fill="none"><rect x="4" y="4" width="62" height="42" rx="4" fill="#101a24" stroke="#5a6b78" stroke-width="3"/><path d="M8 42 L16 34 L24 40 L34 28 L44 38 L54 30 L62 36" stroke="#cfd8e0" stroke-width="3" fill="none" opacity=".9"/><path d="M12 10 H58 M12 18 H50" stroke="#6b7a86" stroke-width="2" opacity=".5"/><rect x="26" y="46" width="18" height="4" fill="#39424c"/></svg>`,
    // 绿灯（插着电的录音机/指示灯，ch03 explore：green light）
    green: `<svg viewBox="0 0 60 60"><rect x="8" y="14" width="44" height="34" rx="5" fill="#1d2a33" stroke="#4a5a66" stroke-width="3"/><circle cx="30" cy="31" r="12" fill="#37d67a" stroke="#bff5d4" stroke-width="2.5"/><circle cx="30" cy="31" r="5" fill="#e8fff2"/><path d="M20 49 H40" stroke="#4a5a66" stroke-width="3" stroke-linecap="round"/></svg>`,
    // 关着的门（ch03 explore：the closed door）
    door: `<svg viewBox="0 0 60 76" fill="none"><rect x="16" y="6" width="28" height="64" rx="3" fill="#3a4750" stroke="#5a6a74" stroke-width="3"/><rect x="19" y="9" width="22" height="58" fill="none" stroke="#67767f" stroke-width="2"/><circle cx="39" cy="40" r="2.6" fill="#ffb703"/><path d="M6 70 H54 M28 6 V70" stroke="#4a5660" stroke-width="3"/></svg>`,
    // 混着水稻的草坪（ch04 收集物）
    grass: `<svg viewBox="0 0 120 80"><rect x="0" y="50" width="120" height="30" fill="#3f9b57"/><rect x="0" y="50" width="120" height="5" fill="#2f7d43"/><path d="M12 52 Q14 38 18 32 Q21 40 23 52" fill="#5cba6e"/><path d="M28 52 Q30 36 34 30 Q37 40 39 52" fill="#4fae63"/><path d="M44 52 Q46 40 50 34 Q52 42 54 52" fill="#5cba6e"/><path d="M60 52 L60 24" stroke="#c9a23a" stroke-width="2.5"/><ellipse cx="60" cy="20" rx="3.4" ry="9" fill="#e2c04f"/><path d="M76 52 L76 24" stroke="#c9a23a" stroke-width="2.5"/><ellipse cx="76" cy="20" rx="3.4" ry="9" fill="#e2c04f"/><path d="M90 52 Q92 38 96 32 Q99 40 101 52" fill="#4fae63"/><path d="M104 52 Q106 40 109 35 Q111 42 113 52" fill="#5cba6e"/></svg>`,
    // 拍打海底隧道墙壁的猫猫（ch04 收集物，可爱）
    cat: `<svg viewBox="0 0 100 92"><rect x="0" y="6" width="100" height="11" rx="4" fill="#8fa3b8"/><rect x="0" y="6" width="100" height="3" fill="#a9bccf"/><ellipse cx="45" cy="60" rx="27" ry="21" fill="#f0a83e"/><circle cx="57" cy="34" r="17" fill="#f0a83e"/><path d="M47 21 L50 11 L58 21 Z" fill="#ffb703"/><path d="M60 19 L67 10 L68.5 23 Z" fill="#ffb703"/><circle cx="53" cy="32" r="4.4" fill="#2b2b2b"/><circle cx="63" cy="32" r="4.4" fill="#2b2b2b"/><circle cx="54.4" cy="30.8" r="1.6" fill="#fff"/><circle cx="64.4" cy="30.8" r="1.6" fill="#fff"/><path d="M57 39 Q60 42 63 39" stroke="#8a5a1a" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M68 54 Q84 44 89 24" stroke="#f0a83e" stroke-width="10" stroke-linecap="round" fill="none"/><circle cx="89" cy="22" r="6.5" fill="#ffb703"/><circle cx="87" cy="20" r="1.6" fill="#fff"/><path d="M20 62 Q7 58 5 45" stroke="#f0a83e" stroke-width="8" stroke-linecap="round" fill="none"/><path d="M33 54 Q38 57 40 56" stroke="#8a5a1a" stroke-width="2" fill="none"/></svg>`,
    // 花朵边的蜜蜂与蝴蝶（ch04 收集物）
    bee: `<svg viewBox="0 0 110 92"><path d="M24 74 L26 86" stroke="#4fae63" stroke-width="4"/><circle cx="24" cy="60" r="13" fill="#ff7aa2"/><circle cx="24" cy="60" r="5.5" fill="#ffd670"/><ellipse cx="66" cy="38" rx="15" ry="11" fill="#ffd24b"/><rect x="53" y="32" width="6" height="13" rx="2.5" fill="#2b2b2b"/><rect x="66" y="32" width="6" height="13" rx="2.5" fill="#2b2b2b"/><ellipse cx="55" cy="30" rx="6" ry="5" fill="#2b2b2b"/><circle cx="53" cy="29" r="1.5" fill="#fff"/><path d="M79 32 Q92 24 100 26" stroke="#cfe0ee" stroke-width="1.6" fill="none" opacity=".9"/><path d="M79 38 Q94 32 102 38" stroke="#cfe0ee" stroke-width="1.6" fill="none" opacity=".9"/><circle cx="90" cy="46.5" r="2.6" fill="#8a8a8a"/><path d="M88.7 44.6 Q85.5 41 82.8 41.4 M91.3 44.6 Q94.5 41 97.2 41.4" stroke="#8a8a8a" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M89.5 51 Q79 45 77 36 Q87 39 90 49.5 Z" fill="#ff8fb0"/><path d="M90.5 51 Q101 45 103 36 Q93 39 90 49.5 Z" fill="#ff8fb0"/><path d="M89.5 52 Q81 54 78.5 59.5 Q86.5 58.5 90 54 Z" fill="#ffb0c8"/><path d="M90.5 52 Q99 54 101.5 59.5 Q93.5 58.5 90 54 Z" fill="#ffb0c8"/><path d="M90 50 V62" stroke="#8a8a8a" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

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

/** 说话人显示名：seg.who 是声线 id，反查 speakers 表；narrator 无名牌 */
function whoLabel(who: string): { name: string; cls: string } {
    if (who === "narrator") return { name: "", cls: "narr" };
    const takaEntry = Object.entries(pack().speakers).find(([, v]) => v === "taka");
    if (who === "taka") return { name: takaEntry?.[0] || "TAKA", cls: "taka-b" };
    const entry = Object.entries(pack().speakers).find(([, v]) => v === who);
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
        const builtin = BUILTIN[a.actor];
        if (builtin) d.innerHTML = builtin;
        else void loadActor(a.actor).then(svg => { if (svg) d.innerHTML = svg; });
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

/* ---------- hotspot 物化（选项打字播完后上左页；engine.mountChoices 调用） ---------- */
export function renderHotspots(scene: Scene): void {
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
        const builtin = BUILTIN[h.actor];
        if (builtin) {
            art.innerHTML = builtin;
        } else {
            void loadActor(h.actor).then(svg => { if (svg) art.innerHTML = svg; });
        }
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

/** 离开 collect 场景时卸掉塔卡拖拽监听（防止串到普通书台/VN 场景）+ 关掉收集闭环面板 */
export function cleanupCollectDrag(): void { if (detachDrag) detachDrag(); closeCollectFlow(); }

let detachDrag: (() => void) | null = null; // 塔卡拖拽清理函数（离开 collect 时卸掉旧监听）

/** 塔卡中心到收集物的像素距离（判断「走近了没有」） */
function nearTaka(taka: HTMLElement, btn: HTMLElement, left: HTMLElement): boolean {
    const tr = taka.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const dx = (tr.left + tr.width / 2) - (br.left + br.width / 2);
    const dy = (tr.top + tr.height / 2) - (br.top + br.height / 2);
    const th = Math.max(130, left.clientWidth * 0.11); // 拖近阈值：宽屏自适应
    return Math.hypot(dx, dy) < th;
}

/** 塔卡在 collect 页内可拖拽（pointer + setPointerCapture，移动端灵敏） */
function makeTakaDraggable(taka: HTMLElement, left: HTMLElement): void {
    if (detachDrag) detachDrag();
    let dragging = false, sx = 0, sy = 0, startL = 0, startT = 0;
    taka.style.touchAction = "none";
    const down = (e: PointerEvent) => {
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
        taka.style.left = nl + "%";
        taka.style.top = nt + "%";
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
        const builtin = BUILTIN[a.actor];
        if (builtin) d.innerHTML = builtin;
        else void loadActor(a.actor).then(svg => { if (svg) d.innerHTML = svg; });
        left.appendChild(d);
    }
    spread.appendChild(left);

    /* 收集进度角标 */
    const countEl = document.createElement("div");
    countEl.className = "collect-count";
    countEl.textContent = `${colState.size} / ${col.required}`;  // 恢复态计入（已录入的物品）
    left.appendChild(countEl);

    /* 塔卡：移入左页，可拖拽（先于物品创建，供 onclick 就近判断） */
    const taka = figure();
    left.appendChild(taka);
    const tp = scene.book?.taka || {};
    taka.style.left = (tp.x ?? 28) + "%";
    taka.style.top = (tp.y ?? 52) + "%";
    taka.style.width = (tp.size ?? 30) + "%";
    (taka.querySelector("svg") as SVGSVGElement).style.transform = "";
    makeTakaDraggable(taka, left);

    // 首次进入收集页：提示「长按塔卡拖动」（flip-hint 同款漂浮，指向塔卡）
    if (!sessionStorage.getItem("taka_collect_hinted")) {
        sessionStorage.setItem("taka_collect_hinted", "1");
        const h = document.createElement("div");
        h.className = "flip-hint collect-hint";
        h.textContent = t("book.collect_hint");
        left.appendChild(h);
        setTimeout(() => h.remove(), 9000);
    }

    /* 集满后可点「继续」 */
    const continueEl = document.createElement("button");
    continueEl.className = "collect-continue";
    continueEl.hidden = true;
    continueEl.textContent = t("book.collect_continue");
    continueEl.onclick = () => navFn(col.next!, "");
    spread.appendChild(continueEl);
    if (colState.size >= col.required) continueEl.hidden = false;  // 恢复态：早已集满

    /* 物化物品 */
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
        const builtin = BUILTIN[it.actor];
        if (builtin) a.innerHTML = builtin;
        else void loadActor(it.actor).then(svg => { if (svg) a.innerHTML = svg; });
        btn.appendChild(a);
        if (it.label) {
            const label = document.createElement("span");
            label.className = "label" + (it.y < 40 ? " below" : "");
            label.textContent = it.label;
            btn.appendChild(label);
        }
        btn.onclick = (e) => {
            e.stopPropagation();
            if (colState.has(it.id)) { // 已收集：重开控制台（补录入 / 回看资料）
                openCollectFlow(it, flowCb, "console", recordedState.has(it.id));
                return;
            }
            if (!nearTaka(taka, btn, left)) { // 还没走近：提示「再靠近一点」
                btn.classList.add("want");
                setTimeout(() => btn.classList.remove("want"), 600);
                return;
            }
            colState.add(it.id);
            btn.classList.add("collected");
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
        if (colState.has(it.id)) btn.classList.add("collected");       // 恢复态样式
        if (recordedState.has(it.id)) btn.classList.add("recorded");   // 恢复态：暖黄常亮 ✓
        left.appendChild(btn);
    });

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
