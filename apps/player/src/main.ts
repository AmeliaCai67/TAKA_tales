// 入口：加载故事包 → 各子系统初始化 → 启动门
import "./styles.css";
import { loadStoryPack } from "./story";
import { setPack, pack } from "./pack";
import { initSettingsPanel, speechPref, showStatus } from "./settings";
import {
    initAudioAssets, initSpeech, speakStory, sceneAudioIdle
} from "./speech";
import { initAchievementData, initAchievements } from "./achievements";
import { initAuth } from "./auth";
import { renderScene, getCurrentText } from "./engine";

// 故事包路径（相对 player 根；public/stories 由 scripts/sync-content.mjs 从 content/ 同步）
const PACK_URL = "stories/ch01-wind/";

// 启动门：浏览器要求用户手势后才能播放音频（Audio 元素同样受自动播放策略约束）。
// 把第一次点击变成「开始」仪式：手势里直接开播开场场景。
// 语音关闭时跳过门，直接开始。
function initStartGate(): void {
    if (!speechPref.on) {
        renderScene(pack().startScene);
        return;
    }
    const gate = document.getElementById("start-gate")!;
    gate.hidden = false;
    let begun = false;
    const begin = () => {
        if (begun) return; begun = true; // 按钮点击会冒泡到 gate，防 begin 双触发
        gate.remove();
        renderScene(pack().startScene); // playSceneAudio 在点击处理器内同步触发 play()
    };
    document.getElementById("gate-btn")!.onclick = begin;
    gate.onclick = begin;
}

async function boot(): Promise<void> {
    try {
        setPack(await loadStoryPack(PACK_URL));
    } catch (e) {
        showStatus("故事包加载失败，请检查网络后刷新", 0);
        throw e;
    }
    document.title = "塔卡 (TAKA) - " + pack().title;

    // manifest 先就位（3s 超时容忍），保证启动门点击时 prologue 的 mp3 能同步起播
    await Promise.race([
        initAudioAssets(),
        new Promise(r => setTimeout(r, 3000))
    ]);
    initSettingsPanel();
    initSpeech();
    initAchievementData();   // 成就表来自故事包
    initAchievements();
    await initAuth();        // 静默恢复登录态；选中孩子则拉断点与成就
    initStartGate();

    // 首次交互补读：起播竞态漏读时兜住（播放链空闲才补，避免重复）
    document.addEventListener("pointerdown", function once() {
        document.removeEventListener("pointerdown", once);
        if (speechPref.on && getCurrentText() && sceneAudioIdle()) {
            speakStory(getCurrentText());
        }
    });
}

boot();
