// i18n 核心（2026-08-28 spec：中英文切换）
// 框架：i18next（vanilla TS）。字典见 zh-CN.ts / en-US.ts（中文为基准，逐字提取自现有代码）。
// 语言判定：?lang= 参数 > localStorage.taka_lang > 浏览器语言（zh* → 中文，其他 → 英文）。
import i18next from "i18next";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";

export type Lang = "zh" | "en";
const LS_KEY = "taka_lang";

function detect(): Lang {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "en" || q === "en-US") return "en";
    if (q === "zh" || q === "zh-CN") return "zh";
    const saved = localStorage.getItem(LS_KEY);
    if (saved === "en" || saved === "zh") return saved;
    return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export let lang: Lang = detect();

export async function initI18n(): Promise<void> {
    await i18next.init({
        lng: lang,
        fallbackLng: "zh",
        resources: {
            zh: { translation: zhCN },
            en: { translation: enUS },
        },
        interpolation: { escapeValue: false }, // 输出进 innerHTML 前由调用方自行 esc
    });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

/** 切换语言：写存储 + 换 i18next + 通知（故事包重载/页面重渲由调用方处理） */
export function setLang(l: Lang): void {
    lang = l;
    localStorage.setItem(LS_KEY, l);
    void i18next.changeLanguage(l);
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
}

export function t(key: string, vars?: Record<string, unknown>): string {
    return i18next.t(key, vars as Record<string, string>) as string;
}

/** 静态 HTML 文案：data-i18n="key"（textContent）/ data-i18n-title / data-i18n-ph（placeholder）
 *  初始化与切语言后各跑一次。动态生成的 DOM 在生成处直接用 t()。 */
export function applyStatic(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => {
        el.textContent = t(el.dataset.i18n!);
    });
    root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach(el => {
        el.title = t(el.dataset.i18nTitle!);
    });
    root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach(el => {
        el.placeholder = t(el.dataset.i18nPh!);
    });
}
