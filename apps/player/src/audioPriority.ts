// 音频优先级总线（2026-08-27）：解决「故事朗读」与「图鉴介绍」同时播放打架。
// 优先级（高→低）：codex(图鉴介绍) > story(故事剧情)。
// 规则：更高优先级播放开始时，自动暂停低优先级；高优先级结束(stop)时，自动恢复被暂停的低优先级。
// 低优先级不会抢占正在播放的高优先级（返回空 release，独立播放、不接管焦点）。

export type AudioLayer = "story" | "codex";
const ORDER: AudioLayer[] = ["story", "codex"];
const idx = (l: AudioLayer) => ORDER.indexOf(l);

interface Active {
    layer: AudioLayer;
    pause: () => void;
    resume: () => void;
}

let active: Active | null = null;
// 被更高优先级暂停的栈（LIFO）：恢复时先恢复最近被暂停的（优先级更高者），再逐层恢复
let suspended: (() => void)[] = [];

/** 申请某优先级的音频播放。
 *  - 若更高优先级正在播：本层不接管焦点（独立播放），返回空 release。
 *  - 否则暂停所有更低优先级并压入栈；返回 release，播完/关闭时调用以恢复。 */
export function acquireAudio(layer: AudioLayer, pause: () => void, resume: () => void): () => void {
    if (active && idx(active.layer) >= idx(layer)) {
        // 同或更高优先级在播：低优先级不抢占高优先级，也不接管 active（避免覆盖正在播的高优先级）
        return () => {};
    }
    if (active) {
        active.pause();
        suspended.push(active.resume);
    }
    active = { layer, pause, resume };
    return () => {
        if (active && active.layer === layer) {
            active = null;
            const top = suspended.pop();
            if (top) top(); // 恢复最近被本层/更高层暂停的音频
        }
    };
}
