// 故事包类型契约（与 packages/story-schema/schema.json 对应）+ 加载器

export interface Choice {
    text: string;
    next: string;
}

export interface Scene {
    mode?: "swim" | "land";
    text: string;
    cost?: number;
    sun?: number;
    setBattery?: number;
    eyeState?: EyeState;
    endState?: EyeState;
    ai?: boolean;
    beats?: string[];
    freeInput?: boolean;
    isSpecialListen?: boolean;
    listenLabel?: string; // isSpecialListen 场景聆听条结束按钮文案（不含省略号，展示时引擎补）
    next?: string;
    choices?: Choice[];
}

export type EyeState = "st-standby" | "st-thinking" | "st-listening" | "st-low" | "st-off";

export interface AchievementDef {
    id: string;
    name: string;
    icon: string;
    desc: string;
    unlockScene: string;
}

export interface StoryPack {
    id: string;
    title: string;
    version: number;
    startScene: string;    // 首次进入（通常是 prologue）
    restartScene: string;  // 「重新开始」目标；进入时电量回满
    depletedScene: string; // 非结局场景电量耗尽时的被动结局
    speakers: Record<string, string>; // 台词归属表：角色中文名 → 声线 id
    achievements: AchievementDef[];
    scenes: Record<string, Scene>;
    baseUrl: string; // 故事包根路径（音频等资产相对它解析），加载时注入
}

/** 加载故事包。baseUrl 必须以 / 结尾，如 "stories/ch01-wind/" */
export async function loadStoryPack(baseUrl: string): Promise<StoryPack> {
    const res = await fetch(baseUrl + "story.json?v=" + Date.now()); // 创作期防缓存
    if (!res.ok) throw new Error("story.json 加载失败: HTTP " + res.status);
    const pack = (await res.json()) as StoryPack;
    pack.baseUrl = baseUrl;
    return pack;
}
