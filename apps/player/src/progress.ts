// 本地进度（书架角标 + 游客续玩）：按「故事 × 孩子」隔离
// 登录用户的真源仍在云端（M3），本模块是本地镜像——离线/游客也能有角标和断点
import { session } from "./session";

export interface LocalProgress {
    sceneKey: string;
    battery: number;
    path: string[];
    lastEnding?: string; // 已完成结局；有值表示「已读完」
}

function key(storyId: string): string {
    return "taka_prog_" + storyId + "_" + (session.childId ?? "guest");
}

export function loadLocalProgress(storyId: string): LocalProgress | null {
    try {
        const p = JSON.parse(localStorage.getItem(key(storyId)) || "null");
        return p && p.sceneKey ? p as LocalProgress : null;
    } catch { return null; }
}

export function saveLocalProgress(storyId: string, p: LocalProgress): void {
    try { localStorage.setItem(key(storyId), JSON.stringify(p)); } catch {}
}
