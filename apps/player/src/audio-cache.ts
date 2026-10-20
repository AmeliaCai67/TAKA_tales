// Audio bytes, cache and object URL ownership, independent of playback UI state.
import { TTS_ENDPOINT } from './config';
import { reportEvent } from './events';
const TTS_FETCH_CAP = 2;
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
const MAX_STATIC_BYTES = 8 * 1024 * 1024;
let staticBytes = 0;
let cacheGeneration = 0;
function deleteStatic(url: string): void {
    staticBytes -= staticBlobs.get(url)?.size || 0;
    staticBlobs.delete(url);
}
function rememberStatic(url: string, blob: Blob): void {
    deleteStatic(url);
    if (blob.size > MAX_STATIC_BYTES) return;
    while (staticBytes + blob.size > MAX_STATIC_BYTES && staticBlobs.size) deleteStatic(staticBlobs.keys().next().value!);
    staticBlobs.set(url, blob);
    staticBytes += blob.size;
}
export function clearAudioCache(): void { cacheGeneration++; staticBlobs.clear(); staticBytes = 0; }

/** 在途请求去重（review 2026-10-08）：预取池（prefetchSceneAudio/prefetchTts）与播放池可能
 *  同时拉同一 url——复用在途 promise，不再各发一份（服务端 _locks 只合并同句渲染，不省传输）。 */
const inflight = new Map<string, Promise<Blob | null>>();
/** objectURL → 源 url：媒体级失败（解码 error）时反查淘汰 staticBlobs 坏条目 */
const srcByObjectUrl = new Map<string, string>();

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function revokeBlobUrl(u?: string | null): void {
    if (!u) return;
    URL.revokeObjectURL(u);
    srcByObjectUrl.delete(u);
}

/** 媒体级失败（error 重播+重取后仍 failed）→ 字节层缓存不可信，淘汰防复发（review #2） */
export function evictStaticBlob(objUrl?: string | null): void {
    if (!objUrl) return;
    const src = srcByObjectUrl.get(objUrl);
    if (src) deleteStatic(src);
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
export async function fetchAudioBytes(url: string, opts?: FetchOpts): Promise<Blob | null> {
    const dynamic = isDynamicTts(url);
    const generation = cacheGeneration;
    if (!dynamic) {
        if (opts?.bustCache) deleteStatic(url); // 恢复请求：先淘汰疑似坏条目，绝不重放坏字节
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
                if (!dynamic && generation === cacheGeneration) rememberStatic(url, blob);
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
export async function fetchTtsBlob(url: string, opts?: FetchOpts): Promise<string | null> {
    const b = await fetchAudioBytes(url, opts);
    if (!b) return null;
    const objUrl = URL.createObjectURL(b);
    srcByObjectUrl.set(objUrl, url);
    return objUrl;
}

/** 句级 tts URL 批量预取（并发池 cap）：返回与 urls 对齐的 promise 数组（null=该句失败）。
 *  播放链（startStreamChain）与自带播放器的调用方（控制台问答）共用。 */
export function prefetchTts(urls: string[]): Promise<string | null>[] {
    const resolveAt: ((value: string | null) => void)[] = [];
    const promises = urls.map((_, index) => new Promise<string | null>(resolve => { resolveAt[index] = resolve; }));
    let next = 0;
    const worker = async () => {
        while (next < urls.length) {
            const index = next++;
            try { resolveAt[index](await fetchTtsBlob(urls[index])); }
            catch { resolveAt[index](null); }
        }
    };
    for (let i = 0; i < Math.min(TTS_FETCH_CAP, urls.length); i++) void worker();
    return promises;
}
