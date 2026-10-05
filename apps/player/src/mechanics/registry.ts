// 玩法组件注册表（2026-10-03 mechanic 组件化，plan: docs/superpowers/plans/2026-10-03-mechanic-component-architecture.md）
// 新玩法接入 = mechanics/<type>.ts 实现组件 + 在此加 import + registerMechanic 两行。
// 刻意用「显式注册」而非组件侧 import 回注册表自注册：后者会让 registry → collect → registry 成环，
// collect 的模块尾在 REGISTRY 初始化前就执行 registerMechanic → TDZ 崩溃（2026-10-03 实 crash：pn before initialization）。
import { mountCollect } from "./collect";
import type { MechanicComponent } from "./types";

const REGISTRY = new Map<string, MechanicComponent>();

/** 注册玩法组件（type = story.json 包级 mechanics 声明的 type 字段） */
export function registerMechanic(type: string, comp: MechanicComponent): void {
    if (REGISTRY.has(type)) console.warn("[mechanics] 玩法类型重复注册:", type);
    REGISTRY.set(type, comp);
}

/** 查玩法组件；未注册返回 undefined（渲染侧 fail-soft 退化为普通书页） */
export function getMechanic(type: string): MechanicComponent | undefined {
    return REGISTRY.get(type);
}

registerMechanic("collect", mountCollect);
