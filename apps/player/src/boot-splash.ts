import { loadingSound } from "./sfx";
import { t } from "./i18n";
/* ===== 启动闪屏（2026-09-28，spec: docs/superpowers/specs/2026-09-28-boot-preload-loading-ux.md）=====
   元素在 index.html 静态就位（内联 CSS，首帧即见）；显隐用 .bs-out 类而非 hidden 属性
   （本仓老坑：class 的 display 会盖掉 hidden 语义，.bs-out 用 opacity+visibility 双断）。 */

let stopLoadingSound: (() => void) | null = null;
let splashStatusOverride = false;
export function splashProgress(pct: number): void {
    const el = document.getElementById('boot-splash');
    const progress = Math.max(0, Math.min(100, pct));
    el?.style.setProperty('--boot-progress', String(progress / 100));
    el?.setAttribute('aria-valuenow', String(progress));
    el?.setAttribute('aria-label', t('boot.loading'));
    if (!splashStatusOverride) {
        const key = progress < 30 ? 'boot.charging' : progress < 85 ? 'boot.bubbles' : 'boot.surface';
        const status = document.getElementById('bs-status');
        if (status) { status.textContent = t(key); status.dataset.i18n = key; }
    }
}
export function splashShow(statusText: string): void {
    stopLoadingSound?.();
    stopLoadingSound = loadingSound();
    const el = document.getElementById("boot-splash");
    if (!el) return;
    el.classList.remove("bs-out");
    splashStatusOverride = true;
    splashProgress(0);
    const st = document.getElementById("bs-status");
    if (st) { st.removeAttribute("data-i18n"); st.textContent = statusText; }
}
export function splashHide(): void {
    stopLoadingSound?.(); stopLoadingSound = null;
    document.getElementById("boot-splash")?.classList.add("bs-out");
}
