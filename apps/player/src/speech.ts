// 语音系统（生产版，M2 起）：**不依赖浏览器 speechSynthesis**
//   固定场景 → 故事包预渲染 mp3（edge-tts 定稿声线，manifest 驱动播放链）
//   动态文本（选项 C 现场生成 / manifest 缺失补读）→ 服务端 /api/tts 实时渲染
// 两者共用同一条 Audio 播放链；🔊 开关兼作总音量；家长语速滑块 = playbackRate。
import { pack } from "./pack";
import { ICON_SOUND_ON, ICON_SOUND_OFF } from "./icons";
import { speechPref, saveSpeechPref } from "./settings";
import { TTS_ENDPOINT } from "./config";
import { acquireAudio } from "./audioPriority";
import { reportEvent } from "./events";
import { t, lang } from "./i18n";
import { splitSentences } from "./tts-sentence";

/* ===== 台词归属（与 packages/tts-pipeline/tts_pipeline/segments.py 严格镜像） ===== */
// 角色名 + 最多 8 字引语 + 冒号 + 闭引号定界的台词；先解析后清洗；引语后允许跟旁白
// 2026-08-18 修复：正则必须随故事包 speakers 重建——旧缓存只认 ch01 的角色（塔卡/海鸥/老机器），
// 切到 ch02/ch03 后抹香鲸/757/小钉 全部识别失败 → 声线 fallback 到 narrator（线上实测复现）
// 2026-09-07：引语窗口 16→8 与 Python 侧对齐（两边分段必须一致，否则气泡与音频错位）
let dialogRe: RegExp | null = null;
let dialogNames = "";

function getDialogRe(): RegExp {
    const names = Object.keys(pack().speakers).join("|");
    if (!dialogRe || dialogNames !== names) {
        dialogNames = names;
        dialogRe = new RegExp("(" + names + ")([^：:]{0,8})[：:][\"「“『]([^\"」”』]+?)[\"」”』]");
    }
    return dialogRe;
}

interface Seg { who: string; text: string; }

// 插话式台词的引号对（与 segments.py _QUOTE_PAIR[zh] 镜像）
const QUOTE_PAIR_RE = /["「“『]([^"」”』]+?)["」”』]/g;

/** 引语后余文的插话式拆分（2026-09-07，镜像 segments.py _outro_segs）：
 *  `757："而且，"757 的声音变得很轻，"我会看着你……"`——插条归旁白，续台词归同一说话人 */
function outroSegs(outro: string, who: string): Seg[] {
    const segs: Seg[] = [];
    let pos = 0;
    for (const m of outro.matchAll(QUOTE_PAIR_RE)) {
        const before = outro.slice(pos, m.index).trim();
        if (before) segs.push({ who: "narrator", text: before });
        segs.push({ who, text: m[1] });
        pos = m.index! + m[0].length;
    }
    const tail = outro.slice(pos).trim();
    if (tail) segs.push({ who: "narrator", text: tail });
    return segs;
}

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
    const who = (overrides && overrides[m[1]]) || pack().speakers[m[1]] || "narrator";
    segs.push({ who, text: m[3] });
    if (outro) {
        // 插话式续引：余文里还有「名+冒号+引号」→ 递归；否则裸引号对归同一说话人
        if (getDialogRe().test(outro)) segs.push(...parseParagraph(outro, overrides));
        else segs.push(...outroSegs(outro, who));
    }
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
    // i18n（2026-08-28）：en 模式走英文声线表（/api/tts?lang=en → voices_en）
    const langParam = lang === "en" ? "&lang=en" : "";
    return TTS_ENDPOINT + "?text=" + encodeURIComponent(aliasForSpeech(text)) + "&who=" + encodeURIComponent(who) + langParam;
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
    let segError = 0; // 当前段的 error 重试计数（ArkWeb 对有效段也会发虚假 error，只重试一次）
    const playNext = () => {
        if (gen !== speechGen) return;
        if (scenePlayIdx >= scenePlaylist.length) { chainActive = false; return; }
        segError = 0; // 新段重置 error 计数
        const url = scenePlaylist[scenePlayIdx++];
        scenePlayer.src = url;
        // 显式 load()：部分移动内核（华为 ArkWeb）在上一段 ended 后立刻换 src 不 load，
        // 会静默丢掉这一段（2026-09-01 Mate 60 实测：英文包老机器台词被吞）
        scenePlayer.load();
        // 必须在 src 之后设置：媒体元素 load() 会把 playbackRate 重置为 defaultPlaybackRate
        scenePlayer.playbackRate = speechPref.rate || 1; // 家长语速滑块
        let tries = 2;
        const tryPlay = () => {
            if (gen !== speechGen) return;
            scenePlayer.play().catch(() => {
                if (tries-- > 0) setTimeout(tryPlay, 300); // 移动端 play() 偶发拒绝，重试
                else { console.warn("[tts] 段播放失败跳过:", url); playNext(); } // 放弃该段不卡链
            });
        };
        tryPlay();
    };
    scenePlayer.onended = playNext;
    scenePlayer.onerror = () => { // 单个文件 error：先重试该段一次再跳（ArkWeb 发虚假 error）
        console.warn("[tts] 段 error:", scenePlayer.src);
        if (gen !== speechGen) return;
        if (segError < 1) {
            segError++;
            // 重试该段：重置 src + load + play（不动索引，重播当前段）
            const url = scenePlaylist[scenePlayIdx - 1];
            scenePlayer.src = url; scenePlayer.load();
            scenePlayer.playbackRate = speechPref.rate || 1;
            scenePlayer.play().catch(() => setTimeout(playNext, 200));
        } else {
            segError = 0;
            setTimeout(playNext, 200); // 两次 error 才真正跳过
        }
    };
    chainActive = true;
    // 故事层（低优先）：图鉴介绍(codex) 开始后会暂停本链，停止后恢复
    storyRelease = acquireAudio("story", () => scenePlayer.pause(), () => scenePlayer.play());
    playNext();
}

