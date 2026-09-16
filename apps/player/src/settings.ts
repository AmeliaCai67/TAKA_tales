// 设置：AI 开关（生成在服务端完成，M4 起本地不再存任何 key）+ 语音偏好
import { ICON_SETTINGS, ICON_SHELF } from "./icons";
import { t } from "./i18n";

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
}

const SPEECH_KEY = "taka_speech";

function loadSpeechPref(): SpeechPref {
    const def: SpeechPref = { on: true, readChoices: true, rate: 0.95 };
    try { return { ...def, ...JSON.parse(localStorage.getItem(SPEECH_KEY) || "{}") }; }
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

export function initSettingsPanel(): void {
    document.getElementById("settings-btn")!.innerHTML = ICON_SETTINGS;
    document.querySelector("#sp-toshelf .sp-shelf-ico")!.innerHTML = ICON_SHELF;
    const s = loadSettings();
    const enabledEl = document.getElementById("sp-enabled") as HTMLInputElement;
    const readChoicesEl = document.getElementById("sp-readchoices") as HTMLInputElement;
    enabledEl.checked = s.enabled;
    readChoicesEl.checked = speechPref.readChoices;
    const panel = document.getElementById("settings-panel")!;

    // 即改即存：两个开关直接落盘
    enabledEl.onchange = () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled: enabledEl.checked } satisfies AiSettings));
    };
    readChoicesEl.onchange = () => {
        speechPref.readChoices = readChoicesEl.checked;
        saveSpeechPref();
    };

    let outsideCloser: ((ev: Event) => void) | null = null;
    const closePanel = () => {
        panel.hidden = true;
        if (outsideCloser) {
            document.removeEventListener("pointerdown", outsideCloser);
            outsideCloser = null;
        }
    };
    document.getElementById("settings-btn")!.onclick = (e) => {
        e.stopPropagation();
        if (panel.hidden) {
            panel.hidden = false;
            // 故事进行中才显示「保存并返回书架」（书架页上无意义）
            const shelf = document.getElementById("shelf-screen");
            document.getElementById("sp-toshelf")!.style.display = shelf && shelf.hidden ? "" : "none";
            // 登录时显示「退出登录」
            document.getElementById("sp-logout")!.hidden = !(isLoggedInFn && isLoggedInFn());
            // 点面板外任意处自动关闭（设置项全部即改即存，无需显式保存）
            setTimeout(() => {
                outsideCloser = (ev: Event) => {
                    if (!panel.contains(ev.target as Node)) closePanel();
                };
                document.addEventListener("pointerdown", outsideCloser);
            }, 0); // 本次点击不触发刚挂的监听
        } else {
            closePanel();
        }
    };
    document.getElementById("sp-toshelf")!.onclick = () => {
        closePanel();
        if (exitToShelfHandler) exitToShelfHandler();
    };
    document.getElementById("sp-logout")!.onclick = () => {
        closePanel();
        if (logoutHandler) logoutHandler();
    };
    // 布局三档：即时生效（与语速滑块同款交互）
    const layoutSel = document.getElementById("sp-layout") as HTMLSelectElement;
    layoutSel.value = loadLayoutPref();
    layoutSel.onchange = () => {
        const v = layoutSel.value as LayoutPref;
        localStorage.setItem(LAYOUT_KEY, v);
        if (layoutChangeHandler) layoutChangeHandler(v);
    };
}
