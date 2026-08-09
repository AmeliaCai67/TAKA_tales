// 语音双轨：固定场景 → 故事包预渲染 mp3（edge-tts 定稿声线）；
// AI 生成文本 / manifest 缺失 → 浏览器 speechSynthesis 实时回退。
// 另含：风声 BGM（且听风吟场景专属）。🔊 开关兼作总音量。
import { pack } from "./pack";
import { speechPref, saveSpeechPref } from "./settings";

export const speechSupported = "speechSynthesis" in window;
let zhVoice: SpeechSynthesisVoice | null = null;

/* 角色声线：单一声音 + pitch/rate 区分（多语音包实测效果诡异，弃用）。
   rate 为「角色系数」——最终语速 = 基础语速（家长可调）× 系数 */
const CHAR_PROFILE: Record<string, { rate: number; pitch: number }> = {
    narrator:   { rate: 1.0,  pitch: 1.1  }, // 基准
    taka:       { rate: 0.93, pitch: 0.85 }, // 塔卡：沉稳、慢半拍的旧机器人
    seagull:    { rate: 1.1,  pitch: 1.35 }, // 海鸥：亮、快、活
    oldmachine: { rate: 0.84, pitch: 0.65 }  // 老机器：低沉迟缓
};

// 段内台词：角色名 + 最多 8 字引语（说/问/的信号很弱…）+ 冒号 + 台词
// 闭引号必需：先解析后清洗，引号负责定界（引语后允许跟旁白）
const DIALOG_RE = /(塔卡|海鸥|老机器)([^：:]{0,8})[：:]["「“『]([^"」”』]+?)["」”』]/;

function pickVoice(): void {
    if (!speechSupported) return;
    const voices = speechSynthesis.getVoices();
    const zh = voices.filter(v => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("zh"));
    // 优先本地声音（离线可用），Google 云端声音仅作兜底
    const local = zh.filter(v => v.localService);
    const pool = local.length ? local : zh;
    const preferred = ["xiaoxiao", "xiaoyi", "xiaobing", "ting", "mei", "sinji", "lilian",
                       "晓晓", "小冰", "婷婷", "美佳"];
    zhVoice = pool.find(v => preferred.some(p => v.name.toLowerCase().includes(p))) || pool[0] || null;
}
if (speechSupported) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice; // Chrome 异步加载声音列表
}

function makeUtterance(text: string, who?: string, rateOverride?: number, volume?: number): SpeechSynthesisUtterance {
    const prof = CHAR_PROFILE[who || "narrator"];
    const u = new SpeechSynthesisUtterance(text);
    if (zhVoice) u.voice = zhVoice;
    u.lang = "zh-CN";
    // 最终语速 = 基础语速（设置面板滑块，默认 0.95）× 角色系数，限制在 [0.5, 2]
    const base = rateOverride || speechPref.rate;
    u.rate = Math.min(2, Math.max(0.5, base * prof.rate));
    u.pitch = prof.pitch;
    u.volume = volume === undefined ? 1 : volume; // 场景可 duck（如风声场景）
    return u;
}

interface Seg { who: string; text: string; }

// 把一段文本拆成「叙述 + 角色台词」片段，分别分配声线；
// “塔卡：...” 的引语补成 “塔卡说”（纯名字时自动加“说”）
function parseParagraph(p: string): Seg[] {
    const m = p.match(DIALOG_RE);
    if (!m) return [{ who: "narrator", text: p }];
    let intro = (p.slice(0, m.index) + m[1] + m[2]).trim();
    if (intro === m[1]) intro = m[1] + "说";
    const outro = p.slice(m.index! + m[0].length).trim(); // 引语后的旁白（如「它身边坐着海鸥」）
    const segs: Seg[] = [];
    if (intro) segs.push({ who: "narrator", text: intro });
    segs.push({ who: pack().speakers[m[1]] || "narrator", text: m[3] });
    if (outro) segs.push({ who: "narrator", text: outro });
    return segs;
}