/** 续接到当前链尾（选项朗读跟在正文之后）；链已结束则新开一条 */
/** 接到播放链尾（链空则直接开播）。语音引导音频等「排在故事之后」的短 clip 用这条 */
export function queueClip(url: string): void {
    appendChain([url]);
}

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
    revokeBlobs(); // 句级接力链：吊销未播完链的 blob（新链会重建）
    blobLaunched = 0; blobSettled = 0; latT0 = null; playbackStarted = false;
    if (storyRelease) { storyRelease(); storyRelease = null; } // 释放故事层焦点
}

/** 首次交互补读用：播放链是否空闲 */
export function sceneAudioIdle(): boolean {
    return scenePlayer.paused;
}

/* ===== 动态文本朗读（服务端 TTS） ===== */

/* ----- 句级接力播放（2026-10-03 v2，plan: docs/superpowers/plans/2026-10-03-tts-serial-relay-playback.md） -----
   v1（纯预取+80ms 轮询）的两大问题：①advance 下一句除了正常 ended 还有「error 重试耗尽也放行」，
   内核虚假 error/解码失败时句子被截断就进下一句（用户真机确认）；②等待语义与播放结束无关。
   v2 接力模型（用户拍板）：t0 只发首句（最快出声）→ 首句开播后其余句最大并发预取 → 每句 ended 后
   才进入下一句的等待窗口（1s×5 → 2s×5 ≈15s，覆盖服务端 3 次退避重试最坏 12s → 重渲一次 → 跳句）；
   **advance 只认 ended**：error 升级链 = 同 blob 重播（ArkWeb 虚假 error 零成本）→ 重渲整句 → 跳句。 */
const TTS_FETCH_CAP = 3;      // 对齐服务端 _sem=3（客户端超开只是排队）
const TTS_FETCH_TIMEOUT = 15000; // 必须覆盖服务端 3 次退避重试的最坏 ~11s（6s 会掐死正在重试的请求，弱网雪崩）

let blobs: (string | null | undefined)[] = []; // 句 → blob URL（undefined=渲染中 / null=失败）
let blobLaunched = 0, blobSettled = 0;         // 预取池水位
let playbackStarted = false;                   // 首句开播前只预取首句（用户拍板 t0 单发）
let latT0: number | null = null;               // 首声埋点基准（本次链第一个请求发出时刻）

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function revokeBlobs(): void {
    for (const b of blobs) if (b) URL.revokeObjectURL(b);
}

