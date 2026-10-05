// 玩法组件契约（2026-10-03 mechanic 组件化，plan: docs/superpowers/plans/2026-10-03-mechanic-component-architecture.md）
// 目标：每章独特玩法 = story.json 声明（包级 mechanics 表 + 场景 mechanic 引用）+ 本目录一个组件，
//       引擎按声明 type 经 registry 分发——玩法成为 content 的一部分，不与叙事引擎耦合。
// 新玩法接入三步：①mechanics/<type>.ts 实现组件并 registerMechanic；②story.json 顶层 mechanics 加声明 + 场景加 mechanic 引用；
// ③validate_story.py 的 KNOWN_MECHANIC_TYPES 加类型名 + 结构检查分支。

import type { Scene } from "../story";

/* ===== 包级玩法声明（story.json 顶层 mechanics 表的值，2026-10-03 Phase 2） =====
   type = 组件注册名（mechanics/registry.ts）；其余字段归各类型组件所有，schema.json/validate_story.py 分类型把关。 */
export interface CollectDecl {
    type: "collect";
    items: CollectItem[];   // 可交互收集物
    required: number;       // 集满多少触发成就/继续
    achievement?: string;   // 录满时解锁的成就 id（须在根 achievements 表）
    next: string;           // 集满后跳转目标场景
    /* ---- collect 组件私有参数（缺省值见 collect.ts；ch04 双包显式声明全量） ---- */
    takaSkin?: string;      // 塔卡换装件（loadActor 两级解析：包 characters 注册 > 引擎内置件；缺省不换装）
    bounds?: { cx: number; cy: number; rx: number; ry: number }; // 禁入区椭圆（拱门/玻璃罩同源）
    bypass?: [number, number][]; // 长途游动绕行点（路径不穿禁入区）
    glass?: boolean;        // 禁入区玻璃罩光学处理
}
export type MechanicDecl = CollectDecl | { type: string };

/* ===== 收集物数据（2026-09 第四章「你好，757」） =====
   2026-09-07 海底农场闭环：收集 → 观察小剧本 → 控制台（信息/问一问/打标签）→ 录入记忆库。 */
export interface CollectItem {
    id: string;        // 收集物唯一 id（去重）
    actor: string;     // 物化件：pack.characters 注册的角色，或引擎内置件（apps/player/public/characters/）
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

/* ===== 玩法组件契约 ===== */
export interface MechanicHandle { cleanup(): void; }
export interface MechanicCtx {
    sceneKey: string;
    scene: Scene;           // 宿主场景（背景/book 构图已由宿主铺在 host 上）
    decl: MechanicDecl;     // 包级玩法声明（scene.mechanic 引用的那条）
    host: HTMLElement;      // 左页 .page-scene 画布（背景/decor/常驻角色就绪，塔卡未放入——挂载与定位归组件）
    spread: HTMLElement;    // 整页 spread（布局类/全屏层挂载点；翻页由宿主执行）
    nav(next: string, choiceText: string): void;  // 推进剧情（engine 的 navChoice）
    unlockAchievement(id: string): void;          // 解锁成就 + toast（engine 实现）
    onDone(): void;         // 场景文本阶段收尾（collect 无打字机，mount 尾部即调）
}
export type MechanicComponent = (ctx: MechanicCtx) => MechanicHandle;
