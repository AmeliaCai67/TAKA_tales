// 收集小游戏玩法组件（2026-09 第四章「你好，757」；2026-10-03 mechanic 组件化 Phase 2 对齐契约，
// plan: docs/superpowers/plans/2026-10-03-mechanic-component-architecture.md）
// 职责：收集页整页渲染（横屏/整页/塔卡可拖/拱门边界/像素换装/物化收集/游动路由/兴趣侦测）
//       + 收集闭环入口（观察小剧本→控制台→打标签→录入，实现在 collect-flow.ts）。
// 数据全部来自包级 mechanics 声明（decl）：物品/目标数/成就/跳转 + 拱门几何/绕行点/换装件/玻璃罩；
// 宿主（book.ts renderSceneMechanic）只给画布——spread 生命周期、翻页、导航、成就回调经 MechanicCtx 注入。
import { pack } from "../pack";
import { t, lang } from "../i18n";
import { entryUnlocked } from "../codex";
import { preloadedSvg, warmAudio } from "../preload";
import { reportEvent } from "../events";
import { speechPref } from "../settings";
import { figure, loadActor, decorEl, PIECE_BASE } from "../scene-host";
import { openCollectFlow, closeCollectFlow, type FlowCallbacks } from "./collect-flow";
import type { CollectDecl, CollectItem, MechanicCtx, MechanicHandle } from "./types";

let detachDrag: (() => void) | null = null; // 塔卡拖拽清理函数（离开 collect 时卸掉旧监听）
let takaOrigHtml: string | null = null;     // 换装的还原底片（离开 collect 场景恢复普通立绘）

/* ===== 拱门边界模型（2026-09-28 pixel-taka，plan: docs/ux/ch4-pixel-taka.md）=====
   背景图金色窗框内缘 ≈ 半椭圆（页面 % 坐标，书台固定 16:9 与图同比例，% 线性对齐）。
   archVal > 1 = 禁入区外（塔卡可达）；≤ 1 = 禁入区内（塔卡永不可达）。
   几何自 decl.bounds 注入（mount 时覆盖）；缺省 = ch04 tunnel-deep.jpg 的拱门椭圆。
   （v2 曾改对角墙带+自绘 SVG，用户否决后回滚椭圆——背景不动，物品全在拱门内按真实关系摆放。） */
const DEFAULT_BOUNDS = { cx: 50, cy: 90, rx: 45, ry: 70 };
const DEFAULT_BYPASS: [number, number][] = [[15, 10], [50, 4], [85, 10]];
let arch = DEFAULT_BOUNDS;
let bypass = DEFAULT_BYPASS;
const archVal = (x: number, y: number): number =>
    ((x - arch.cx) / arch.rx) ** 2 + ((y - arch.cy) / arch.ry) ** 2;
/** 目标点收进墙外：墙内 → 沿「椭圆中心→目标」径向投影回墙线，再外推 2.5% 余量（贴玻璃而非穿墙） */
function clampOutsideArch(x: number, y: number): [number, number] {
    if (archVal(x, y) > 1) return [x, y];
    const dx = x - arch.cx, dy = y - arch.cy;
    const t = 1 / Math.sqrt((dx / arch.rx) ** 2 + (dy / arch.ry) ** 2);
    const bx = arch.cx + dx * t, by = arch.cy + dy * t;
    const k = 1 + 2.5 / Math.max(1, Math.hypot(bx - arch.cx, by - arch.cy));
    return [arch.cx + (bx - arch.cx) * k, arch.cy + (by - arch.cy) * k];
}
/** 收集物的「玻璃锚点」：物品中心（在墙内）径向投影到墙线外——塔卡观察它的对应贴墙位 */
function glassAnchorOf(it: CollectItem): [number, number] { return clampOutsideArch(it.x, it.y); }

/** 直线段是否穿过禁入区：等距采样，任一点 archVal<1 即穿越 */
function crossesArch(x1: number, y1: number, x2: number, y2: number): boolean {
    for (let i = 1; i < 12; i++) {
        const t = i / 12;
        if (archVal(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t) < 1) return true;
    }
    return false;
}
/* 绕行点（禁入区外必合法）：左顶 / 顶 / 右顶（decl.bypass 可覆盖）。
   端点钳制只管落点不管路径——左右穿场时会从拱门正中游过去（用户 2026-09-28 圈出「塔卡不能走到这片区域内」），
   因此长途移动一律路由：同侧穿越→本侧绕行点；左右穿场→左→顶→右三点。 */
