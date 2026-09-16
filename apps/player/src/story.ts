// 故事包类型契约（与 packages/story-schema/schema.json 对应）+ 加载器

export interface Choice {
    text: string;
    next: string;
}

export interface CodexLink {
    word: string;   // 场景文本里高亮的关键词
    entry: string;  // → codex.entries[].id
}

export interface CodexEntry {
    id: string;
    name: string;
    image: string;          // 相对故事包根（卡片渲染时拼 baseUrl；index.json 里是完整路径）
    science: string[];      // 科学介绍（定稿，不走 LLM）
    takaSays: string[];     // 塔卡口吻（定稿）
    source: { title: string; author: string; license: string; url: string; url2?: string }; // 图片许可四元组；url2 = 合成图第二来源页
}

export interface Scene {
    mode?: "swim" | "land";
    text: string;
    background?: string; // 场景背景图（相对故事包根）；缺省保持上一场景
    book?: BookLayout;   // 横屏绘本模式构图（缺省：background 作左页 + 塔卡默认位 + 选项全退化气泡按钮）
    cost?: number;
    sun?: number;
    setBattery?: number;
    eyeState?: EyeState;
    endState?: EyeState;
    ai?: boolean;
    beats?: string[];
    freeInput?: boolean;
    freeInputNext?: string; // 自由输入（选项 C）生成后的跳转目标；优先于 choices[0].next / scene.next（第四章「自由输入统跳 E」）
    freeInputMaxLength?: number; // 该场景自由输入字数上限（默认 300；个别场景可收紧）
    isSpecialListen?: boolean;
    listenLabel?: string; // isSpecialListen 场景聆听条结束按钮文案（不含省略号，展示时引擎补）
    ending?: boolean; // 结局标记（不动电量版）：会话收尾 + 「回到书架」。setBattery 场景天然是结局
    voiceOverrides?: Record<string, string>; // 场景级声线覆盖：{角色名: 声线id}，只改朗读者不改显示文本
    next?: string;
    choices?: Choice[];
    codex?: CodexLink[]; // 记忆库：本场景可点的关键词（打字机播完后高亮）
    collect?: CollectLayout; // 收集小游戏节点（2026-09 第四章）
}

/* ===== 收集小游戏节点（2026-09 第四章「你好，757」） =====
   横屏/整页/塔卡可拖/物化物品可交互收集/集满 N 解锁成就。
   2026-09-07 海底农场闭环：收集 → 观察小剧本 → 控制台（信息/问一问/打标签）→ 录入记忆库。 */
export interface CollectItem {
    id: string;        // 收集物唯一 id（去重）
    actor: string;     // 物化件：pack.characters 注册的角色，或内置件（grass/cat/bee/butterfly）
    x: number;         // 左页内位置 %（左上原点）
    y: number;
    size?: number;     // 宽度占左页 %（缺省 16）
    label?: string;    // 收集提示文案（如「混着水稻的草坪」）
    observe?: { who: string; line: string }[];  // (a) 聊天卡小剧本（who=声线 id，逐条打字机）
    facts?: string[];                           // (b) 控制台信息卡（基础事实）
    tags?: { pool: string[]; correct: string[]; pick: number }; // (d) 标签池（correct 机制判定）
    meowSfx?: string;  // 活猫叫声音效（相对 audio[-en]/ 路径）
    meowLicense?: { title: string; author: string; license: string; url: string };
    codexId?: string;  // (e) 录入的记忆库词条 id
}
export interface CollectLayout {
    items: CollectItem[];   // 可交互收集物
    required: number;       // 集满多少触发成就/继续
    achievement?: string;   // 集满时解锁的成就 id（须在根 achievements 表）
    next: string;           // 集满后跳转目标场景
}

export type EyeState = "st-standby" | "st-thinking" | "st-pondering" | "st-listening" | "st-low" | "st-off";

