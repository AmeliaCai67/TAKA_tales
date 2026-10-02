// 图片预加载（2026-09-28，spec: docs/superpowers/specs/2026-09-28-boot-preload-loading-ux.md）
// 解决的痛点：①boot 期间无 loading 露出无内容故事页；②慢网下场景背景/角色/词条图按需加载迟到。
// 策略：启动时预载「全部封面 + 首包全部图」→ 书架点异包带进度预载 → 书架闲时预取其余包。
// 兜底原则：任何一张图失败/超时都不阻塞流程，降级为现状的按需加载。
import type { StoryPack } from "./story";

const CONCURRENCY = 6;
const PER_IMAGE_TIMEOUT = 15000;
const SOFT_CAP = 25000; // 整体软上限：超时放行，剩余后台继续

const loaded = new Set<string>();          // 全局去重（含进行中，避免闲时预取与 splash 重复拉）
const pool: HTMLImageElement[] = [];       // pin 池：持引用防内存缓存逐出（仅启动关键集 pin）
const svgText = new Map<string, string>(); // SVG 文本缓存（book.ts loadActor 直取，省 304 往返）

/** 收集一个故事包的全部图片 URL（背景/绘本 art/角色 SVG/词条图/封面），绝对路径去重 */
export function collectPackImages(p: StoryPack): string[] {
    const rels = new Set<string>();
    for (const sc of Object.values(p.scenes)) {
        if (sc.background) rels.add(sc.background);
        if (sc.book?.art) rels.add(sc.book.art);
    }
    for (const rel of Object.values(p.characters || {})) rels.add(rel);
    for (const e of p.codex?.entries || []) rels.add(e.image);
    if (p.cover) rels.add(p.cover);
    return [...rels].map(r => p.baseUrl + r);
}

/** book.ts 用：命中预载的 SVG 文本则省去 fetch（不弹出——同 URL 多次使用也允许，文本缓存常驻） */
export function preloadedSvg(url: string): string | undefined {
    return svgText.get(url);
}

interface LoadOneOptions { pin: boolean }

function loadImage(url: string, opts: LoadOneOptions): Promise<void> {
    return new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => { img.src = ""; resolve(); }, PER_IMAGE_TIMEOUT);
        const done = () => {
            clearTimeout(timer);
            if (opts.pin) pool.push(img);
            resolve();
        };
        img.onload = done;
        img.onerror = done; // 失败不阻塞：场景内按需加载会再试
        img.src = url;
    });
}

async function loadOne(url: string, opts: LoadOneOptions): Promise<void> {
    if (url.endsWith(".svg")) {
        // SVG 走 fetch：文本入缓存供 loadActor 直接用（innerHTML 注入场景），同时暖 HTTP 缓存
        try {
            const res = await fetch(url);
            if (res.ok) svgText.set(url, await res.text());
        } catch { /* 失败不阻塞 */ }
        return;
    }
    await loadImage(url, opts);
}

/** 并发预载一组 URL。onProgress(loaded, total) 每张结算一次；软上限后 resolve（剩余后台继续）。 */
export function preloadImages(
    urls: string[],
    onProgress?: (loaded: number, total: number) => void,
    opts: LoadOneOptions = { pin: true }
): Promise<void> {
    const fresh = urls.filter(u => !loaded.has(u));
    fresh.forEach(u => loaded.add(u));
    const total = fresh.length;
    let done = 0;
    // e2e 断言钩子：仅 splash 驱动（带进度回调）的调用更新，闲时预取不覆盖
    if (onProgress) (window as any).__takaPreload = { loaded: 0, total };

    if (total === 0) { onProgress?.(0, 0); return Promise.resolve(); }

    let resolveAll: () => void;
    const all = new Promise<void>(r => { resolveAll = r; });
    const queue = [...fresh];
    const worker = async () => {
        while (queue.length) {
            const url = queue.shift()!;
            await loadOne(url, opts);
            done++;
            if (onProgress) {
                (window as any).__takaPreload.loaded = done;
                onProgress(done, total);
            }
        }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, worker);
    Promise.all(workers).then(() => resolveAll());
    // 软上限：到点放行（splash 不卡死），workers 后台继续跑完
    const cap = new Promise<void>(r => setTimeout(r, SOFT_CAP));
    return Promise.race([all, cap]);
}

/** 音频预热（2026-09-28 collect UX）：后台低优先级 fetch 暖 HTTP 缓存，播放链到点即取；失败静默 */
export function warmAudio(urls: string[]): void {
    for (const u of urls) {
        if (loaded.has(u)) continue;
        loaded.add(u);
        fetch(u).then(r => { if (r.ok) return r.blob(); }).catch(() => {});
    }
}

/** 闲时预取（书架停留期间）：低并发、不 pin、共享去重；Safari 无 requestIdleCallback 用 setTimeout 兜底 */
export function idlePreload(urls: string[]): void {
    const fresh = urls.filter(u => !loaded.has(u));
    if (!fresh.length) return;
    const ric: (cb: () => void) => void =
        (window as any).requestIdleCallback
            ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 4000 })
            : (cb) => setTimeout(cb, 1500);
    const step = () => {
        const batch = fresh.splice(0, 2);
        if (!batch.length) return;
        void preloadImages(batch, undefined, { pin: false }).then(() => ric(step));
    };
    ric(step);
}
