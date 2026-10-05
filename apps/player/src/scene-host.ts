// 场景渲染共享件（2026-10-03 mechanic 组件化 Phase 1 自 book.ts 抽出，plan: docs/superpowers/plans/2026-10-03-mechanic-component-architecture.md）
// 职责：引擎内置件注册表与加载、共享 DOM 节点借用（立绘/聆听条）、VN 归位、左页氛围件。
// book.ts（绘本宿主）与 mechanics/（玩法组件）共同依赖；本模块不依赖两者——单向依赖防循环。
import { pack } from "./pack";
import { preloadedSvg } from "./preload";

/* ---------- DOM 常驻件借用（VN ↔ 绘本切换时来回挂载） ---------- */
export const figure = () => document.getElementById("taka-figure")!;
export const listenBar = () => document.getElementById("listen-bar")!;

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
export const PIECE_BASE = import.meta.env.BASE_URL + "characters/";
const PIECES = new Set(["light", "coral", "deep", "shell", "sun", "waves", "screen", "green", "door", "mic", "pixel-taka"]);
/** boot 预载用：引擎内置件全量 URL（含 pixel-taka——换装点同步读暖缓存依赖它先载） */
export const ENGINE_PIECE_URLS: string[] = [...PIECES].map(n => PIECE_BASE + n + ".svg");

/* ---------- 角色 SVG 懒加载缓存（actor → svg 文本；失败 = null，hotspot 退化为光点） ---------- */
const actorCache = new Map<string, string | null>();
export async function loadActor(actor: string): Promise<string | null> {
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

/** 左页氛围件 */
export function decorEl(kind: string): HTMLElement {
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
