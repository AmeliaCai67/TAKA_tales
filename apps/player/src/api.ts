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
    const doFetch = () => fetch(API_BASE + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: "no-store"
    });
    // XHR 回退（2026-09-01 Mate 60 Chrome/99 实测：探针页证明 XHR POST 在其浏览器上 100% 通）
    const doXhr = () => new Promise<T>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(opts.method || "GET", API_BASE + path);
        for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
        x.onload = () => {
            let data: any = {};
            try { data = JSON.parse(x.responseText || "{}"); } catch {}
            if (x.status >= 200 && x.status < 300) return resolve(data as T);
            let msg = "HTTP " + x.status;
            if (data && data.detail) msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
            reject(new ApiError(x.status, msg));
        };
        x.onerror = () => reject(new TypeError("xhr onerror (status=" + x.status + ")"));
        x.ontimeout = () => reject(new TypeError("xhr timeout"));
        x.timeout = 15000;
        x.send(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
    // 移动浏览器对复用的已死 keep-alive 连接不重试 POST（非幂等）→ TypeError「Failed to fetch」。
    // 阶梯：fetch → fetch 重试（新连接）→ XHR 回退；HTTP 错误不进入重试（2026-09-01 实机排查）
    let res: Response | undefined;
    let fetchErr: Error | null = null;
    try {
        res = await doFetch();
    } catch (e: any) {
        fetchErr = e;
        try {
            await new Promise(r => setTimeout(r, 400));
            res = await doFetch();
            fetchErr = null;
        } catch (e2: any) {
            fetchErr = e2;
        }
    }
    if (fetchErr) {
        try {
            return await doXhr();
        } catch (xe: any) {
            // 两种传输全挂：把两边的错误都带上去（排障需要）
            throw new TypeError(fetchErr.message + "；xhr: " + (xe && xe.message ? xe.message : xe));
        }
    }
    if (!res) throw fetchErr; // 理论不可达（fetchErr 非空已在上面 return/throw）
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
export interface BookInfo {
    id: number; story_id: string; title: string; edition: number; cover: string;
    ending: string | null; total_events: number; audio_status: string;
    finished_at: string | null; created_at: string;
}
export interface BookEvent { seq: number; scene_key: string; role: string; text: string; type: string; created_at: string; }
export interface BookDetail extends BookInfo { events: BookEvent[]; }

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
    /** 如我所书（2026-08-19）：增量上报逐句对话流 */
    postEvents: (sessionId: number, events: { scene_key: string; role: string; text: string; type: string }[]) =>
        req(`/api/sessions/${sessionId}/events`, { method: "POST", body: { events } }),
    listBooks: (childId: number) =>
        req<{ books: BookInfo[] }>(`/api/books?child_id=${childId}`),
    bookDetail: (bookId: number) =>
        req<BookDetail>(`/api/books/${bookId}`),
    bookAudioUrl: (bookId: number) => "/api/books/" + bookId + "/audio",
    exportBook: (bookId: number) =>
        req<{ audio_status: string }>(`/api/books/${bookId}/export`, { method: "POST" }),
    unlockAchievement: (childId: number, achievementId: string) =>
        req("/api/achievements/unlock", { method: "POST", body: { child_id: childId, achievement_id: achievementId } }),
    listAchievements: (childId: number) =>
        req<{ achievements: { id: string }[] }>(`/api/achievements?child_id=${childId}`),
    /** 记忆库（2026-08-25）：发现/解锁/查询词条 */
    codexDiscover: (childId: number, storyId: string, entryId: string) =>
        req("/api/codex/discover", { method: "POST", body: { child_id: childId, story_id: storyId, entry_id: entryId } }),
    codexUnlock: (childId: number, storyId: string, entryId: string, tags?: string[]) =>
        req<{ first: boolean }>("/api/codex/unlock", { method: "POST", body: { child_id: childId, story_id: storyId, entry_id: entryId, tags } }),
    /** 海底农场控制台 AI 问答（2026-09-07 spec M2）：家长 token 或游客 anonId 通道 */
    consoleQa: (childId: number | null, storyId: string, itemId: string, question: string, anonId: string | undefined, lang: string) =>
        req<{ type: "answer" | "canned" | "ignore"; text: string; retried?: boolean }>("/api/console-qa", {
            method: "POST",
            body: { child_id: childId, story_id: storyId, item_id: itemId, question, lang },
            headers: anonId ? { "X-Anon-ID": anonId } : undefined,
        }),
    codexList: (childId: number) =>
        req<{ entries: { story_id: string; entry_id: string; unlocked_at: string | null; tags?: string[] | null }[] }>(`/api/codex?child_id=${childId}`),
    /** M4：选项 C 现场生成（服务端受控流水线；401 未登录 / 429 配额 / 503 生成失败）
     *  2026-08-20：游客也可生成（childId=null + anonId 走匿名通道，展示 AI 能力） */
    generate: (childId: number | null, storyId: string, sceneKey: string, prevText: string, choiceText: string, currentSceneKey: string, anonId?: string, lang: string = "zh") =>
        req<{ type: "advance" | "stay" | "ignore"; text: string; retried: boolean }>("/api/generate", {
            method: "POST",
            body: { child_id: childId, story_id: storyId, scene_key: sceneKey, prev_text: prevText, choice_text: choiceText, current_scene_key: currentSceneKey, lang },
            headers: anonId ? { "X-Anon-ID": anonId } : undefined,
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
