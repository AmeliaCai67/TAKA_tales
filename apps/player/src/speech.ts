// 语音系统（生产版，M2 起）：**不依赖浏览器 speechSynthesis**
//   固定场景 → 故事包预渲染 mp3（edge-tts 定稿声线，manifest 驱动播放链）
//   动态文本（选项 C 现场生成 / manifest 缺失补读）→ 服务端 /api/tts 实时渲染
// 两者共用同一条 Audio 播放链；🔊 开关兼作总音量；家长语速滑块 = playbackRate。
import { pack } from "./pack";
import { ICON_SOUND_ON, ICON_SOUND_OFF } from "./icons";
import { speechPref, saveSpeechPref } from "./settings";
import { TTS_ENDPOINT } from "./config";
import { acquireAudio } from "./audioPriority";

/* ===== 台词归属（与 packages/tts-pipeline/tts_pipeline/segments.py 严格镜像） ===== */
// 角色名 + 最多 16 字引语 + 冒号 + 闭引号定界的台词；先解析后清洗，引语后允许跟旁白
// 2026-08-18 修复：正则必须随故事包 speakers 重建——旧缓存只认 ch01 的角色（塔卡/海鸥/老机器），
// 切到 ch02/ch03 后抹香鲸/757/小钉 全部识别失败 → 声线 fallback 到 narrator（线上实测复现）
let dialogRe: RegExp | null = null;
let dialogNames = "";

function getDialogRe(): RegExp {
    const names = Object.keys(pack().speakers).join("|");
    if (!dialogRe || dialogNames !== names) {
        dialogNames = names;
        dialogRe = new RegExp("(" + names + ")([^：:]{0,16})[：:][\"「“『]([^\"」”』]+?)[\"」”』]");
    }
    return dialogRe;
}

interface Seg { who: string; text: string; }

/** 如我所书（2026-08-19）：把一段故事文本解析成逐句（说话人+文本），供对话流收集/上报。
 *  与朗读链路同一解析器，保证书的内容与听到的一致。 */
export function parseTextSegs(text: string, overrides?: Record<string, string>): Seg[] {
    return text.split(/\n+/).flatMap(p => parseParagraph(p, overrides));
}

function parseParagraph(p: string, overrides?: Record<string, string>): Seg[] {
    const m = p.match(getDialogRe());
    if (!m) return [{ who: "narrator", text: p }];
    let intro = (p.slice(0, m.index) + m[1] + m[2]).trim();
    if (intro === m[1]) intro = m[1] + "说";
    const outro = p.slice(m.index! + m[0].length).trim(); // 引语后的旁白（如「它身边坐着海鸥」）
    const segs: Seg[] = [];
    if (intro) segs.push({ who: "narrator", text: intro });
    // 场景级声线覆盖（voiceOverrides）：显示文本不动，只换朗读者
    const who = pack().speakers[m[1]] || "narrator";
    segs.push({ who: (overrides && overrides[m[1]]) || who, text: m[3] });
    if (outro) segs.push({ who: "narrator", text: outro });
    return segs;
}

