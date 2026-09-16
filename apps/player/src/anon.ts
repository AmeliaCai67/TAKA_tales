// 游客匿名记录（可选遥测，2026-08-18）
// - 仅游客（未登录）模式向后端 /api/anon/* 上报游玩进度/成就/会话事件
// - 纯静态部署（GitHub Pages / 无后端）时请求 404，被 catch 静默吞掉，**完全不影响功能**
// - 无第三方追踪：后端由部署者自己提供，数据归部署者所有；不需要就忽略本模块
// - 隐私：anon_id 是随机 UUID 匿名标识，不含个人可识别信息；后端 IP/UA 不对外展示
// - 登录后不再上报（登录用户走正式表 child_id 维度；游客记录是「无账号」的补充观察）
import { api } from "./api";
import { session } from "./session";

const ANON_KEY = "taka_anon_id";

export interface AnonEventInput {
    story_id: string;
    type: string;        // session_start / session_end / progress / achievement / choice
    scene_key?: string;
    payload?: Record<string, unknown>;
}

let anonId: string | null = localStorage.getItem(ANON_KEY);
let registered = !!anonId;

/** 同步取当前 anon_id（可能为 null；console-qa 等需要裸 id 的调用方用） */
export function currentAnonId(): string | null { return anonId; }

/** 游客预注册设备 ID（幂等）：离线/后端未起时静默失败，本机照玩 */
export async function ensureAnonId(): Promise<string | null> {
    if (registered && anonId) return anonId;
    try {
        const r = await api.anonRegister();
        anonId = r.anon_id;
        localStorage.setItem(ANON_KEY, anonId!);
        registered = true;
    } catch { /* 匿名记录降级为纯本地 */ }
    return anonId;
}

/** 游客事件上报：登录用户不记；未注册成功（无 anon_id）时丢弃 */
export function reportAnonEvent(evt: AnonEventInput): void {
    if (session.token || !anonId) return;
    api.anonEvents(anonId, [evt]).catch(() => {});
}
