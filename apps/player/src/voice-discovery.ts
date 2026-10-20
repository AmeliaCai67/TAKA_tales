// Scene-local voice discovery, daily hint and quiet-input fallback.
import { positionVoiceGuide } from './voice-guide';
import { reportEvent } from './events';
import { t, lang } from './i18n';
import { speechPref } from './settings';
import { queueClip } from './speech';
import { pack } from './pack';
import type { Scene } from './story';
interface DiscoveryContext {
    scene: Scene; box: HTMLElement; row: HTMLElement; hint: HTMLElement; fab: HTMLElement;
    bookMode: boolean; micAsHotspot: boolean; sceneKey: string;
}
export function mountVoiceDiscovery(ctx: DiscoveryContext): { dispose(): void; dismiss(silent?: boolean): void } {
    const { scene, box, row, hint, fab, bookMode, micAsHotspot, sceneKey: currentSceneKey } = ctx;
    const cleanupTasks: (() => void)[] = [];
    let dismissGuide: ((silent?: boolean) => void) | null = null;
    const solo = !(scene.choices && scene.choices.length); // 专属场景：话筒是唯一推进通路
    const guided = localStorage.getItem("taka_voice_guided") === "1";
    // 漏斗顶层：曝光（进 freeInput 场景且语音入口可见——FAB 或绘本 hotspot 任一）。
    // hotspot 模式 payload 带 hotspot:true，漏斗分母含绘本入口（FAB 隐藏不等于入口不存在）
    reportEvent({ type: "voice_fab_shown", scene_key: currentSceneKey,
                       payload: { solo, book: bookMode, guided, hotspot: micAsHotspot } });
    // 语音入口存在才做可发现性（VN=FAB / 绘本=左页 hotspot，两入口互斥只出现一个）。
    // ⚠ be738a0 曾把整段门在 !fab.hidden 上——绘本模式话筒走 hotspot、FAB 恒隐藏，主模式的每日引导自此永不出现（2026-10-03 修复）
    if (!fab.hidden || micAsHotspot) {
        if (!fab.hidden) fab.classList.add("awaiting"); // 待机微光：等待输入时常驻（FAB 专属；hotspot 自带 halo）
        const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD 本地日
        if (!guided && localStorage.getItem("taka_voice_guide_day") !== today) {
            localStorage.setItem("taka_voice_guide_day", today);
            reportEvent({ type: "voice_guide_shown", scene_key: currentSceneKey });
            fab.classList.add("guiding");
            const bubble = document.createElement("div");
            bubble.className = "mic-guide-bubble";
            const anim = document.createElement("div"); // 图标化：手指按住圆钮的循环动画（3-6 岁不识字也能懂）
            anim.className = "mgb-anim";
            anim.setAttribute("aria-hidden", "true");
            const main = document.createElement("div");
            main.textContent = t(solo ? "engine.voice_guide_solo" : "engine.voice_guide");
            const sub = document.createElement("div");
            sub.className = "mgb-sub";
            sub.textContent = t("engine.voice_guide_sub");
            bubble.append(anim, main, sub);
            document.body.appendChild(bubble);
            if (!bookMode && matchMedia('(pointer: coarse)').matches) {
                bubble.classList.add('guide-inline');
                box.appendChild(bubble);
            }
            // Measure after hotspot clamping; avoid all live choice hit areas on the art page.
            if (micAsHotspot) cleanupTasks.push(positionVoiceGuide(bubble));
            const dismiss = (silent?: boolean) => {
                if (!bubble.isConnected) return;
                bubble.classList.add("bye");
                setTimeout(() => bubble.remove(), 400);
                fab.classList.remove("guiding");
                if (!silent) reportEvent({ type: "voice_guide_dismissed", scene_key: currentSceneKey });
            };
            dismissGuide = dismiss;
            const t8 = setTimeout(() => dismiss(), 8000);
            const onDocDown = () => dismiss();
            const tArm = setTimeout(() => document.addEventListener("pointerdown", onDocDown, { once: true }), 300); // 延迟武装，防当前点击即触发
            cleanupTasks.push(() => { clearTimeout(t8); clearTimeout(tArm); document.removeEventListener("pointerdown", onDocDown); bubble.remove(); });
            // 塔卡声线引导音频（包内预渲染 onboarding/voice-guide.mp3）：接在故事/选项朗读链尾
            if (speechPref.on) {
                queueClip(pack().baseUrl + (lang === "en" ? "audio-en/" : "audio/") + "onboarding/voice-guide.mp3");
            }
        }
        if (!fab.hidden && solo) { // 兜底：专属场景 20s 无输入 → 自动展开打字行（VN 打字行默认收起才需要；绘本打字行常驻可见）
            const rescue = setTimeout(() => {
                row.hidden = false;
                hint.textContent = t("engine.voice_rescue");
                hint.hidden = false;
            }, 20000);
            cleanupTasks.push(() => clearTimeout(rescue));
        }
    }

    return {
        dispose() { cleanupTasks.forEach(fn => fn()); fab.classList.remove('awaiting', 'guiding'); },
        dismiss(silent) { dismissGuide?.(silent); },
    };
}