// 多音字修正表：发现一例加一例（key 替换为同音写法，仅影响朗读不改显示文本）。
// 注：Web Speech API 不支持 SSML（标签会被读出来或忽略），治本等 TTS 升级
const PRONUNCIATION_FIXES: Record<string, string> = {
    // 例："数一数": "鼠一鼠"
};

// 朗读前清洗：去掉（）内舞台说明（如“完 - 分享而非牺牲”）；
// 去掉引号字符（中文语音会把 ASCII 直引号机械地念出来，角色对话靠语气自然区分）
function cleanForSpeech(s: string): string {
    let t = s.replace(/（[^）]*）/g, "")
             .replace(/["“”「」『』]/g, "");
    for (const [k, v] of Object.entries(PRONUNCIATION_FIXES)) t = t.split(k).join(v);
    return t.trim();
}

const utteranceRefs: SpeechSynthesisUtterance[] = []; // 防 Chrome 把 utterance GC 掉（已知 bug：队列被回收→静默）
let speechGen = 0; // 朗读代际：stopSpeech/新朗读使旧的延迟队列失效

function queueSpeak(u: SpeechSynthesisUtterance): void {
    utteranceRefs.push(u);
    if (utteranceRefs.length > 30) utteranceRefs.shift();
    speechSynthesis.speak(u);
}

// 正文朗读：按段拆成多条 utterance（规避 Chrome 长文本 ~15s 中断 bug）
export function speakStory(text: string, volume?: number): void {
    if (!speechSupported || !speechPref.on) return;
    const gen = ++speechGen;
    speechSynthesis.cancel();
    // cancel 是异步的，立刻 speak 会被一起冲掉（Chrome 页面加载/刷新时高发）——延迟一个 tick
    setTimeout(() => {
        if (gen !== speechGen || !speechPref.on) return;
        text.split(/\n+/)
            .flatMap(parseParagraph) // 先在原文上归属角色（引号还在，定界精确）
            .map(seg => ({ who: seg.who, text: cleanForSpeech(seg.text) })) // 再按段清洗
            .filter(seg => seg.text)
            .forEach(seg => queueSpeak(makeUtterance(seg.text, seg.who, undefined, volume)));
        speechSynthesis.resume(); // 刷新后合成器可能卡在 paused，推一下
    }, 100);
}

// 选项朗读：排队在正文之后，不打断；两个选项时前缀“你选。”（呼应海鸥台词）
// 有自由输入选项时，末尾补一句“或者，说说你的想法”
export function speakChoices(choices?: { text: string }[], hasFreeInput?: boolean): void {
    // mp3ChoicesQueued：选项朗读已在音频包里；mp3Active 但无选项音频（listen-bar 动态按钮）仍走 TTS
    if (!speechSupported || !speechPref.on || !speechPref.readChoices || mp3ChoicesQueued || !choices || !choices.length) return;
    const prefix = choices.length > 1 ? "你选。" : "";
    const suffix = hasFreeInput ? "或者，说说你的想法。" : "";
    queueSpeak(makeUtterance(prefix + choices.map(c => cleanForSpeech(c.text)).join("。") + "。" + suffix));
}

export function stopSpeech(): void {
    speechGen++; // 使排队中的延迟朗读失效
    if (speechSupported) speechSynthesis.cancel();
    stopSceneAudio();
}

/* ===== 风声 BGM：isSpecialListen（且听风吟）场景专属 ===== */
// 启动门已提供用户手势，play() 不会被自动播放策略拦截
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

/* ===== 预渲染语音包：manifest 驱动的 mp3 播放链 ===== */
// manifest 加载失败（file:// 协议/资源缺失）时 audioManifest 为 null，全程走浏览器 TTS
interface ManifestEntry {
    segments: { file: string; who: string; text: string }[];
    choices: { file: string; text: string } | null;
}
let audioManifest: Record<string, ManifestEntry> | null = null;
let mp3Active = false;        // 当前场景是否在用 mp3（影响补读兜底/开关）
let mp3ChoicesQueued = false; // choices.mp3 是否已排进播放列表（决定选项是否还要 TTS 念）
const scenePlayer = new Audio();
let scenePlaylist: string[] = [], scenePlayIdx = 0;

/** 故事包加载后调用一次：定位音频资产、拉取 manifest（版本参数防缓存错位） */
export function initAudioAssets(): void {
    windAudio.src = pack().baseUrl + "audio/" + encodeURIComponent("风声") + ".mp3";
    fetch(pack().baseUrl + "audio/manifest.json?v=" + Date.now())
        .then(r => r.json())
        .then(m => { audioManifest = m; })
        .catch(() => {});
}

export function playSceneAudio(key: string, duck?: boolean): boolean {
    if (!audioManifest || !audioManifest[key] || !speechPref.on) return false;
    stopSpeech(); // 停旧队列（也会停旧 mp3），拿到新 speechGen
    const entry = audioManifest[key];
    const base = pack().baseUrl + "audio/";
    scenePlaylist = entry.segments.map(s => base + s.file);
    mp3ChoicesQueued = !!(entry.choices && speechPref.readChoices);
    if (mp3ChoicesQueued) scenePlaylist.push(base + entry.choices!.file);
    scenePlayIdx = 0;
    scenePlayer.volume = duck ? 0.55 : 1;        // 且听风吟：人声 duck 给风声
    scenePlayer.playbackRate = speechPref.rate || 1; // 家长语速滑块同样生效
    const gen = speechGen;
    const playNext = () => {
        if (gen !== speechGen || scenePlayIdx >= scenePlaylist.length) return;
        scenePlayer.src = scenePlaylist[scenePlayIdx++];
        scenePlayer.play().catch(() => {});
    };
    scenePlayer.onended = playNext;
    scenePlayer.onerror = playNext; // 单个文件加载失败跳过，不让整条链哑掉
    mp3Active = true;
    playNext();
    return true;
}

function stopSceneAudio(): void {
    scenePlayer.pause();
    scenePlayer.onended = null;
    scenePlaylist = [];
    mp3Active = false;
    mp3ChoicesQueued = false;
}

/** 首次交互补读用：场景音频是否空闲（没在播 mp3） */
export function sceneAudioIdle(): boolean {
    return scenePlayer.paused;
}

/* ===== 🔊 按钮 + 语速滑块 + 试听 ===== */
export function initSpeech(): void {
    const btn = document.getElementById("speech-btn")!;
    const sync = () => { btn.innerText = speechPref.on ? "🔊" : "🔇"; };
    sync();
    (document.getElementById("sp-readchoices") as HTMLInputElement).checked = speechPref.readChoices;
    // 语速滑块 + 试听
    const slider = document.getElementById("sp-rate") as HTMLInputElement;
    const rateVal = document.getElementById("sp-rate-val")!;
    slider.value = String(speechPref.rate);
    rateVal.innerText = Number(speechPref.rate).toFixed(2) + "x";
    slider.oninput = () => { rateVal.innerText = Number(slider.value).toFixed(2) + "x"; };
    document.getElementById("sp-preview")!.onclick = (e) => {
        e.stopPropagation();
        if (!speechSupported) return;
        stopSpeech();
        queueSpeak(makeUtterance("海底很亮。有很多光。塔卡的灯闪了一下。", "narrator", Number(slider.value)));
    };
    btn.onclick = () => {
        speechPref.on = !speechPref.on;
        if (!speechPref.on) { stopSpeech(); stopWind(); } // 静音=全部静音（stopSpeech 内含 stopSceneAudio）
        saveSpeechPref();
        sync();
    };
}

/** 启动门手势里调用：解锁 speechSynthesis（Chrome/Safari 均要求用户手势） */
export function warmUpSynth(): void {
    if (!speechSupported) return;
    try {
        speechSynthesis.cancel(); // 清掉可能卡住的队列
        const u = new SpeechSynthesisUtterance(" "); // 手势内热身
        u.volume = 0.01;
        speechSynthesis.speak(u);
    } catch {}
}
