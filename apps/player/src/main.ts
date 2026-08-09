// 入口：加载故事包 → 各子系统初始化 → 启动门
import "./styles.css";
import { loadStoryPack } from "./story";
import { setPack, pack } from "./pack";
import { initSettingsPanel, speechPref, showStatus } from "./settings";
import {
    initAudioAssets, initSpeech, speakStory, speechSupported, sceneAudioIdle, warmUpSynth
} from "./speech";
import { initAchievementData, initAchievements } from "./achievements";
import { renderScene, getCurrentText } from "./engine";

// 故事包路径（相对 player 根；public/stories 由 scripts/sync-content.mjs 从 content/ 同步）
const PACK_URL = "stories/ch01-wind/";

// 启动门：现代浏览器（Chrome/Safari 均）要求用户手势后才能 speechSynthesis，
// 刷新会重置激活状态。把第一次点击变成「开始」仪式：手势里解锁合成器，再进开场。
// 语音关闭/不支持时跳过门，直接开始。
function initStartGate(): void {
    if (!speechSupported || !speechPref.on) {
        renderScene(pack().startScene);
        return;
    }
    const gate = document.getElementById("start-gate")!;
    gate.hidden = false;
    let begun = false;
    const begin = () => {
        if (begun) return; begun = true; // 按钮点击会冒泡到 gate，防 begin 双触发
        warmUpSynth();
        gate.remove();
        renderScene(pack().startScene);
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

    initAudioAssets();       // 定位音频资产 + 拉取 manifest（异步，不阻塞启动）
    initSettingsPanel();
    initSpeech();
    initAchievementData();   // 成就表来自故事包
    initAchievements();
    initStartGate();

    // 首次交互补读：Safari 要求用户手势才能发声；Chrome 加载竞态漏读也能兜住。
    // 已在朗读/排队则不动（避免重复）
    document.addEventListener("pointerdown", function once() {
        document.removeEventListener("pointerdown", once);
        if (speechSupported && speechPref.on && getCurrentText() &&
            !speechSynthesis.speaking && !speechSynthesis.pending && sceneAudioIdle()) {
            speakStory(getCurrentText());
        }
    });
}

boot();
