// Backend contract and session-aware wrapper; transport is isolated in http.ts.
import { session } from './session';
import { requestJson, type RequestOptions } from './http';
export { ApiError } from './http';
export interface DialogueContext {
    otter_name?: string;
    position?: [number, number];
    history?: {child:string;daisy:string}[];
    record_declined?: boolean;
}
const API_BASE: string = import.meta.env.VITE_API_BASE || '';
function req<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return requestJson<T>(API_BASE + path, opts, session.token || '');
}

export interface ChildInfo { id: number; nickname: string; age_band: string; prefs: Record<string, unknown>; }
interface MeInfo { parent: { id: number; email: string }; children: ChildInfo[]; }
interface ProgressInfo { found: boolean; scene_key?: string; battery?: number; path?: string[]; }
export interface BookInfo {
    id: number; story_id: string; title: string; edition: number; cover: string;
    ending: string | null; total_events: number; audio_status: string;
    finished_at: string | null; created_at: string;
}
interface BookEvent { seq: number; scene_key: string; role: string; text: string; type: string; created_at: string; }
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
    bookAudioUrl: (bookId: number) => API_BASE + "/api/books/" + bookId + "/audio",
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
    generate: (childId: number | null, storyId: string, sceneKey: string, prevText: string, choiceText: string, currentSceneKey: string, anonId?: string, lang: string = "zh", dialogueContext?: DialogueContext) =>
        req<{ type: "advance" | "stay" | "ignore"; text: string; retried: boolean }>("/api/generate", {
            method: "POST",
            body: { child_id: childId, story_id: storyId, scene_key: sceneKey, prev_text: prevText, choice_text: choiceText, current_scene_key: currentSceneKey, lang, dialogue_context: dialogueContext },
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
        }),
    /** 语音漏斗统一事件（2026-09-28 voice-input-discoverability §3）：登录记 parent/child 维度（Bearer 由 req 自动带），
     *  游客走 X-Anon-ID 设备维度；两边都没有后端 401，调用方 catch 静默 */
    postEvents2: (events: { story_id: string; type: string; scene_key?: string; payload?: Record<string, unknown> }[],
                  childId?: number, anonId?: string) =>
        req("/api/events", {
            method: "POST",
            body: { events, child_id: childId },
            headers: anonId ? { "X-Anon-ID": anonId } : undefined,
        })
};
