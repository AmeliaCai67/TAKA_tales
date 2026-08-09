// 设置：AI 开关（生成在服务端完成，M4 起本地不再存任何 key）+ 语音偏好

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
    (document.getElementById("sp-enabled") as HTMLInputElement).checked = s.enabled;
    const panel = document.getElementById("settings-panel")!;
    document.getElementById("settings-btn")!.onclick = () => { panel.hidden = !panel.hidden; };
    document.getElementById("sp-save")!.onclick = () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
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
