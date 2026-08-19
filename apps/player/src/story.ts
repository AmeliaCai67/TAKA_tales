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
    freeInputMaxLength?: number; // 该场景自由输入字数上限（默认 300；个别场景可收紧）
    isSpecialListen?: boolean;
    listenLabel?: string; // isSpecialListen 场景聆听条结束按钮文案（不含省略号，展示时引擎补）
    ending?: boolean; // 结局标记（不动电量版）：会话收尾 + 「回到书架」。setBattery 场景天然是结局
    voiceOverrides?: Record<string, string>; // 场景级声线覆盖：{角色名: 声线id}，只改朗读者不改显示文本
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
    cover?: string;   // 书架封面（相对故事包根）
    summary?: string; // 书架一句话简介
    ttsAliases?: Record<string, string>; // 读音别名：显示文本不动，只改喂给 TTS 的文案（757 → 七五七）
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

/** 书架索引条目（apps/player/public/stories/index.json，由 sync-content.mjs 生成） */
export interface StoryMeta {
    id: string;
    title: string;
    summary: string;
    cover: string;    // 完整相对路径 stories/<id>/<cover>，无封面为空串
    achIds: string[]; // 本故事的成就 id 表（书架计数用）
    achievements?: { id: string; name: string; icon: string; desc: string }[]; // 成就墙用内联定义
}

/** 书架索引：书架页列出全部故事 */
export async function loadStoriesIndex(): Promise<StoryMeta[]> {
    try {
        const res = await fetch("stories/index.json?v=" + Date.now());
        if (!res.ok) return [];
        return ((await res.json()).stories || []) as StoryMeta[];
    } catch { return []; }
}
