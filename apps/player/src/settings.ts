// 设置：AI 开关（生成在服务端完成，M4 起本地不再存任何 key）+ 语音偏好
import { ICON_SHELF } from "./icons";
import { t } from "./i18n";
import { themeControl } from "./theme";

export interface AiSettings {
    enabled: boolean; // 允许选项 C 调服务端生成（游客不显示选项 C，开关只控制已登录状态）
}

const SETTINGS_KEY = "taka_ai_settings";
const DEFAULT_SETTINGS: AiSettings = { enabled: true };

export function loadSettings(): AiSettings {
    try {
        const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
        return { enabled: raw.enabled !== false }; // 历史遗留的 baseUrl/apiKey 字段直接忽略
    } catch { return { ...DEFAULT_SETTINGS }; }
}

/* ===== 语音偏好（开关兼总音量 / 是否朗读选项 / 基础语速） ===== */
export interface SpeechPref {
    on: boolean;
    readChoices: boolean;
    rate: number;
    volume: number;
}

const SPEECH_KEY = "taka_speech";

function loadSpeechPref(): SpeechPref {
    const def: SpeechPref = { on: true, readChoices: true, rate: 0.95, volume: 1 };
    try {
        const saved = { ...def, ...JSON.parse(localStorage.getItem(SPEECH_KEY) || "{}") };
        saved.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : 1;
        return saved;
    }
    catch { return def; }
}

export const speechPref: SpeechPref = loadSpeechPref();

export function saveSpeechPref(): void {
    localStorage.setItem(SPEECH_KEY, JSON.stringify(speechPref));
}

/* ===== 布局偏好（2026-08-31 绘本模式）：auto=宽度阈值判定 / book=强制绘本 / vn=强制小说 ===== */
export type LayoutPref = "auto" | "book" | "vn";
const LAYOUT_KEY = "taka_layout";

export function loadLayoutPref(): LayoutPref {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === "book" || v === "vn" ? v : "auto";
}

/** 布局切换回调（main.ts 注入：重判 book-mode + 原地重渲当前场景） */
let layoutChangeHandler: ((p: LayoutPref) => void) | null = null;
export function setLayoutChangeHandler(fn: (p: LayoutPref) => void): void { layoutChangeHandler = fn; }

/* ===== 顶部状态条（AI 状态/提示共用） ===== */
let statusTimer: ReturnType<typeof setTimeout> | null = null;

export function showStatus(msg: string, ms?: number): void {
    document.getElementById("ai-status")!.innerText = msg;
    if (statusTimer) clearTimeout(statusTimer);
    if (msg && ms) {
        statusTimer = setTimeout(() => { document.getElementById("ai-status")!.innerText = ""; }, ms);
    }
}

/* ===== 设置面板 DOM 接线（2026-09-02 改版：即改即存，点面板外自动关闭；删保存/关闭钮；加退出登录） ===== */
/** 「保存并返回书架」处理器（main.ts 注入 engine.exitToShelf，避免 settings↔engine 循环依赖） */
let exitToShelfHandler: (() => void) | null = null;
export function setExitToShelfHandler(fn: () => void): void { exitToShelfHandler = fn; }

/** 「退出登录」处理器（main.ts 注入 auth.logoutEverywhere，同样防循环依赖） */
let logoutHandler: (() => void) | null = null;
export function setLogoutHandler(fn: () => void): void { logoutHandler = fn; }

/** 登录态查询（main.ts 注入 session 快照，控制「退出登录」显隐） */
let isLoggedInFn: (() => boolean) | null = null;
export function setIsLoggedInFn(fn: () => boolean): void { isLoggedInFn = fn; }

let openBooks: (() => void) | null = null;
let openCodex: (() => void) | null = null;
export function setDrawerCollections(books: () => void, codex: () => void): void { openBooks = books; openCodex = codex; }