function routeOutside(sx: number, sy: number, tx: number, ty: number): [number, number][] {
    if (!crossesArch(sx, sy, tx, ty)) return [[tx, ty]];
    const leftOf = (v: number) => v < arch.cx;
    if (leftOf(sx) === leftOf(tx)) return [leftOf(sx) ? bypass[0] : bypass[2], [tx, ty]];
    return [leftOf(sx) ? bypass[0] : bypass[2], bypass[1], leftOf(tx) ? bypass[0] : bypass[2], [tx, ty]];
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

/** 收集页挂载（2026-10-03 Phase 2 契约化：宿主已建 spread + 左页画布并翻页，本函数只做玩法本身）。
 *  布局类（collect-mode/collect-active/collect-page）由组件自理——宿主与引擎不认识任何玩法的类名。 */
export function mountCollect(ctx: MechanicCtx): MechanicHandle {
    const col = ctx.decl as CollectDecl;
    arch = col.bounds ?? DEFAULT_BOUNDS;   // 几何参数自声明注入（同数据源供闸口/路由/玻璃罩）
    bypass = col.bypass ?? DEFAULT_BYPASS;

    ctx.spread.classList.add("collect-mode");   // 左页全幅、右页隐藏
    document.body.classList.add("collect-active");
    const left = ctx.host;
    left.classList.add("collect-page");

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
            if (recordedState.size >= col.required) ctx.unlockAchievement(col.achievement || "");
        },
    };

    /* 收集进度角标 */
    const countEl = document.createElement("div");
    countEl.className = "collect-count";
    countEl.textContent = `${colState.size} / ${col.required}`;  // 恢复态计入（已录入的物品）
    left.appendChild(countEl);

    /* 塔卡：移入左页 + 换装（decl.takaSkin 声明时；ch04 = pixel-taka「老机器接入隧道旧摄像头」监控画质，
       离开由 cleanup 还原）。皮肤解析与 loadActor 同源两级：包 characters 注册 > 引擎内置件。 */
    const taka = figure();
    left.appendChild(taka);
    const tp = ctx.scene.book?.taka || {};
    taka.style.left = (tp.x ?? 28) + "%";
    taka.style.top = (tp.y ?? 52) + "%";
    taka.style.width = (tp.size ?? 30) + "%";
    (taka.querySelector("svg") as SVGSVGElement).style.transform = "";
    if (col.takaSkin) {
        // 同步读 boot 预载暖缓存（引擎内置件已随 splash 预载）；万一未命中则异步补拉，
        // px-mode 守卫防「已离开 collect 才到货」把像素版注回普通立绘
        const rel = pack().characters?.[col.takaSkin];
        const skinUrl = rel ? pack().baseUrl + rel : PIECE_BASE + col.takaSkin + ".svg";
        if (takaOrigHtml === null) takaOrigHtml = taka.innerHTML;
        taka.innerHTML = preloadedSvg(skinUrl) ?? "";
        if (!taka.innerHTML) void loadActor(col.takaSkin).then(svg => {
            if (svg && taka.classList.contains("px-mode")) taka.innerHTML = svg;
        });
        taka.classList.add("px-mode", "px-idle");
    }

    const tEnter = Date.now(); // 埋点基准：首次成功交互耗时
    reportEvent({ type: "collect_scene_enter" });

    /* 扫描线转场：接入旧摄像头信号（~900ms 自毁） */
    const scanIn = document.createElement("div");
    scanIn.className = "collect-scanin";
    ctx.spread.appendChild(scanIn);
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
    continueEl.onclick = () => ctx.nav(col.next!, "");
    ctx.spread.appendChild(continueEl);
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
       形状与 bounds 同一数据源；罩在收集物/演员之上、塔卡之下（z 见 styles.css）。 */
    if (col.glass) {
        const glass = document.createElement("div");
        glass.className = "tunnel-glass";
        glass.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="tg-sheen" x1="0" y1="0" x2="0.85" y2="1">
                <stop offset="0" stop-color="rgba(255,255,255,0.15)"/>
                <stop offset="0.45" stop-color="rgba(255,255,255,0.03)"/>
                <stop offset="1" stop-color="rgba(150,205,245,0.12)"/>
            </linearGradient></defs>
            <ellipse cx="${arch.cx}" cy="${arch.cy}" rx="${arch.rx}" ry="${arch.ry}"
                fill="url(#tg-sheen)" stroke="rgba(235,248,255,0.26)" stroke-width="0.5"/>
        </svg>`;
        left.appendChild(glass);
    }

    // 窄屏（手机竖屏）提示横过来；横屏/平板由 CSS 隐藏
    if (window.innerWidth < 700) {
        const tip = document.createElement("div");
        tip.className = "collect-rotate";
        tip.innerHTML = `<div class="cr-phone" aria-hidden="true"></div><div class="cr-text">${t("book.collect_rotate")}</div>`;
        ctx.spread.appendChild(tip);
    }

    ctx.onDone(); // collect 节点无打字机文本，直接收尾

    return {
        cleanup: () => {
            if (detachDrag) detachDrag();
            closeCollectFlow();
            const f = document.getElementById("taka-figure");
            if (f && f.classList.contains("px-mode") && takaOrigHtml !== null) {
                f.innerHTML = takaOrigHtml; // 还原普通立绘（像素塔卡是 collect 场景的监控画质限定）
                f.classList.remove("px-mode", "px-swim", "px-scan", "px-interested");
            }
            document.body.classList.remove("collect-active");
            ctx.spread.classList.remove("collect-mode");
        },
    };
}
// 注册在 registry.ts 显式完成（registerMechanic("collect", mountCollect)）——组件不反向 import 注册表，防模块环