/** 单句 tts → blob URL；15s 超时 + 失败重试 1 次（退避 0.9s——服务端 502 多是到微软的瞬时抖动，
 *  立即重试还在风暴窗口内），双败返回 null（调用方跳句）。服务端 render_tts 自身另有 3 次退避重试。
 *  ⚠ 尺寸防御（2026-10-03）：空/残废 mp3（曾因缓存毒化出现 0B）会 200 但秒 ended=吞句，<1KB 视为失败。 */
async function fetchTtsBlob(url: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(900);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TTS_FETCH_TIMEOUT);
        try {
            const res = await fetch(url, { signal: ctl.signal });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const blob = await res.blob();
            if (blob.size < 1024) throw new Error("空音频 " + blob.size + "B");
            return URL.createObjectURL(blob);
        } catch { /* 超时/网络/HTTP 错/坏音频 → 重试或放弃 */ }
        finally { clearTimeout(timer); }
    }
    return null;
}

/** 句级 tts URL 批量预取（并发池 cap）：返回与 urls 对齐的 promise 数组（null=该句失败）。
 *  播放链（startStreamChain）与自带播放器的调用方（控制台问答）共用。 */
export function prefetchTts(urls: string[]): Promise<string | null>[] {
    const ps: Promise<string | null>[] = new Array(urls.length);
    let launched = 0, settled = 0;
    const launch = (): void => {
        while (launched < urls.length && launched - settled < TTS_FETCH_CAP) {
            const i = launched++;
            ps[i] = fetchTtsBlob(urls[i]).finally(() => { settled++; launch(); });
        }
    };
    launch();
    return ps;
}

/** 播放链专用池：预取 scenePlaylist 里的句子。首句开播前只放行首句（t0 单发最快出声）；
 *  开播后其余句最大并发补齐（appendChain 追加的由接力循环补调）。 */
function launchPrefetch(): void {
    const limit = playbackStarted ? scenePlaylist.length : Math.min(1, scenePlaylist.length);
    while (blobLaunched < limit && blobLaunched - blobSettled < TTS_FETCH_CAP) {
        const i = blobLaunched++;
        fetchTtsBlob(scenePlaylist[i]).then(u => {
            blobs[i] = u;
            if (i === 0 && latT0 !== null) { // 首声埋点：首句 blob 就绪耗时 ≈ 出声前等待（不含 LLM 段）
                reportEvent({ type: "tts_latency", payload: { first_ms: Date.now() - latT0, sents: scenePlaylist.length } });
                latT0 = null;
            }
        }).catch(() => { blobs[i] = null; })
          .finally(() => { blobSettled++; launchPrefetch(); });
    }
}

/** 单句播放：resolve **true=自然播完（ended）**；false=失败（error / play 拒绝耗尽 / gen 切换 /
 *  **看门狗超时**）。⚠ 2026-10-03 v2：error 不在本层重试或放行下一句——升级链（同 blob 重播→重渲→
 *  跳句）在 playBlobStrict；本层只忠实上报「这句放完了吗」。 */
