// API 客户端：所有后端调用的唯一出口
// VITE_API_BASE 默认同源（nginx 反代 /api/），本地联调可指 http://localhost:8000
import { session } from "./session";

const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) || "";

export class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (session.token) headers["Authorization"] = "Bearer " + session.token;
    const res = await fetch(API_BASE + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
            const err = await res.json();
            if (err && err.detail) msg = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
        } catch {}
        throw new ApiError(res.status, msg);
    }
    return res.json() as Promise<T>;
}

export interface ChildInfo { id: number; nickname: string; age_band: string; prefs: Record<string, unknown>; }
export interface MeInfo { parent: { id: number; email: string }; children: ChildInfo[]; }
export interface ProgressInfo { found: boolean; scene_key?: string; battery?: number; path?: string[]; }

export const api = {
    sendCode: (email: string) =>
        req<{ ok: boolean; sent: boolean; dev_code?: string }>("/api/auth/send-code", { method: "POST", body: { email } }),
    verify: (email: string, code: string) =>
        req<{ token: string }>("/api/auth/verify", { method: "POST", body: { email, code } }),
    me: () => req<MeInfo>("/api/auth/me"),
    createChild: (nickname: string, age_band: string) =>
        req<ChildInfo>("/api/children", { method: "POST", body: { nickname, age_band } }),
    saveProgress: (childId: number, storyId: string, sceneKey: string, battery: number, path: string[]) =>
        req("/api/progress", { method: "PUT", body: { child_id: childId, story_id: storyId, scene_key: sceneKey, battery, path } }),
    loadProgress: (childId: number, storyId: string) =>
        req<ProgressInfo>(`/api/progress?child_id=${childId}&story_id=${encodeURIComponent(storyId)}`),
    startSession: (childId: number, storyId: string) =>
        req<{ session_id: number }>("/api/sessions/start", { method: "POST", body: { child_id: childId, story_id: storyId } }),
    finishSession: (sessionId: number, path: string[], ending: string) =>
        req(`/api/sessions/${sessionId}/finish`, { method: "POST", body: { path, ending } }),
    unlockAchievement: (childId: number, achievementId: string) =>
        req("/api/achievements/unlock", { method: "POST", body: { child_id: childId, achievement_id: achievementId } }),
    listAchievements: (childId: number) =>
        req<{ achievements: { id: string }[] }>(`/api/achievements?child_id=${childId}`),
    /** M4：选项 C 现场生成（服务端受控流水线；401 未登录 / 429 配额 / 503 生成失败） */
    generate: (childId: number, storyId: string, sceneKey: string, prevText: string, choiceText: string, currentSceneKey: string) =>
        req<{ type: "advance" | "stay" | "ignore"; text: string; retried: boolean }>("/api/generate", {
            method: "POST",
            body: { child_id: childId, story_id: storyId, scene_key: sceneKey, prev_text: prevText, choice_text: choiceText, current_scene_key: currentSceneKey }
        }),
    /** 游客匿名（2026-08-18）：注册设备 ID / 上报事件流，均无需登录（无 token 时才用） */
    anonRegister: () =>
        req<{ anon_id: string }>("/api/anon/register", { method: "POST", body: {} }),
    anonEvents: (anonId: string, events: { story_id?: string; type: string; scene_key?: string; payload?: Record<string, unknown> }[]) =>
        req("/api/anon/events", {
            method: "POST",
            body: { events },
            headers: { "X-Anon-ID": anonId },
        })
};
