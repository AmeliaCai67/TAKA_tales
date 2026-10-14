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
import { session } from "./session";
import { ensureAnonId } from "./anon";
import { t, lang } from "./i18n";
import { splitSentences } from "./tts-sentence";
import { applyTtsAliases } from "./tts-aliases";

/* ===== 台词归属（tts-segments.ts 纯模块，与 packages/tts-pipeline/tts_pipeline/segments.py 严格镜像） =====
   2026-10-12：解析整体迁入 tts-segments.ts（可独立测试），并补齐英文状态机——
   此前客户端只有中文式正则，LLM 生成的英文台词（TAKA says, “…”/弯引号/后置归属）全部塌给 narrator。 */
import { parseTextSegs as parseSegs, type Seg } from "./tts-segments";
export type { Seg };

/** 如我所书（2026-08-19）：把一段故事文本解析成逐句（说话人+文本），供对话流收集/上报。
 *  与朗读链路同一解析器，保证书的内容与听到的一致。 */
export function parseTextSegs(text: string, overrides?: Record<string, string>): Seg[] {
    return parseSegs(text, pack().speakers, overrides, lang);
}

// 朗读前清洗：去掉（）内舞台说明（英文含半角括号）；去掉引号字符
function cleanForSpeech(s: string): string {
    let t = s.replace(/（[^）]*）/g, "");
    if (lang === "en") t = t.replace(/\([^)]*\)/g, "");
    return t.replace(/["“”「」『』]/g, "").trim();
}

/** 读音别名（story.json ttsAliases）：显示文本不动，只改喂给 TTS 的文案（757 → 七五七）
 *  注入在 ttsUrl：所有动态朗读路径（正文/选项/选项 C 生成文本）统一经过这里。 */
function aliasForSpeech(t: string): string {
    const aliases = pack().ttsAliases;
    if (!aliases) return t;
    return applyTtsAliases(t, aliases);
}

/** URL 组装：**spoken 必须是已过 aliasForSpeech 的最终文案**——它同时进播放 URL 与 warm 清单
 *  （P0 缓存 key 一致性的唯一接缝：两处同源，服务端 sha1 key 才能逐字节一致） */
function ttsUrlRaw(spoken: string, who: string): string {
    // i18n（2026-08-28）：en 模式走英文声线表（/api/tts?lang=en → voices_en）
    const langParam = lang === "en" ? "&lang=en" : "";
    // pv=声线表版本：URL 一次性绕开浏览器里按旧 URL 缓存的旧供应商音频（服务端不认识此参数、
    // 不进缓存 key，warm 一致性不受影响）。换声线表/供应商时 +1（2026-10-12 阿里云迁移=2）
    return TTS_ENDPOINT + "?text=" + encodeURIComponent(spoken) + "&who=" + encodeURIComponent(who) + langParam + "&pv=2";
}

function ttsUrl(text: string, who: string): string {
    return ttsUrlRaw(aliasForSpeech(text), who);
}

const WARM_BATCH = 24; // 与服务端 WARM_MAX_ITEMS 对齐（tts.py）——review 2026-10-08 #4：整批超限=422 全拒

/** P0 批量预热（plan: docs/superpowers/plans/2026-10-08-tts-robustness-antidrop.md）：
 *  文本定稿时刻把最终句清单 POST 给服务端开渲——渲染起跑线提前到孩子读字的几秒里，
 *  播放时的逐句请求退化成「取文件」。fire-and-forget：任何失败（无身份/断网/401/422）只是
 *  优雅降级回「播放时逐句冷请求」的现状，不影响播放。鉴权复用双通道（Bearer / X-Anon-ID）。
 *  review 2026-10-08 #4 修复：长回复按 ≤24 分批（8/12 真实回复超单批上限，整批 POST 必 422）；
 *  检查 res.ok 并逐批上报 tts_warm_batch（接受/拒绝/失败可观测，不再静默失效）。 */
async function warmTts(items: { text: string; who: string }[]): Promise<void> {
    if (!items.length || !speechPref.on) return;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (session.token) {
        headers["Authorization"] = "Bearer " + session.token;
    } else {
        const id = await ensureAnonId();
        if (!id) return; // 游客未注册成功：预热放弃，播放链自会冷请求
        headers["X-Anon-ID"] = id;
    }
    for (let i = 0; i < items.length; i += WARM_BATCH) {
        const batch = items.slice(i, i + WARM_BATCH);
        let ok = false, status = 0;
        try {
            const res = await fetch(TTS_ENDPOINT + "/warm", {
                method: "POST",
                headers,
                body: JSON.stringify({ items: batch, lang }),
            });
            ok = res.ok;
            status = res.status;
        } catch { /* 断网/超时：优雅降级冷请求 */ }
        reportEvent({ type: "tts_warm_batch", payload: { ok, status, n: batch.length } });
    }
}

/* ===== 统一播放链：mp3 包与动态 TTS 共用 ===== */
const scenePlayer = new Audio();

/** Prime this same media element in the wake gesture before the reveal animation. */
export function unlockStoryAudio(): void {
    if (!speechPref.on) return;
    const wav = new ArrayBuffer(44 + 1600), view = new DataView(wav);
    const write = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    write(0,'RIFF'); view.setUint32(4, wav.byteLength - 8, true); write(8,'WAVE'); write(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
    write(36,'data'); view.setUint32(40,1600,true);
    const url = URL.createObjectURL(new Blob([wav], {type:'audio/wav'}));
    scenePlayer.src = url;
    void scenePlayer.play().then(() => { if (scenePlayer.src === url) scenePlayer.pause(); }).catch(() => {}).finally(() => URL.revokeObjectURL(url));
}
let voiceGain = 1;
let speechGen = 0;            // 播放代际：stopSpeech/新播放使旧协程失效（自增即失效）
let choicesQueued = false;    // 选项朗读已在链里（manifest choices.mp3）→ speakChoices 不再重复

/** 单次播放的独立上下文（review 2026-10-08 #1 修复）：请求、队列、水位、计数器全部绑定
 *  链对象——旧链的一切异步回调（预取 resolve/播放事件/定时器）先核对 state === chain，
 *  过期结果只回收（revoke）不回写。此前这些状态是模块级共享变量，切场/停播/自由输入换链后，
 *  旧请求返回会覆盖新链同索引的 blob（真实 Chrome 复现：新塔卡台词被旧旁白替换）。 */
interface ChainState {
    gen: number;
    urls: string[];
    blobs: (string | null | undefined)[]; // 句 → blob URL（undefined=在途 / null=失败）
    launched: number;                     // 预取已发出数
    settled: number;                      // 预取已结算数
    playbackStarted: boolean;             // 首句开播前只预取首句（t0 单发最快出声）
    idx: number;                          // 播放进度
    finished: boolean;                    // 自然播完（appendChain 据此决定续接还是新开）
    t0: number | null;                    // 首声埋点基准（本链第一个请求发出时刻）
    abort: AbortController;               // stopSpeech 时取消本链在途请求
    release: (() => void) | null;         // 故事层音频焦点（供高优先级暂停/恢复）
}
let chain: ChainState | null = null;

/** P1-B 播放通道统一（plan 2026-10-08）：固定场景 mp3 不再走裸 Audio 换 src 的旧链
 *  （每段 1 次 error 重试就跳段=吞音主源），统一进 fetch→blob→playBlobStrict 严格接力——
 *  白拿动态链的全部韧性（同 blob 重播/重取/看门狗/ended-only advance）。
 *  静态文件无渲染延迟，blob 化只赚不亏；manifest 的 mp3 文件完整，校验放宽为 size>0（见 fetchAudioBytes）。 */
function startChain(urls: string[], duck?: boolean): void {
    startStreamChain(urls, duck);
}

/** 续接到当前链尾（选项朗读跟在正文之后）；链已结束则新开一条 */
/** 接到播放链尾（链空则直接开播）。语音引导音频等「排在故事之后」的短 clip 用这条 */
export function queueClip(url: string): void {
    appendChain([url]);
}

function appendChain(urls: string[]): void {
    const c = chain;
    if (c && !c.finished) {
        c.urls.push(...urls);
        c.blobs.push(...urls.map(() => undefined));
        launchPrefetch(c); // 已开播则立即放行新句预取；未开播仍受「首句单发」限制
    } else {
        startChain(urls);
    }
}

export function stopSpeech(): void {
    speechGen++; // 使旧协程失效
    const c = chain;
    chain = null; // 同步摘链：旧链一切回调从此「过期」（只回收不回写）
    if (c) {
        c.abort.abort(); // 取消在途预取/重渲请求（不再白占带宽，也不再有回写窗口）
        for (const b of c.blobs) revokeBlobUrl(b);
        if (c.release) { c.release(); c.release = null; }
    }
    currentCancel?.(); // 同步收尾挂起的播放 attempt——不依赖异步 pause 事件（review #3：pause 派发前旧 attempt 悬挂）
    scenePlayer.pause();
    scenePlayer.onended = null;
    scenePlayer.onerror = null;
    scenePlayer.onpause = null;
    scenePlayer.onplaying = null;
    choicesQueued = false;
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
   才进入下一句的等待窗口（1s×5 → 2s×5 ≈15s → 重渲一次 → 跳句；渲染时长由 fetch 30s 超时兜底）；
   **advance 只认 ended**：error 升级链 = 同 blob 重播（ArkWeb 虚假 error 零成本）→ 重渲整句 → 跳句。 */
const TTS_FETCH_CAP = 2;      // 对齐服务端 _sem=2（阿里云限流实测并发>2 即 task-failed，超开只会白排队）
const TTS_FETCH_TIMEOUT = 30000; // 覆盖服务端 sem=2 排队 + 阿里云最坏冷渲（codex 验收实测 27.4s）+ 退避重试
// 尺寸门槛（与服务端 MIN_MP3_BYTES 同源，apps/api/tests/calibrate_min_mp3.py 实测校准 2026-10-06）：
// 客户端不区分声线类，取全局下限（fx 阈值 950B）；fx 声线的 1440B 级残片由服务端原子发布+锁内校验拦截
const MIN_TTS_BYTES = 950;

/** 动态 TTS 与静态包音频的判别：动态 URL 一律 TTS_ENDPOINT + "?text=…"（ttsUrlRaw 唯一出口）。
 *  校验门槛分流（P1-B）：动态句沿用 950B 下限（空/残废 mp3 会 200 但秒 ended=吞句）；
 *  静态 mp3 是构建期产物文件完整，放宽为 size>0——误杀合法短文件比放过残片代价高。 */
function isDynamicTts(url: string): boolean {
    return url.startsWith(TTS_ENDPOINT + "?");
}

/** 静态 mp3 内存缓存（P1 滚动预取的落点）：url → 原始 Blob。存 Blob 而非 objectURL——
 *  播放链每次取用时现 createObjectURL，revokeBlobUrl 随便吊销不会毒化缓存。initAudioAssets 换包时清空。
 *  ⚠ 字节存在/size>0 不证明可解码：媒体级失败由 evictStaticBlob 反查淘汰（review 2026-10-08 #2）。 */
const staticBlobs = new Map<string, Blob>();
/** 在途请求去重（review 2026-10-08）：预取池（prefetchSceneAudio/prefetchTts）与播放池可能
 *  同时拉同一 url——复用在途 promise，不再各发一份（服务端 _locks 只合并同句渲染，不省传输）。 */
const inflight = new Map<string, Promise<Blob | null>>();
/** objectURL → 源 url：媒体级失败（解码 error）时反查淘汰 staticBlobs 坏条目 */
const srcByObjectUrl = new Map<string, string>();

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function revokeBlobUrl(u?: string | null): void {
    if (!u) return;
    URL.revokeObjectURL(u);
    srcByObjectUrl.delete(u);
}

/** 媒体级失败（error 重播+重取后仍 failed）→ 字节层缓存不可信，淘汰防复发（review #2） */
function evictStaticBlob(objUrl?: string | null): void {
    if (!objUrl) return;
    const src = srcByObjectUrl.get(objUrl);
    if (src) staticBlobs.delete(src);
}

interface FetchOpts {
    bustCache?: boolean; // 恢复请求：绕过**并淘汰**内存缓存，必走网络（review #2：此前命中短路，恢复=重放坏字节）
    signal?: AbortSignal; // 链停止时取消在途请求；aborted 后不再重试
}

/** 字节层：url → Blob（静态进 staticBlobs 供滚动预取命中）；30s 超时 + 失败重试 1 次（退避 0.9s——
 *  覆盖服务端 sem=2 排队 + 阿里云限流退避重试最坏 ~30s，codex 验收实测冷渲最坏 27.4s），双败返回 null。
 *  ⚠ 尺寸防御（2026-10-06 与服务端校准门槛对齐）：空/残废 mp3 会 200 但秒 ended=吞句。
 *  动态句 <MIN_TTS_BYTES 视为失败；静态包是构建期产物，放宽为 size>0（误杀合法短文件代价更高）。
 *  ⚠ bustCache（2026-10-06 spec §三.4）：重试用 **reload** 而非 no-store——坏响应被浏览器缓存后
 *  reload 绕过且回写，一次恢复请求即治愈缓存条目。 */
async function fetchAudioBytes(url: string, opts?: FetchOpts): Promise<Blob | null> {
    const dynamic = isDynamicTts(url);
    if (!dynamic) {
        if (opts?.bustCache) staticBlobs.delete(url); // 恢复请求：先淘汰疑似坏条目，绝不重放坏字节
        else if (staticBlobs.has(url)) return staticBlobs.get(url)!; // 滚动预取命中：零网络
    }
    if (!opts?.bustCache && inflight.has(url)) return inflight.get(url)!;
    const p = (async () => {
        const minBytes = dynamic ? MIN_TTS_BYTES : 1;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (opts?.signal?.aborted) return null; // 链已停：立即终止，不进退避重试
            if (attempt > 0) await sleep(900);
            const ctl = new AbortController();
            const onAbort = () => ctl.abort(); // 外部取消桥进本请求的超时控制器
            opts?.signal?.addEventListener("abort", onAbort);
            const timer = setTimeout(() => ctl.abort(), TTS_FETCH_TIMEOUT);
            try {
                const res = await fetch(url, {
                    signal: ctl.signal,
                    cache: attempt > 0 || opts?.bustCache ? "reload" : "default",
                });
                if (!res.ok) throw new Error("HTTP " + res.status);
                // P4：服务端标缓存状态（warm=缓存命中或锁内合并 / cold=本次新渲染）→ warm 命中率埋点
                const cacheState = res.headers.get("X-TTS-Cache");
                if (cacheState) reportEvent({ type: "tts_warm_hit", payload: { hit: cacheState === "warm" } });
                const blob = await res.blob();
                if (blob.size < minBytes) throw new Error("空音频 " + blob.size + "B");
                if (!dynamic) staticBlobs.set(url, blob);
                return blob;
            } catch {
                if (opts?.signal?.aborted) return null; // 外部取消：立即终止不重试
                /* 超时/网络/HTTP 错/坏音频 → 重试或放弃 */
            } finally {
                clearTimeout(timer);
                opts?.signal?.removeEventListener("abort", onAbort);
            }
        }
        return null;
    })();
    if (!opts?.bustCache) {
        inflight.set(url, p);
        void p.then(
            () => { if (inflight.get(url) === p) inflight.delete(url); },
            () => { if (inflight.get(url) === p) inflight.delete(url); },
        );
    }
    return p;
}

/** objectURL 层（播放链用）：字节就绪后 createObjectURL + 登记源映射。
 *  prefetchSceneAudio 只做字节预热（fetchAudioBytes），不产生 objectURL——预取结果被丢弃
 *  造成的泄漏源就此消除（review 对 plan 的补充意见）。 */
async function fetchTtsBlob(url: string, opts?: FetchOpts): Promise<string | null> {
    const b = await fetchAudioBytes(url, opts);
    if (!b) return null;
    const objUrl = URL.createObjectURL(b);
    srcByObjectUrl.set(objUrl, url);
    return objUrl;
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

/** 播放链专用池：预取本链 urls 里的句子。首句开播前只放行首句（t0 单发最快出声）；
 *  开播后其余句最大并发补齐（appendChain 追加的由接力循环补调）。
 *  review 2026-10-08 #1 修复：一切回调先核对链归属——过期链的结果只回收（revoke）不回写，
 *  不再污染新链同索引的 blob；水位计数也各自独立，不再跨链串数。 */
function launchPrefetch(state: ChainState): void {
    const limit = state.playbackStarted ? state.urls.length : Math.min(1, state.urls.length);
    while (state.launched < limit && state.launched - state.settled < TTS_FETCH_CAP) {
        const i = state.launched++;
        fetchTtsBlob(state.urls[i], { signal: state.abort.signal }).then(u => {
            if (state !== chain) {
                if (u) URL.revokeObjectURL(u); // 过期链：只回收不回写
                return;
            }
            state.blobs[i] = u;
            if (i === 0 && state.t0 !== null) { // 首声埋点：首句 blob 就绪耗时 ≈ 出声前等待（不含 LLM 段）
                reportEvent({ type: "tts_latency", payload: { first_ms: Date.now() - state.t0, sents: state.urls.length } });
                state.t0 = null;
            }
        }).catch(() => { if (state === chain) state.blobs[i] = null; })
          .finally(() => { state.settled++; if (state === chain) launchPrefetch(state); });
    }
}

/** 单句播放结果三态（review 2026-10-08 #3）：ended=自然播完；cancelled=链已停（切场/停播），
 *  不算故障不上报；failed=媒体故障（error / play 拒绝耗尽 / 看门狗超时），交升级链处置。
 *  ⚠ 2026-10-03 v2：error 不在本层重试或放行下一句——升级链在 playBlobStrict。
 *  ⚠ attempt 所有权（review #3）：共享 scenePlayer 上旧 attempt 的看门狗到期只能收尾自己，
 *  不得清掉新 attempt 的 handlers——以 playSeq 序号判定「我是否还是最新 attempt」。 */
type PlayResult = "ended" | "cancelled" | "failed";
let playSeq = 0; // 共享 Audio 的 attempt 序号：新 attempt 装新 handlers（属性赋值天然覆盖旧的）
let currentCancel: (() => void) | null = null; // 最新 attempt 的同步收尾通道（stopSpeech 用，不依赖异步 pause 事件）

function playBlob(url: string, state: ChainState): Promise<PlayResult> {
    return new Promise(resolve => {
        const mine = ++playSeq;
        let settled = false;
        const done = (r: PlayResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(playingWatchdog); clearTimeout(hardCap);
            if (currentCancel === cancelSelf) currentCancel = null;
            if (playSeq === mine) { // 只有最新 attempt 能清共享 handlers——旧看门狗到期不再误杀新段
                scenePlayer.onended = null; scenePlayer.onerror = null;
                scenePlayer.onpause = null; scenePlayer.onplaying = null;
            }
            resolve(r);
        };
        const cancelSelf = () => done("cancelled");
        const stale = () => state !== chain;
        if (stale()) { done("cancelled"); return; }
        currentCancel = cancelSelf; // 覆盖旧的（旧 attempt 仍有自己的看门狗兜底收尾）
        scenePlayer.src = url;
        scenePlayer.load(); // 移动内核换 src 不 load 会静默丢段（2026-09-01 Mate 60 实测）
        scenePlayer.playbackRate = speechPref.rate || 1; // 家长语速滑块
        let playTries = 2;
        // 看门狗（真机僵死保险）：①8s 内没有 playing 事件（play() 挂起/被静默拒绝）→ 失败上交；
        // ②单句硬上限 60s（正常句 1-6s）——任何事件缺席的媒体僵死都不能让链永久卡死
        let started = false;
        const playingWatchdog = setTimeout(() => { if (!started) done("failed"); }, 8000);
        const hardCap = setTimeout(() => done("failed"), 60000);
        const tryPlay = () => {
            if (stale()) { done("cancelled"); return; }
            scenePlayer.play().catch(() => {
                if (stale()) { done("cancelled"); return; }
                if (playTries-- > 0) setTimeout(tryPlay, 300);
                else done("failed"); // 起不来（如自动播放策略）：失败上交，链层决定升级
            });
        };
        scenePlayer.onplaying = () => {
            started = true;
            clearTimeout(playingWatchdog);
            scenePlayer.onplaying = null;
        };
        scenePlayer.onended = () => done("ended");
        scenePlayer.onerror = () => { done(stale() ? "cancelled" : "failed"); }; // 解码/加载失败：升级链接手
        // stopSpeech 已同步摘链（chain=null）并触发 currentCancel；这里的 pause 兜底处理
        // 其他来源的 pause（音频焦点插播不 resolve——链没死，resume 后继续播）
        scenePlayer.onpause = () => { if (stale()) done("cancelled"); };
        tryPlay();
    });
}

/** 播放结束后等待第 i 句渲染就绪：1s×5 → 2s×5 → 3s×5（≈30s）→ 每轮耗尽后重新渲染一次
 *  （fetch 30s 超时×2）→ 两轮重渲仍失败才跳句（最后手段，
 *  上报 tts_skip 诊断事件——2026-10-03 用户要求宁慢勿丢）。 */
async function waitBlob(state: ChainState, i: number): Promise<string | null> {
    const gaps = [1000, 1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000, 2000, 3000, 3000, 3000, 3000, 3000];
    for (const gap of gaps) {
        const b = state.blobs[i];
        if (b) return b;
        if (b === null) break; // 预取双败 → 走重渲
        if (state !== chain) return null;
        await sleep(gap);
    }
    if (state !== chain) return null;
    for (let round = 0; round < 2; round++) {
        const again = await fetchTtsBlob(state.urls[i], { bustCache: true, signal: state.abort.signal }); // 重渲绕浏览器缓存（spec §三.4）
        if (state !== chain) return null;
        if (again) {
            if (state.blobs[i]) revokeBlobUrl(state.blobs[i]);
            state.blobs[i] = again;
            return again;
        }
        await sleep(2000); // 给服务端缓存/网络一个喘息窗口再试
    }
    reportEvent({ type: "tts_skip", payload: { i, text: state.urls[i].slice(0, 120) } });
    return null;
}

/** 严格接力：只有自然 ended 才算本句完成（2026-10-03 v2 修复「句子被截断就进下一句」）。
 *  error → 同 blob 重播一次（ArkWeb 虚假 error 零成本）→ 仍败 → 重新 fetch 整句再播 →
 *  仍败跳句。review 2026-10-08 #3 修复：跳句一律上报 tts_skip（此前 play 拒绝/重取失败
 *  被静默吞掉，tts_skip=0 不代表没吞句），并淘汰媒体级失败的静态内存条目（#2）。 */
async function playBlobStrict(state: ChainState, i: number): Promise<void> {
    const reportSkip = () => {
        reportEvent({ type: "tts_skip", payload: { i, text: state.urls[i].slice(0, 120) } });
        evictStaticBlob(state.blobs[i]); // 字节能过尺寸门槛 ≠ 可解码：坏条目不再供应
    };
    const first = state.blobs[i] as string;
    if (await playBlob(first, state) !== "failed") return;
    if (state !== chain) return;
    if (await playBlob(first, state) !== "failed") return; // 同 blob 重播
    if (state !== chain) return;
    const again = await fetchTtsBlob(state.urls[i], { bustCache: true, signal: state.abort.signal });
    if (state !== chain) return;
    if (!again) { reportSkip(); return; }
    if (state.blobs[i]) revokeBlobUrl(state.blobs[i]);
    state.blobs[i] = again;
    if (await playBlob(again, state) === "failed") reportSkip();
}

/** 接力协程（2026-10-03 v2）：每句 ended 后才进入下一句的等待窗口；等待期间预取在后台继续，
 *  正常路径零等待（预取早已就绪）。首句开播那一刻才放行其余句的并发预取。
 *  review 2026-10-08 #1：循环条件=链归属（state === chain），旧协程在 stopSpeech 后自然退出。 */
async function runStreamChain(state: ChainState): Promise<void> {
    while (state === chain) {
        launchPrefetch(state);
        const i = state.idx;
        if (i >= state.urls.length) {
            state.finished = true; // appendChain 据此决定「续接」还是「新开」
            for (const b of state.blobs) revokeBlobUrl(b);
            if (state.release) { state.release(); state.release = null; } // 归还音频焦点（此前仅 stopSpeech 归还）
            if (chain === state) chain = null;
            return;
        }
        const b = await waitBlob(state, i);
        if (state !== chain) return;
        state.idx = i + 1;
        if (!b) continue; // 跳句（waitBlob 已上报 tts_skip）
        if (!state.playbackStarted) { state.playbackStarted = true; launchPrefetch(state); }
        await playBlobStrict(state, i);
    }
}

/** 句级接力播放链：队列/水位/进度全在 ChainState 里，appendChain 续接语义不变。 */
function startStreamChain(urls: string[], duck?: boolean): void {
    stopSpeech(); // 停旧链（abort 在途 + revoke 旧 blob + 收尾挂起 attempt）+ speechGen++
    voiceGain = duck ? 0.55 : 1;
    scenePlayer.volume = voiceGain * speechPref.volume; // 且听风吟：人声 duck 给风声
    chain = {
        gen: speechGen,
        urls: urls.slice(),
        blobs: new Array(urls.length).fill(undefined),
        launched: 0, settled: 0,
        playbackStarted: false,
        idx: 0, finished: false,
        t0: Date.now(),
        abort: new AbortController(),
        release: acquireAudio("story", () => scenePlayer.pause(), () => scenePlayer.play()),
    };
    launchPrefetch(chain);
    void runStreamChain(chain);
}

/** 控制台问答等自带播放器的调用方用：句切 + 清洗 + URL 化（alias/lang 已含）。
 *  侧效应：把同一份最终句清单 POST 给 /api/tts/warm 开渲（P0）——urls 与 warm items 同源产出，
 *  缓存 key 天然一致；问一问的回答在 typewriter 慢慢出字的时刻渲染已经在跑。 */
export function splitTtsUrls(text: string, who: string): string[] {
    const urls: string[] = [];
    const warm: { text: string; who: string }[] = [];
    for (const s of splitSentences(text)) {
        const cleaned = cleanForSpeech(s);
        if (cleaned) {
            const spoken = aliasForSpeech(cleaned);
            urls.push(ttsUrlRaw(spoken, who));
            warm.push({ text: spoken, who });
        }
    }
    void warmTts(warm);
    return urls;
}

export function speakStory(text: string, volume?: number, overrides?: Record<string, string>): void {
    if (!speechPref.on) return;
    const urls: string[] = [];
    const warm: { text: string; who: string }[] = [];
    for (const seg of parseTextSegs(text, overrides)) { // 先在原文上归属角色（引号还在，定界精确）
        for (const s of splitSentences(seg.text)) {     // 段内句切 → 每句继承所在段的 who
            const cleaned = cleanForSpeech(s);          // 再清洗（去舞台说明/引号字符）
            if (cleaned) {
                const spoken = aliasForSpeech(cleaned); // 与播放 URL 同一字符串（P0 key 一致性）
                urls.push(ttsUrlRaw(spoken, seg.who));
                warm.push({ text: spoken, who: seg.who });
            }
        }
    }
    if (urls.length) {
        void warmTts(warm); // fire-and-forget：失败=退回逐句冷请求现状，播放链照走
        startStreamChain(urls, volume !== undefined && volume < 1);
    }
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
let windLevel = 0;

function windTo(target: number, ms = 800): void { // 音量渐变，避免硬切
    if (windFade) clearInterval(windFade);
    const from = windLevel, steps = 16;
    let i = 0;
    windFade = setInterval(() => {
        windLevel = Math.max(0, Math.min(1, from + (target - from) * (++i / steps)));
        windAudio.volume = windLevel * speechPref.volume;
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
    staticBlobs.clear(); // 换包：上一故事的静态音频缓存全部失效（防跨故事串音与内存堆积）
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

/** P1 滚动预取（plan 2026-10-08）：当前场景 + 下一可选场景的静态音频拉进内存缓存。
 *  引擎每 renderScene 调一次（initAudioAssets 之后才有 manifest，内部直接 no-op）；
 *  分支场景最多 3 个 next，量有界；命中与否对播放链透明（fetchAudioBytes 先查缓存）。
 *  review 2026-10-08 修订：只做字节层预热（fetchAudioBytes），不产生 objectURL——
 *  此前经 prefetchTts 产生的 objectURL 被丢弃=泄漏；重复 url 由 inflight 去重，重复调用零开销。 */
export function prefetchSceneAudio(key: string): void {
    if (!audioManifest || !speechPref.on) return;
    const scene = pack().scenes[key];
    const targets = new Set<string>([key]);
    if (scene) {
        for (const c of scene.choices || []) if (c.next) targets.add(c.next);
        if (scene.next) targets.add(scene.next);
    }
    const base = pack().baseUrl + (lang === "en" ? "audio-en/" : "audio/");
    const urls: string[] = [];
    for (const k of targets) {
        const entry = audioManifest[k];
        if (!entry) continue;
        for (const s of entry.segments) urls.push(base + s.file);
        if (entry.choices) urls.push(base + entry.choices.file); // 选项朗读接链尾，一并备好
    }
    let launched = 0, settled = 0;
    const pump = (): void => {
        while (launched < urls.length && launched - settled < TTS_FETCH_CAP) {
            const u = urls[launched++];
            void fetchAudioBytes(u).finally(() => { settled++; pump(); }); // 并发池 cap 3，不与播放链抢带宽
        }
    };
    pump();
}

/* ===== 🔊 按钮 + 语速滑块（语速即调即生效，无需试听——2026-08-27 移除试听按钮） ===== */

export function initSpeech(): void {
    const btn = document.getElementById("speech-btn")!;
    const volumeSlider = document.getElementById("sp-volume") as HTMLInputElement;
    const volumeValue = document.getElementById("sp-volume-value")!;
    const sync = () => {
        btn.innerHTML = speechPref.on ? ICON_SOUND_ON : ICON_SOUND_OFF;
        btn.setAttribute("aria-pressed", String(speechPref.on));
        volumeSlider.disabled = !speechPref.on;
    };
    volumeSlider.value = String(Math.round(speechPref.volume * 100));
    volumeValue.textContent = volumeSlider.value + "%";
    volumeSlider.oninput = () => {
        speechPref.volume = Number(volumeSlider.value) / 100;
        volumeValue.textContent = volumeSlider.value + "%";
        saveSpeechPref();
        scenePlayer.volume = voiceGain * speechPref.volume;
        windAudio.volume = windLevel * speechPref.volume;
        document.dispatchEvent(new Event('taka-volume-change'));
    };
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
