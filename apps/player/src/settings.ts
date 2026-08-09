// 设置：AI 连接（过渡态，M4 服务端化后移除 key）+ 语音偏好，均只存本机 localStorage

export interface AiSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
    enabled: boolean;
}

const SETTINGS_KEY = "taka_ai_settings";
const DEFAULT_SETTINGS: AiSettings = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    enabled: false
};

export function loadSettings(): AiSettings {
    let s: AiSettings;
    try { s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
    catch { s = { ...DEFAULT_SETTINGS }; }
    // 历史默认值修正：DeepSeek 端点 + gpt 默认模型 → 自动换成 deepseek-v4-flash
    if (/deepseek/i.test(s.baseUrl) && s.model === "gpt-4o-mini") s.model = "deepseek-v4-flash";
    return s;
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

/* ===== 顶部状态条（AI 状态/提示共用） ===== */
let statusTimer: ReturnType<typeof setTimeout> | null = null;

export function showStatus(msg: string, ms?: number): void {
    document.getElementById("ai-status")!.innerText = msg;
    if (statusTimer) clearTimeout(statusTimer);
    if (msg && ms) {
        statusTimer = setTimeout(() => { document.getElementById("ai-status")!.innerText = ""; }, ms);
    }
}

/* ===== 设置面板 DOM 接线 ===== */
export function initSettingsPanel(): void {
    const s = loadSettings();
    (document.getElementById("sp-baseurl") as HTMLInputElement).value = s.baseUrl;
    (document.getElementById("sp-key") as HTMLInputElement).value = s.apiKey;
    (document.getElementById("sp-model") as HTMLInputElement).value = s.model;
    (document.getElementById("sp-enabled") as HTMLInputElement).checked = s.enabled;
    const panel = document.getElementById("settings-panel")!;
    document.getElementById("settings-btn")!.onclick = () => { panel.hidden = !panel.hidden; };
    document.getElementById("sp-save")!.onclick = () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            baseUrl: (document.getElementById("sp-baseurl") as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.baseUrl,
            apiKey: (document.getElementById("sp-key") as HTMLInputElement).value.trim(),
            model: (document.getElementById("sp-model") as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.model,
            enabled: (document.getElementById("sp-enabled") as HTMLInputElement).checked
        } satisfies AiSettings));
        speechPref.readChoices = (document.getElementById("sp-readchoices") as HTMLInputElement).checked;
        speechPref.rate = Number((document.getElementById("sp-rate") as HTMLInputElement).value);
        saveSpeechPref();
        panel.hidden = true;
        showStatus("设置已保存", 2000);
    };
    document.getElementById("sp-close")!.onclick = () => { panel.hidden = true; };
}
