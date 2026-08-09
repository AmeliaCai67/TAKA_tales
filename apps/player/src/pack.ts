// 当前加载的故事包（引擎级单例，替代 demo 里硬编码的全局 storyData）
import type { StoryPack } from "./story";

let current: StoryPack | null = null;

export function setPack(p: StoryPack): void {
    current = p;
}

export function pack(): StoryPack {
    if (!current) throw new Error("故事包尚未加载");
    return current;
}
