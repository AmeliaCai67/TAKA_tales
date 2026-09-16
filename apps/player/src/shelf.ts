// 故事书架：进大门后的选故事界面（多故事的入口框架，M6 前奏）
// 角标三态：新故事 / 进行中 / 已读完·再听一遍；卡片附成就计数
// 登录后左上角可切换孩子（切换后角标/成就随孩子隔离的存储而变）
import { loadStoriesIndex } from "./story";
import { ICON_CHILD } from "./icons";
import type { StoryMeta } from "./story";
import { session, selectedChild } from "./session";
import { selectChild, openParentModal } from "./auth";
import { openArchive } from "./archive";
import { openCodexPanel } from "./codex";
import { switchLang } from "./main";
import { lang, t } from "./i18n";
import { loadLocalProgress } from "./progress";
import { speechPref } from "./settings";
import { renderBadges, clearBadge } from "./badge";
import { unlockedAchievementIds } from "./achievements";

let pickHandler: (s: StoryMeta) => void = () => {};

export function initShelf(onPick: (s: StoryMeta) => void): void {
    pickHandler = onPick;
}

export function shelfVisible(): boolean {
    const el = document.getElementById("shelf-screen");
    return !!el && !el.hidden;
}

export function hideShelf(): void {
    document.getElementById("shelf-screen")!.hidden = true;
    document.body.classList.remove("on-shelf");
}

export function showShelf(): void {
    const el = document.getElementById("shelf-screen")!;
    el.hidden = false;
    document.body.classList.add("on-shelf"); // 书架模式：藏起 emoji 工具组，换 iBooks 风顶栏
    void render(el);
}

function badgeOf(s: StoryMeta): { cls: string; text: string } {
    const p = loadLocalProgress(s.id);
    if (!p) return { cls: "new", text: t("shelf.badge_new") };
    if (p.lastEnding) return { cls: "done", text: t("shelf.badge_done") };
    return { cls: "going", text: t("shelf.badge_going") };
}

async function render(el: HTMLElement): Promise<void> {
    const stories = await loadStoriesIndex();
    if (!shelfVisible()) return; // 拉索引期间已进故事，别覆盖

    const child = selectedChild();
    const chip = session.token
        ? `<button class="shelf-child" id="shelf-child-btn"><span class="sc-fish">${ICON_CHILD}</span>${child ? child.nickname : t("shelf.pick_child")} ▾</button>`
        : "";
    const unlocked = new Set(unlockedAchievementIds());
    const cards = stories.map(s => {
        // i18n：en 模式用 index.json 的 alt.en 字段（sync-content 内联）
        const title = lang === "en" ? (s.alt?.en?.title || s.title) : s.title;
        const summary = lang === "en" ? (s.alt?.en?.summary || s.summary) : s.summary;
        const b = badgeOf(s);
        const got = s.achIds.filter(id => unlocked.has(id)).length;
        const ach = s.achIds.length ? `<span class="sc-ach">🏅 ${got}/${s.achIds.length}</span>` : "";
        const cover = s.cover
            ? `<img class="sc-cover" src="${s.cover}" alt="${title} cover">`
            : `<div class="sc-cover sc-cover-empty">${t("shelf.cover_fallback")}</div>`;
        return `<button class="shelf-card" data-id="${s.id}">
            ${cover}
            <div class="sc-body">
                <div class="sc-title">${title}</div>
                <div class="sc-summary">${summary || ""}</div>
                <div class="sc-foot"><span class="sc-badge ${b.cls}">${b.text}</span>${ach}</div>
            </div>
        </button>`;
    }).join("");

    el.innerHTML = `
        <div class="shelf-topbar">
            <div class="st-actions">
                ${chip}
                <button data-act="books">${t("shelf.books")}</button>
                <button data-act="codex">${t("shelf.codex")}</button>
                <button data-act="ach">${t("shelf.ach")}</button>
                <button data-act="speech">${speechPref.on ? t("shelf.speech_on") : t("shelf.speech_off")}</button>
                <button data-act="settings">${t("shelf.settings")}</button>
                <button class="lang-toggle" data-act="lang">中 / EN</button>
                ${session.token ? "" : `<button data-act="parent">${t("shelf.parent")}</button>`}
            </div>
        </div>
        <div class="shelf-inner">
            <div class="shelf-title">${t("shelf.title")}</div>
            <div class="shelf-grid">${cards}</div>
        </div>`;

    // 顶栏按钮复用隐藏 emoji 按钮的既有接线（成就/语音/设置）；「家 长」仅未登录显示（spec §2.4）
    el.querySelector('[data-act="books"]')!.addEventListener("click", () => { clearBadge("books"); void openArchive(); });
    el.querySelector('[data-act="codex"]')!.addEventListener("click", () => { clearBadge("codex"); void openCodexPanel(); });
    el.querySelector('[data-act="ach"]')!.addEventListener("click", () => { clearBadge("ach"); document.getElementById("ach-btn")!.click(); });
    el.querySelector('[data-act="settings"]')!.addEventListener("click", () => document.getElementById("settings-btn")!.click());
    el.querySelector('[data-act="parent"]')?.addEventListener("click", () => void openParentModal());
    el.querySelector('[data-act="lang"]')!.addEventListener("click", () => void switchLang(lang === "zh" ? "en" : "zh"));
    el.querySelector('[data-act="speech"]')!.addEventListener("click", () => {
        document.getElementById("speech-btn")!.click();
        showShelf(); // 重渲刷新「语音 · 开/关」文案
    });
    renderBadges(); // 按 localStorage 未读状态，给「如我所书/成就/记忆库」按钮加橙黄点

    el.querySelectorAll<HTMLElement>(".shelf-card").forEach(card => {
        card.onclick = () => {
            const s = stories.find(x => x.id === card.dataset.id);
            if (s) pickHandler(s);
        };
    });

    const chipBtn = el.querySelector<HTMLElement>("#shelf-child-btn");
    if (chipBtn) chipBtn.onclick = (e) => { e.stopPropagation(); toggleChildMenu(el, chipBtn); };
}

