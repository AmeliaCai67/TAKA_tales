import { uiIcon } from "./ui-icons";
// 横屏绘本模式 renderer（2026-08-31，plan: docs/superpowers/plans/2026-08-31-landscape-book-mode.md）
// 职责只有「场景怎么画」：spread 双缓冲翻页、右页气泡流（stagger 揭示 + 点击补完）、
// 左页构图（art/decor/塔卡定位/hotspot 物化）。状态机、语音、进度全在 engine.ts。
// 反向依赖 engine 只有一处导航回调，由 engine 模块尾部 initBookNav 注入（防循环 import）。
// 2026-10-03 mechanic 组件化 Phase 1：共享件下沉 scene-host.ts、collect 玩法下沉 mechanics/collect.ts（本模块只留宿主接线）。
import { pack } from "./pack";
import type { Scene } from "./story";
import { parseTextSegs } from "./speech";
import { wrapCodexIn } from "./codex";
import { figure, listenBar, parkChromeVN, loadActor, decorEl } from "./scene-host";
import { getMechanic } from "./mechanics/registry";
import type { MechanicHandle } from "./mechanics/types";
import { t } from "./i18n";

/* 共享件的既有对外导出（main 消费）经再导出保持不变；collect 相关再导出见文末玩法组件区 */
export { parkChromeVN, ENGINE_PIECE_URLS } from "./scene-host";

/* ---------- 导航注入 ---------- */
let navFn: (next: string, choiceText: string) => void = () => {};
export function initBookNav(fn: (next: string, choiceText: string) => void): void { navFn = fn; }

/* 话筒 hotspot 点按注入（2026-09-28）：engine 持有语音识别控制器，book 只画入口不碰状态机 */
let voiceFn: (() => void) | null = null;
export function initBookVoice(fn: (() => void) | null): void { voiceFn = fn; }

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

/** 翻页转场：旧页翻出 + 双缓冲交换（绘本场景与玩法组件共用；2026-10-03 自 renderSceneBook 尾部抽出） */
function flipSpread(): void {
    const old = front!;
    back!.classList.remove("turned"); // 双缓冲复用：1s 内连续翻页时 back 可能还挂着上一轮的 turned（转场未完）
    back!.style.visibility = "visible";
    if (old.innerHTML) {
        old.classList.add("turned");
        const oldRef = old;
        setTimeout(() => {
            if (front === oldRef) return; // 1s 内又翻了页、该 spread 已被双缓冲复用为当前页——绝不能藏当前页
            oldRef.style.visibility = "hidden";
            oldRef.classList.remove("turned");
        }, 1000);
    }
    const tmp = front; front = back; back = tmp;
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

/** 左页构建：背景/decor/常驻角色；withTaka 时把塔卡移入左页（VN↔绘本共用同一 DOM 节点，6 态灯光 CSS 零改动继承）。
 *  玩法场景（mechanic）传 withTaka=false——塔卡的挂载/定位/换装归玩法组件。 */
function buildLeftPage(scene: Scene, withTaka: boolean): HTMLElement {
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
    if (!withTaka) return left;
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
    return left;
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
    const left = buildLeftPage(scene, true);
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
    const header = document.createElement("header");
    header.className = "reader-page-header";
    header.appendChild(pagenum);
    right.prepend(header);
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
    flipSpread();
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
        btn.style.top = (h.y < 40 ? h.y + 10 : h.y) + "%"; // 上方纸签略下移，延续旧标签在图标下方的布局
        btn.dataset.actor = h.actor;
        btn.setAttribute("aria-label", c.text);
        const art = document.createElement("span");
        art.className = "actor";
        void loadActor(h.actor).then(svg => { if (svg) art.innerHTML = svg; });
        btn.appendChild(art);
        const label = document.createElement("span");
        label.className = "label story-choice-bubble";
        const detail = c.text.match(/^(.*?)([（(].*[）)])$/);
        const title = document.createElement("span");
        title.className = "hotspot-title";
        title.textContent = detail ? detail[1] : c.text;
        label.appendChild(title);
        if (detail) {
            const hint = document.createElement("span");
            hint.className = "hotspot-hint";
            hint.textContent = detail[2];
            label.appendChild(hint);
        }
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
        btn.dataset.actor = "mic";
        btn.setAttribute("aria-label", t("engine.voice_hotspot_label"));
        const art = document.createElement("span");
        art.className = "actor";
        art.innerHTML = ""; // mic 走引擎内置件（public/characters/mic.svg），异步注入
        void loadActor("mic").then(svg => { if (svg) art.innerHTML = svg; });
        btn.appendChild(art);
        const label = document.createElement("span");
        label.className = "label story-choice-bubble";
        label.textContent = t("engine.voice_hotspot_label");
        btn.appendChild(label);
        btn.onclick = (e) => { e.stopPropagation(); voiceTap(); };
        left.appendChild(btn);
    }
    // 合并纸签比旧图标更宽：按实际尺寸限制在左页内，保留包里的定位意图。
    requestAnimationFrame(() => {
        if (!left.isConnected || !left.clientWidth || !left.clientHeight) return;
        left.querySelectorAll<HTMLElement>(".hotspot").forEach(btn => {
            const halfW = btn.offsetWidth / 2 + 8;
            const halfH = btn.offsetHeight / 2 + 8;
            const x = parseFloat(btn.style.left) / 100 * left.clientWidth;
            const y = parseFloat(btn.style.top) / 100 * left.clientHeight;
            btn.style.left = Math.max(halfW, Math.min(left.clientWidth - halfW, x)) / left.clientWidth * 100 + "%";
            btn.style.top = Math.max(halfH, Math.min(left.clientHeight - halfH, y)) / left.clientHeight * 100 + "%";
        });
        // The small landscape canvas can clamp two controls onto the same point.
        const mic = left.querySelector<HTMLElement>('.mic-hotspot');
        if (mic && matchMedia('(pointer: coarse)').matches) {
            const bounds = left.getBoundingClientRect(), r = mic.getBoundingClientRect();
            const obstacles = [...left.querySelectorAll<HTMLElement>('.hotspot:not(.mic-hotspot), .taka-figure')].map(el => el.getBoundingClientRect());
            const clear = (x: number, y: number) => !obstacles.some(q => x < q.right + 8 && x + r.width > q.left - 8 && y < q.bottom + 8 && y + r.height > q.top - 8);
            if (!clear(r.left, r.top)) {
                const candidates: {x:number;y:number;distance:number}[] = [];
                for (let x = bounds.left + 8; x + r.width <= bounds.right - 8; x += 8) {
                    for (let y = bounds.top + 8; y + r.height <= bounds.bottom - 8; y += 8) {
                        if (clear(x,y)) candidates.push({x,y,distance:(x-r.left)**2+(y-r.top)**2});
                    }
                }
                candidates.sort((a,b)=>a.distance-b.distance);
                const spot = candidates[0];
                if (spot) {
                    mic.style.left = (spot.x - bounds.left + r.width / 2) / bounds.width * 100 + '%';
                    mic.style.top = (spot.y - bounds.top + r.height / 2) / bounds.height * 100 + '%';
                }
            }
        }
    });
    // 有物化选项时给第一次读绘本的孩子一句提示
    if (any && !sessionStorage.getItem("taka_book_hinted")) {
        sessionStorage.setItem("taka_book_hinted", "1");
        const hint = document.createElement("div");
        hint.className = "flip-hint";
        hint.innerHTML = uiIcon("tap") + t("book.tap_glow");
        left.appendChild(hint);
        setTimeout(() => hint.remove(), 6000);
    }
}