export function initSettingsPanel(): void {
    document.getElementById("settings-btn")!.innerHTML = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 4 6 .3 1 4 3 1.5 4-1 3 5-3 3v3l2 3-4 4-3-2-3 1-1.5 4-6-.4-.8-4-3-1.6-4 1-2.7-5 3-2.8v-3l-2-3 4-4 3 2 3-1Z" transform="translate(0 -1) scale(.96)"/><circle cx="16" cy="16" r="4.8"/></svg>`;
    document.querySelector("#sp-toshelf .sp-shelf-ico")!.innerHTML = ICON_SHELF;
    const s = loadSettings();
    const enabledEl = document.getElementById("sp-enabled") as HTMLInputElement;
    const readChoicesEl = document.getElementById("sp-readchoices") as HTMLInputElement;
    enabledEl.checked = s.enabled;
    readChoicesEl.checked = speechPref.readChoices;
    const panel = document.getElementById("settings-panel")!;
    const overlay = document.getElementById("settings-overlay")!;
    document.body.appendChild(overlay); // 独立层，避开 #stage / 翻页的堆叠与裁切。
    document.getElementById("rd-theme")!.innerHTML = themeControl();
    for (const [id, host] of [["lang-toggle","rd-language"],["speech-btn","rd-speech"],["log-btn","rd-log"],["ach-btn","rd-ach"],["parent-btn","rd-parent"]]) {
        document.getElementById(host)!.appendChild(document.getElementById(id)!);
    }
    document.querySelector(".hud")!.prepend(document.getElementById("settings-btn")!);
    document.getElementById("reader-back")!.onclick = () => exitToShelfHandler?.();

    // 即改即存：两个开关直接落盘
    enabledEl.onchange = () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled: enabledEl.checked } satisfies AiSettings));
    };
    readChoicesEl.onchange = () => {
        speechPref.readChoices = readChoicesEl.checked;
        saveSpeechPref();
    };

    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let opener: HTMLElement | null = null;
    const closePanel = (immediate = false, restore = true) => {
        if (closeTimer) clearTimeout(closeTimer);
        overlay.classList.remove("is-open");
        document.getElementById("settings-btn")!.setAttribute("aria-expanded", "false");
        const finish = () => {
            panel.hidden = true; overlay.hidden = true;
            document.getElementById("stage")!.inert = false;
            document.getElementById("stage")!.removeAttribute("aria-hidden");
            if (restore) {
                const target = opener?.isConnected && opener.getClientRects().length ? opener : document.querySelector<HTMLElement>('.shell-tools summary, #settings-btn');
                target?.focus();
            }
        };
        if (immediate || matchMedia('(prefers-reduced-motion:reduce)').matches) finish();
        else closeTimer = setTimeout(finish, 280);
    };
    const openPanel = () => {
        if (closeTimer) clearTimeout(closeTimer);
        opener = document.activeElement as HTMLElement;
        overlay.hidden = false; panel.hidden = false;
        requestAnimationFrame(() => overlay.classList.add("is-open"));
        const shelf = document.getElementById("shelf-screen")!;
        document.getElementById("sp-toshelf")!.style.display = shelf.hidden ? "" : "none";
        document.getElementById("sp-logout")!.hidden = !(isLoggedInFn && isLoggedInFn());
        document.getElementById("rd-parent-row")!.hidden = !!(isLoggedInFn && isLoggedInFn());
        document.getElementById("sp-energy-value")!.textContent = document.getElementById("battery-text")!.textContent;
        document.getElementById("settings-btn")!.setAttribute("aria-expanded", "true");
        panel.focus();
        document.getElementById("stage")!.inert = true;
        document.getElementById("stage")!.setAttribute("aria-hidden", "true");
    };
    document.getElementById("settings-btn")!.setAttribute("aria-controls", "settings-panel");
    document.getElementById("settings-btn")!.setAttribute("aria-expanded", "false");
    document.getElementById("settings-btn")!.onclick = e => {
        e.stopPropagation();
        if (overlay.hidden || !overlay.classList.contains('is-open')) openPanel(); else closePanel();
    };
    document.getElementById("settings-close")!.onclick = () => closePanel();
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closePanel(); });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
        if (e.key !== 'Tab') return;
        const focusable = [...panel.querySelectorAll<HTMLElement>('button,select,input,summary,[tabindex="0"]')].filter(el=>!el.hasAttribute('disabled') && el.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length-1];
        if (e.shiftKey && (document.activeElement===first || document.activeElement===panel)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement===last || document.activeElement===panel)) { e.preventDefault(); first?.focus(); }
    });
    for (const id of ['log-btn','ach-btn','parent-btn']) {
        document.getElementById(id)!.addEventListener('click', () => closePanel(true, false), { capture:true });
    }
    document.getElementById('rd-books')!.onclick = () => { closePanel(true, false); openBooks?.(); };
    document.getElementById('rd-codex')!.onclick = () => { closePanel(true, false); openCodex?.(); };
    document.getElementById("sp-toshelf")!.onclick = () => {
        closePanel(true, false);
        if (exitToShelfHandler) exitToShelfHandler();
    };
    document.getElementById("sp-logout")!.onclick = () => {
        closePanel(true, false);
        if (logoutHandler) logoutHandler();
    };
    // 布局三档：即时生效（与语速滑块同款交互）
    const layoutSel = document.getElementById("sp-layout") as HTMLSelectElement;
    layoutSel.value = loadLayoutPref();
    layoutSel.dispatchEvent(new Event('picker-sync'));
    layoutSel.onchange = () => {
        const v = layoutSel.value as LayoutPref;
        localStorage.setItem(LAYOUT_KEY, v);
        if (layoutChangeHandler) layoutChangeHandler(v);
    };
}
