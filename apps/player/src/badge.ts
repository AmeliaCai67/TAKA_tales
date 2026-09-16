// 按钮通知点（2026-08-27）：「如我所书 / 成就 / 记忆库」各有更新时，在对应顶栏按钮上亮一个橙黄点。
// 点击该按钮（打开面板）即清除；状态存 localStorage，返回书架仍显示未读点。

export type BadgeDomain = "books" | "ach" | "codex";
import { t } from "./i18n";
const KEY = "taka_badges";
const BTN: Record<BadgeDomain, string> = {
    books: '[data-act="books"]',
    ach: '[data-act="ach"]',
    codex: '[data-act="codex"]',
};

function read(): BadgeDomain[] {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]") as BadgeDomain[]; }
    catch { return []; }
}
function write(d: BadgeDomain[]): void {
    localStorage.setItem(KEY, JSON.stringify([...new Set(d)]));
}

/** 刷新当前 DOM 中按钮上的橙黄点（书架渲染后调用） */
export function renderBadges(): void {
    const s = new Set(read());
    for (const domain of Object.keys(BTN) as BadgeDomain[]) {
        const btn = document.querySelector(BTN[domain]);
        if (!btn) continue;
        let dot = btn.querySelector(".btn-dot") as HTMLElement | null;
        const on = s.has(domain);
        if (on && !dot) {
            dot = document.createElement("span");
            dot.className = "btn-dot";
            dot.title = t("badge.new_content");
            btn.appendChild(dot);
        }
        if (!on && dot) dot.remove();
    }
}

/** 置位/清除某域的通知点（更新时置 true；打开对应面板时清 false） */
export function setBadge(domain: BadgeDomain, on: boolean): void {
    const cur = read().filter(x => x !== domain);
    if (on) cur.push(domain);
    write(cur);
    renderBadges();
}

export function clearBadge(domain: BadgeDomain): void { setBadge(domain, false); }