/* ---------- 玩法分发（2026-10-03 mechanic 组件化 Phase 2，plan: docs/superpowers/plans/2026-10-03-mechanic-component-architecture.md） ----------
   场景声明 mechanic → 包级 mechanics 查声明 → registry 按 type 找组件 → 交出画布（左页 host + 整页 spread）。
   本模块/引擎不认识任何具体玩法；声明缺失或类型未注册时 fail-soft 退化普通书页（文本流可读、选项可用）。
   新玩法接入 = mechanics/<type>.ts 实现组件 + registry.ts 加一行 import + story.json 加声明。 */
let activeMechanic: MechanicHandle | null = null;
let mechanicAchFn: ((id: string) => void) | null = null;

/** 玩法成就回调注入（engine 模块尾部调用，同 initBookNav 模式）：组件经 ctx.unlockAchievement 触发 */
export function initMechanicAchievement(fn: ((id: string) => void) | null): void { mechanicAchFn = fn; }

/** 离开玩法场景时调用（engine.renderScene 顶部 + exitToShelf）：还原立绘/卸监听/摘布局类；无玩法时为空操作 */
export function cleanupMechanic(): void {
    activeMechanic?.cleanup();
    activeMechanic = null;
}

/** 玩法场景渲染：宿主建 spread + 左页画布 → 先翻页 → 组件挂载（其 onDone/埋点等回调都发生在新页已成 front 之后） */
export function renderSceneMechanic(key: string, scene: Scene, onDone: () => void): void {
    const decl = scene.mechanic ? pack().mechanics?.[scene.mechanic] : undefined;
    const comp = decl ? getMechanic(decl.type) : undefined;
    if (!comp || !decl) {
        console.warn("[mechanics] 玩法声明缺失或类型未注册，退化普通书页:", scene.mechanic);
        renderSceneBook(key, scene, scene.text || "", onDone);
        return;
    }
    resetBook();
    ensureSpreads();
    parkChromeVN(); // 共享节点先归位，避免清空 spread 时销毁立绘/聆听条
    spreadSceneSeqGuard();
    const spread = back!;
    spread.innerHTML = "";
    spread.classList.remove("collect-mode"); // 清上一玩法遗留的整页布局（组件按需自加）
    const left = buildLeftPage(scene, false);
    spread.appendChild(left);
    flipSpread();
    activeMechanic = comp({
        sceneKey: key,
        scene,
        decl,
        host: left,
        spread,
        nav: (next, choiceText) => navFn(next, choiceText),
        unlockAchievement: (id) => mechanicAchFn?.(id),
        onDone,
    });
}

/** 防翻页回调串场：renderSceneBook 里已用 sceneSeq 守卫，这里对齐 */
function spreadSceneSeqGuard(): void { sceneSeq++; }