/* ===== 横屏绘本模式（2026-08-31，plan: docs/superpowers/plans/2026-08-31-landscape-book-mode.md） ===== */
export interface BookHotspot {
    choice: number;      // 对齐 choices 下标
    actor: string;       // pack.characters 注册的角色，或内置件（light/coral/deep/shell）
    x: number;           // 左页内位置 %（左上原点）
    y: number;
    size?: number;       // 宽度占左页 %（缺省 14）
}

/* 场景常驻角色（2026-09-03 演出效果）：非交互，随场景渲染即在画面里；与 hotspot 的区别是不绑选项、不可点 */
export interface BookActor {
    actor: string;       // pack.characters 注册的角色，或内置件
    x: number;           // 左页内位置 %（左上原点）
    y: number;
    size?: number;       // 宽度占左页 %（缺省 20）
    flip?: boolean;      // 水平镜像（如让朝右的海鸥回头看我方）
    rotate?: number;     // 旋转角（度，如鲸鱼下沉俯角）
}

export interface BookLayout {
    art?: string;        // 左页画面（缺省 = scene.background）
    taka?: { x?: number; y?: number; size?: number; rotate?: number }; // 缺省 14/34/（ch02 29%）/0
    decor?: ("waves" | "sun" | "bubbles")[];
    actors?: BookActor[]; // 常驻角色（非交互）
    hotspots?: BookHotspot[];
}

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
    characters?: Record<string, string>; // 绘本模式角色 SVG 注册表：actor 名 → 相对故事包根路径
    startScene: string;    // 首次进入（通常是 prologue）
    restartScene: string;  // 「重新开始」目标；进入时电量回满
    depletedScene: string; // 非结局场景电量耗尽时的被动结局
    speakers: Record<string, string>; // 台词归属表：角色中文名 → 声线 id
    achievements: AchievementDef[];
    codex?: { entries: CodexEntry[] }; // 记忆库词条表（2026-08-25）
    scenes: Record<string, Scene>;
    baseUrl: string; // 故事包根路径（音频等资产相对它解析），加载时注入
    langs?: string[]; // 可用语言（由 sync-content 探测 story.<lang>.json 写入 index.json；包本体不带）
}

/** 加载故事包。baseUrl 必须以 / 结尾，如 "stories/ch01-wind/"
 *  lang=en 时优先 story.en.json（缺失回退中文包）；id 永远归一为目录名（语言无关，
 *  进度/成就/记忆库/书的存储键不含语言——2026-08-28 i18n spec §3） */
export async function loadStoryPack(baseUrl: string, lang = "zh"): Promise<StoryPack> {
    let pack: StoryPack | null = null;
    if (lang !== "zh") {
        const res = await fetch(`${baseUrl}story.${lang}.json?v=` + Date.now()).catch(() => null);
        if (res && res.ok) pack = (await res.json()) as StoryPack;
    }
    if (!pack) {
        const res = await fetch(baseUrl + "story.json?v=" + Date.now()); // 创作期防缓存
        if (!res.ok) throw new Error("story.json 加载失败: HTTP " + res.status);
        pack = (await res.json()) as StoryPack;
    }
    pack.baseUrl = baseUrl;
    pack.id = baseUrl.split("/").filter(Boolean).pop()!; // id 归一：译文包的 "-en" 后缀不进存储键
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
    codexEntries?: CodexEntry[]; // 记忆库面板用内联词条（image 已拼完整路径）
    langs?: string[]; // 可用语言（sync-content 探测 story.<lang>.json）
    alt?: Record<string, { title: string; summary: string;
        achievements?: { id: string; name: string; icon: string; desc: string }[];
        codexEntries?: CodexEntry[] }>; // 各语言的展示文案（书架/成就墙/记忆库切换用）
}

/** 书架索引：书架页列出全部故事 */
export async function loadStoriesIndex(): Promise<StoryMeta[]> {
    try {
        const res = await fetch("stories/index.json?v=" + Date.now());
        if (!res.ok) return [];
        return ((await res.json()).stories || []) as StoryMeta[];
    } catch { return []; }
}