// 朗读前清洗：去掉（）内舞台说明；去掉引号字符
function cleanForSpeech(s: string): string {
    return s.replace(/（[^）]*）/g, "")
            .replace(/["“”「」『』]/g, "")
            .trim();
}

/** 读音别名（story.json ttsAliases）：显示文本不动，只改喂给 TTS 的文案（757 → 七五七）
 *  注入在 ttsUrl：所有动态朗读路径（正文/选项/选项 C 生成文本）统一经过这里。 */
function aliasForSpeech(t: string): string {
    const aliases = pack().ttsAliases;
    if (!aliases) return t;
    let out = t;
    for (const k of Object.keys(aliases)) out = out.split(k).join(aliases[k]);
    return out;
}

function ttsUrl(text: string, who: string): string {
    return TTS_ENDPOINT + "?text=" + encodeURIComponent(aliasForSpeech(text)) + "&who=" + encodeURIComponent(who);
}

/* ===== 统一播放链：mp3 包与动态 TTS 共用 ===== */
const scenePlayer = new Audio();
let scenePlaylist: string[] = [], scenePlayIdx = 0;
let speechGen = 0;            // 播放代际：stopSpeech/新播放使旧链失效
let chainActive = false;      // 播放链进行中（speakChoices 可续接到链尾）
let choicesQueued = false;    // 选项朗读已在链里（manifest choices.mp3）→ speakChoices 不再重复
let storyRelease: (() => void) | null = null; // 故事层音频焦点（供高优先级暂停/恢复）

function startChain(urls: string[], duck?: boolean): void {
    stopSpeech(); // 停旧链，拿到新 speechGen
    scenePlaylist = urls.slice();
    scenePlayIdx = 0;
    scenePlayer.volume = duck ? 0.55 : 1; // 且听风吟：人声 duck 给风声
    const gen = speechGen;
    const playNext = () => {
        if (gen !== speechGen) return;
        if (scenePlayIdx >= scenePlaylist.length) { chainActive = false; return; }
        scenePlayer.src = scenePlaylist[scenePlayIdx++];
        // 必须在 src 之后设置：媒体元素 load() 会把 playbackRate 重置为 defaultPlaybackRate
        scenePlayer.playbackRate = speechPref.rate || 1; // 家长语速滑块
        scenePlayer.play().catch(() => {});
    };
    scenePlayer.onended = playNext;
    scenePlayer.onerror = playNext; // 单个文件加载失败跳过，不让整条链哑掉
    chainActive = true;
    // 故事层（低优先）：图鉴介绍(codex) 开始后会暂停本链，停止后恢复
    storyRelease = acquireAudio("story", () => scenePlayer.pause(), () => scenePlayer.play());
    playNext();
}

/** 续接到当前链尾（选项朗读跟在正文之后）；链已结束则新开一条 */
function appendChain(urls: string[]): void {
    if (chainActive) {
        scenePlaylist.push(...urls);
    } else {
        startChain(urls);
    }
}

export function stopSpeech(): void {
    speechGen++; // 使旧链失效
    scenePlayer.pause();
    scenePlayer.onended = null;
    scenePlaylist = [];
    chainActive = false;
    choicesQueued = false;
    if (storyRelease) { storyRelease(); storyRelease = null; } // 释放故事层焦点
}

/** 首次交互补读用：播放链是否空闲 */
export function sceneAudioIdle(): boolean {
    return scenePlayer.paused;
}

/* ===== 动态文本朗读（服务端 TTS） ===== */
export function speakStory(text: string, volume?: number, overrides?: Record<string, string>): void {
    if (!speechPref.on) return;
    const urls = text.split(/\n+/)
        .flatMap(p => parseParagraph(p, overrides)) // 先在原文上归属角色（引号还在，定界精确）
        .map(seg => ({ who: seg.who, text: cleanForSpeech(seg.text) })) // 再按段清洗
        .filter(seg => seg.text)
        .map(seg => ttsUrl(seg.text, seg.who));
    if (urls.length) startChain(urls, volume !== undefined && volume < 1);
}

// 选项朗读：接在正文链尾；两个选项时前缀“你选。”（呼应海鸥台词）
// 有自由输入选项时，末尾补一句“或者，说说你的想法”
export function speakChoices(choices?: { text: string }[], hasFreeInput?: boolean): void {
    if (!speechPref.on || !speechPref.readChoices || choicesQueued || !choices || !choices.length) return;
    const prefix = choices.length > 1 ? "你选。" : "";
    const suffix = hasFreeInput ? "或者，说说你的想法。" : "";
    const text = prefix + choices.map(c => cleanForSpeech(c.text)).join("。") + "。" + suffix;
    appendChain([ttsUrl(text, "narrator")]);
}

/* ===== 风声 BGM：isSpecialListen（且听风吟）场景专属 ===== */
const windAudio = new Audio();
windAudio.loop = true;
windAudio.volume = 0;
let windFade: ReturnType<typeof setInterval> | null = null;

function windTo(target: number, ms = 800): void { // 音量渐变，避免硬切
    if (windFade) clearInterval(windFade);
    const from = windAudio.volume, steps = 16;
    let i = 0;
    windFade = setInterval(() => {
        windAudio.volume = Math.max(0, Math.min(1, from + (target - from) * (++i / steps)));
        if (i >= steps) {
            if (windFade) clearInterval(windFade);
            if (target === 0) { windAudio.pause(); windAudio.currentTime = 0; }
        }
    }, ms / steps);
}

export function startWind(): void {
    if (!speechPref.on) return;
    windAudio.play().then(() => windTo(0.55)).catch(() => {});
}

export function stopWind(): void {
    if (!windAudio.paused) windTo(0, 500);
}

/* ===== 预渲染语音包：manifest 驱动的场景播放 ===== */
// manifest 加载失败（file:// 协议/资源缺失）时 audioManifest 为 null，全程走服务端 TTS
interface ManifestEntry {
    segments: { file: string; who: string; text: string }[];
    choices: { file: string; text: string } | null;
}
let audioManifest: Record<string, ManifestEntry> | null = null;

/** 故事包加载后调用：定位音频资产 + 拉取 manifest（版本参数防缓存错位）。返回 Promise 供启动门等待 */
export function initAudioAssets(): Promise<void> {
    // 只有含 isSpecialListen 场景的故事才有风声资产，避免无风声包白 404
    if (Object.values(pack().scenes).some(s => s.isSpecialListen)) {
        windAudio.src = pack().baseUrl + "audio/" + encodeURIComponent("风声") + ".mp3";
    }
    return fetch(pack().baseUrl + "audio/manifest.json?v=" + Date.now())
        .then(r => r.json())
        .then(m => { audioManifest = m; })
        .catch(() => {});
}

export function playSceneAudio(key: string, duck?: boolean): boolean {
    if (!audioManifest || !audioManifest[key] || !speechPref.on) return false;
    const entry = audioManifest[key];
    const base = pack().baseUrl + "audio/";
    const urls = entry.segments.map(s => base + s.file);
    const willQueueChoices = !!(entry.choices && speechPref.readChoices);
    if (willQueueChoices) urls.push(base + entry.choices!.file);
    startChain(urls, duck);
    // startChain→stopSpeech 会把 choicesQueued 重置为 false，必须在其后再赋值，
    // 否则 speakChoices 不认为选项已读，会在 mp3 之后再动态 TTS 一遍（选项双读 bug）
    choicesQueued = willQueueChoices;
    return true;
}

/* ===== 🔊 按钮 + 语速滑块（语速即调即生效，无需试听——2026-08-27 移除试听按钮） ===== */

export function initSpeech(): void {
    const btn = document.getElementById("speech-btn")!;
    const sync = () => { btn.innerHTML = speechPref.on ? ICON_SOUND_ON : ICON_SOUND_OFF; };
    sync();
    (document.getElementById("sp-readchoices") as HTMLInputElement).checked = speechPref.readChoices;
    // 语速滑块：即调即生效（含正在播放的链），无需点保存
    const slider = document.getElementById("sp-rate") as HTMLInputElement;
    const rateVal = document.getElementById("sp-rate-val")!;
    slider.value = String(speechPref.rate);
    rateVal.innerText = Number(speechPref.rate).toFixed(2) + "x";
    slider.oninput = () => {
        const v = Number(slider.value);
        rateVal.innerText = v.toFixed(2) + "x";
        speechPref.rate = v;
        saveSpeechPref();
        scenePlayer.playbackRate = v; // 全局：正在播放的链也立即变速（风声 BGM 不变速）
    };
    btn.onclick = () => {
        speechPref.on = !speechPref.on;
        if (!speechPref.on) { stopSpeech(); stopWind(); } // 静音=全部静音
        saveSpeechPref();
        sync();
    };
}
