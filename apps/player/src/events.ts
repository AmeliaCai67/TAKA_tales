// 语音输入漏斗统一事件上报（2026-09-28，spec: docs/superpowers/specs/2026-09-28-voice-input-discoverability.md §3）
// 与 reportAnonEvent（仅游客）的区别：登录用户也上报——Bearer 记 parent/child 维度，
// 游客走 X-Anon-ID 设备维度，同一端点 POST /api/events。失败一律静默，不影响功能。
// 漏斗主链：voice_fab_shown（曝光）→ voice_fab_tap（尝试·轻）→ voice_record_start（尝试）→ voice_submit（转化）；
// 对照/修正：text_submit（打字）/ voice_mark_broken（设备降级，应从分母剔除）。
import { api } from "./api";
import { session } from "./session";
import { ensureAnonId } from "./anon";
import { pack } from "./pack";

export interface VoiceEventInput {
    type: string;
    scene_key?: string;
    payload?: Record<string, unknown>;
}

/** 统一事件上报（语音漏斗 voice_* / 收集玩法 collect_* 等全走这里） */
export function reportEvent(evt: VoiceEventInput): void {
    const body = {
        story_id: pack().id,
        type: evt.type,
        scene_key: evt.scene_key ?? "",
        payload: evt.payload ?? {},
    };
    if (session.token) {
        api.postEvents2([body], session.childId ?? undefined).catch(() => {});
    } else {
        void ensureAnonId().then(id => {
            if (id) api.postEvents2([body], undefined, id).catch(() => {});
        });
    }
}

/** @deprecated 旧名保留（语音漏斗埋点）；新代码用 reportEvent */
export const reportVoiceEvent = reportEvent;