/** 打开家长后台：VITE_PARENT_URL 可配置（本地 dev 指向 vite 5173），默认同源 /parent/。
 *  2026-08-18 起不再 hash 交接 token——后台改为 sessionStorage 独立会话 + 邮箱验证码门槛
 *  （spec §3）：每次新标签进后台都要重新验明家长在场，防孩子乱点。 */
function openParentDashboard(): void {
    const base = ((import.meta.env?.VITE_PARENT_URL as string | undefined) || "/parent/").replace(/\/?$/, "/");
    window.open(base, "_blank");
}

function toggleChildMenu(el: HTMLElement, anchor: HTMLElement): void {
    const old = el.querySelector("#shelf-child-menu");
    if (old) { old.remove(); return; }
    const menu = document.createElement("div");
    menu.id = "shelf-child-menu";
    menu.className = "shelf-child-menu";
    for (const c of session.children) {
        const b = document.createElement("button");
        b.className = c.id === session.childId ? "active" : "";
        b.innerText = (c.id === session.childId ? "✓ " : "") + c.nickname;
        b.onclick = async (e) => {
            e.stopPropagation();
            menu.remove();
            await selectChild(c.id); // afterChildSelect 钩子会触发书架重渲
            if (shelfVisible()) showShelf();
        };
        menu.appendChild(b);
    }
    // 「＋ 添加孩子」→ 家长弹窗（管理面：添加孩子/退出登录）。已登录时 chip 下拉是唯一家长枢纽（spec §2.2）
    const add = document.createElement("button");
    add.className = "scm-add";
    add.innerText = t("shelf.add_child");
    add.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        void openParentModal();
    };
    menu.appendChild(add);
    // 家长后台入口：独立 Vue dashboard，新标签打开；token 不走 hash 交接（后台 sessionStorage 门槛，见 §3）
    const divider = document.createElement("div");
    divider.className = "scm-divider";
    menu.appendChild(divider);
    const dash = document.createElement("button");
    dash.className = "scm-dash";
    dash.innerText = t("shelf.dashboard");
    dash.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        openParentDashboard();
    };
    menu.appendChild(dash);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.right = Math.max(10, window.innerWidth - r.right) + "px";
    el.appendChild(menu);
    // 点空白处收起
    setTimeout(() => document.addEventListener("pointerdown", function close(ev) {
        if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("pointerdown", close); }
    }), 0);
}