function playBlob(url: string, gen: number): Promise<boolean> {
    return new Promise(resolve => {
        const done = (ok: boolean) => {
            clearTimeout(playingWatchdog); clearTimeout(hardCap);
            scenePlayer.onended = null; scenePlayer.onerror = null; scenePlayer.onpause = null;
            scenePlayer.onplaying = null;
            resolve(ok);
        };
        if (gen !== speechGen) { resolve(false); return; }
        scenePlayer.src = url;
        scenePlayer.load(); // 移动内核换 src 不 load 会静默丢段（2026-09-01 Mate 60 实测）
        scenePlayer.playbackRate = speechPref.rate || 1; // 家长语速滑块
        let playTries = 2;
        // 看门狗（真机僵死保险）：①8s 内没有 playing 事件（play() 挂起/被静默拒绝）→ 失败上交；
        // ②单句硬上限 60s（正常句 1-6s）——任何事件缺席的媒体僵死都不能让链永久卡死
        let started = false;
        const playingWatchdog = setTimeout(() => { if (!started) done(false); }, 8000);
        const hardCap = setTimeout(() => done(false), 60000);
        const tryPlay = () => {
            if (gen !== speechGen) { done(false); return; }
            scenePlayer.play().catch(() => {
                if (playTries-- > 0) setTimeout(tryPlay, 300);
                else done(false); // 起不来（如自动播放策略）：失败上交，链层决定升级
            });
        };
        scenePlayer.onplaying = () => {
            started = true;
            clearTimeout(playingWatchdog);
            scenePlayer.onplaying = null;
        };
        scenePlayer.onended = () => done(true);
        scenePlayer.onerror = () => {
            if (gen !== speechGen) { done(false); return; }
            done(false); // 解码/加载失败：升级链接手（修复「句子被截断就进下一句」）
        };
        // stopSpeech（gen++ 先于 pause）借 pause 解锁 await；自然结束也发 pause，但 gen 未变不 resolve
        scenePlayer.onpause = () => { if (gen !== speechGen) done(false); };
        tryPlay();
    });
}

/** 播放结束后等待第 i 句渲染就绪：1s×5 → 2s×5 → 3s×5（≈30s，覆盖服务端 3 次退避重试最坏 ~11s
 *  × 并发排队）→ 每轮耗尽后重新渲染一次（fetch 15s 超时×2）→ 两轮重渲仍失败才跳句（最后手段，
 *  上报 tts_skip 诊断事件——2026-10-03 用户要求宁慢勿丢）。 */
async function waitBlob(i: number, gen: number): Promise<string | null> {
    const gaps = [1000, 1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000, 2000, 3000, 3000, 3000, 3000, 3000];
    for (const gap of gaps) {
        const b = blobs[i];
        if (b) return b;
        if (b === null) break; // 预取双败 → 走重渲
        if (gen !== speechGen) return null;
        await sleep(gap);
    }
    if (gen !== speechGen) return null;
    for (let round = 0; round < 2; round++) {
        const again = await fetchTtsBlob(scenePlaylist[i]);
        if (gen !== speechGen) return null;
        if (again) {
            if (blobs[i] && blobs[i] !== again) URL.revokeObjectURL(blobs[i] as string);
            blobs[i] = again;
            return again;
        }
        await sleep(2000); // 给服务端缓存/网络一个喘息窗口再试
    }
    reportEvent({ type: "tts_skip", payload: { i, text: scenePlaylist[i].slice(0, 120) } });
    return null;
}

/** 严格接力：只有自然 ended 才算本句完成（2026-10-03 v2 修复「句子被截断就进下一句」）。
 *  error → 同 blob 重播一次（ArkWeb 虚假 error 零成本）→ 仍败 → 重新 fetch 整句再播 → 仍败跳句。 */
async function playBlobStrict(i: number, gen: number): Promise<void> {
    const first = blobs[i] as string;
    if (await playBlob(first, gen)) return;
    if (gen !== speechGen) return;
    if (await playBlob(first, gen)) return;
    if (gen !== speechGen) return;
    const again = await fetchTtsBlob(scenePlaylist[i]);
    if (gen !== speechGen || !again) return;
    if (blobs[i] && blobs[i] !== again) URL.revokeObjectURL(blobs[i] as string);
    blobs[i] = again;
    await playBlob(again, gen);
}

/** 接力协程（2026-10-03 v2）：每句 ended 后才进入下一句的等待窗口；等待期间预取在后台继续，
 *  正常路径零等待（预取早已就绪）。首句开播那一刻才放行其余句的并发预取。 */
async function runStreamChain(gen: number): Promise<void> {
    while (gen === speechGen) {
        launchPrefetch();
        const i = scenePlayIdx;
        if (i >= scenePlaylist.length) {
            chainActive = false;
            for (const b of blobs) if (b) URL.revokeObjectURL(b);
            return;
        }
        const b = await waitBlob(i, gen);
        if (gen !== speechGen) return;
        scenePlayIdx = i + 1;
        if (!b) continue; // 跳句（重播+重渲都失败的最后手段）
        if (!playbackStarted) { playbackStarted = true; launchPrefetch(); }
        await playBlobStrict(i, gen);
    }
}

/** 句级接力播放链：与 startChain 共享 scenePlaylist/scenePlayIdx/chainActive——
 *  speakChoices/queueClip 的 appendChain 续接语义不变。 */
function startStreamChain(urls: string[], duck?: boolean): void {
    stopSpeech(); // 停旧链（吊销旧 blob）+ 拿新 speechGen
    blobs = new Array(urls.length).fill(undefined);
    blobLaunched = 0; blobSettled = 0;
    playbackStarted = false;
    scenePlaylist = urls.slice();
    scenePlayIdx = 0;
    scenePlayer.volume = duck ? 0.55 : 1; // 且听风吟：人声 duck 给风声
    chainActive = true;
    latT0 = Date.now();
    storyRelease = acquireAudio("story", () => scenePlayer.pause(), () => scenePlayer.play());
    launchPrefetch();
    void runStreamChain(speechGen);
}

/** 控制台问答等自带播放器的调用方用：句切 + 清洗 + URL 化（alias/lang 已含） */
export function splitTtsUrls(text: string, who: string): string[] {
    const urls: string[] = [];
    for (const s of splitSentences(text)) {
        const cleaned = cleanForSpeech(s);
        if (cleaned) urls.push(ttsUrl(cleaned, who));
    }
    return urls;
}

export function speakStory(text: string, volume?: number, overrides?: Record<string, string>): void {
    if (!speechPref.on) return;
    const urls: string[] = [];
    for (const seg of parseTextSegs(text, overrides)) { // 先在原文上归属角色（引号还在，定界精确）
        for (const s of splitSentences(seg.text)) {     // 段内句切 → 每句继承所在段的 who
            const cleaned = cleanForSpeech(s);          // 再清洗（去舞台说明/引号字符）
            if (cleaned) urls.push(ttsUrl(cleaned, seg.who));
        }
    }
    if (urls.length) startStreamChain(urls, volume !== undefined && volume < 1);
}

// 选项朗读：接在正文链尾；两个选项时前缀“你选。”（呼应海鸥台词）
// 有自由输入选项时，末尾补一句“或者，说说你的想法”
export function speakChoices(choices?: { text: string }[], hasFreeInput?: boolean): void {
    if (!speechPref.on || !speechPref.readChoices || choicesQueued || !choices || !choices.length) return;
    const prefix = choices.length > 1 ? t("speech.choice_prefix") : "";
    const suffix = hasFreeInput ? t("speech.freeinput_suffix") : "";
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

/** 故事包加载后调用：定位音频资产 + 拉取 manifest（版本参数防缓存错位）。返回 Promise 供启动门等待。
 *  en 模式先试 audio-en/manifest.json，没有则回退中文包（语音会自动降级为服务端 TTS 英文声线） */
export function initAudioAssets(): Promise<void> {
    // 只有含 isSpecialListen 场景的故事才有风声资产，避免无风声包白 404
    if (Object.values(pack().scenes).some(s => s.isSpecialListen)) {
        windAudio.src = pack().baseUrl + "audio/" + encodeURIComponent("风声") + ".mp3";
    }
    const manifestUrl = lang === "en"
        ? pack().baseUrl + "audio-en/manifest.json?v=" + Date.now()
        : pack().baseUrl + "audio/manifest.json?v=" + Date.now();
    return fetch(manifestUrl)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(m => { audioManifest = m; })
        .catch(() => {
            // en 包还没渲出来：回退中文包（内容对不上时服务端 TTS 会兜底英文）
            if (lang === "en") {
                return fetch(pack().baseUrl + "audio/manifest.json?v=" + Date.now())
                    .then(r => r.ok ? r.json() : Promise.reject(r.status))
                    .then(m => { audioManifest = m; })
                    .catch(() => {});
            }
        });
}

export function playSceneAudio(key: string, duck?: boolean): boolean {
    if (!audioManifest || !audioManifest[key] || !speechPref.on) return false;
    const entry = audioManifest[key];
    const base = pack().baseUrl + (lang === "en" ? "audio-en/" : "audio/");
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
