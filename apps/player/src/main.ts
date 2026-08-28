// 入口：故事索引 → 首个故事包 → 各子系统初始化 → 启动门 → 书架
import "./styles.css";
import { loadStoryPack, loadStoriesIndex } from "./story";
import type { StoryMeta } from "./story";
import { setPack, pack } from "./pack";
import { initSettingsPanel, speechPref, showStatus, setExitToShelfHandler } from "./settings";
import {
    initAudioAssets, initSpeech, speakStory, sceneAudioIdle
} from "./speech";
import { initAchievementData, initAchievements } from "./achievements";
import { initAuth, setAfterChildSelect, openParentModal } from "./auth";
import { renderScene, getCurrentText, setResumePoint, setShelfReturn, exitToShelf } from "./engine";
import { initShelf, showShelf, hideShelf, shelfVisible } from "./shelf";
import { loadLocalProgress } from "./progress";
import { ensureAnonId } from "./anon";
import { initJourneyLog, initArchive } from "./archive";
import { initCodex, hydrateCodex } from "./codex";
import { api } from "./api";
import { session } from "./session";

// 启动门：浏览器要求用户手势后才能播放音频（Audio 元素同样受自动播放策略约束）。
// 把第一次点击变成「开始」仪式；门后是书架，书架点封面进故事。
// 语音关闭时跳过门，直接到书架。
function initStartGate(): void {
    if (!speechPref.on) {
        showShelf();
        return;
    }
    const gate = document.getElementById("start-gate")!;
    gate.hidden = false;
    let begun = false;
    const begin = () => {
        if (begun) return;
        // 未登录且没选过游客模式：先弹登录框（可游客进入/关闭），不再直接放行
        if (!session.token && !localStorage.getItem("taka_guest")) {
            void openParentModal();
            return;
        }
        begun = true; // 按钮点击会冒泡到 gate，防 begin 双触发
        gate.remove();
        showShelf();
    };
    document.getElementById("gate-btn")!.onclick = begin;
    gate.onclick = begin;
}

// 游客用本地断点种子（云端断点由 auth.selectChild 拉取）；无效/已读完则不给
function seedGuestResume(storyId: string): void {
    if (session.token && session.childId) return; // 登录态：云端为准
    const lp = loadLocalProgress(storyId);
    // lastEnding 区分「玩完了归位」与「真断点」；restartScene 也可能是合法断点（刚点完开始故事）
    if (lp && !lp.lastEnding && lp.sceneKey !== pack().startScene && pack().scenes[lp.sceneKey]) {
        setResumePoint({ sceneKey: lp.sceneKey, battery: lp.battery, path: lp.path });
    }
}

// 书架点封面：同包直接开播（保持点击手势内的同步音频起播）；异包异步换装再开播
function pickStory(s: StoryMeta): void {
    hideShelf();
    if (pack().id === s.id) {
        seedGuestResume(s.id);
        renderScene(pack().startScene);
        return;
    }
    void (async () => {
        try {
            setPack(await loadStoryPack("stories/" + s.id + "/"));
            await Promise.race([initAudioAssets(), new Promise(r => setTimeout(r, 3000))]);
            initAchievementData();
            if (session.token && session.childId) { // 异包的云端断点
                try {
                    const p = await api.loadProgress(session.childId, s.id);
                    if (p.found && p.scene_key && p.scene_key !== pack().restartScene) {
                        setResumePoint({ sceneKey: p.scene_key, battery: p.battery ?? 100, path: p.path ?? [] });
                    } else setResumePoint(null);
                } catch { setResumePoint(null); }
            } else {
                seedGuestResume(s.id);
            }
            renderScene(pack().startScene);
        } catch {
            showStatus("这个故事还没准备好，再试一次", 3000);
            showShelf();
        }
    })();
}

async function boot(): Promise<void> {
    let first: StoryMeta | undefined;
    try {
        const stories = await loadStoriesIndex();
        first = stories[0];
        setPack(await loadStoryPack("stories/" + (first ? first.id : "ch01-wind") + "/"));
    } catch (e) {
        showStatus("故事包加载失败，请检查网络后刷新", 0);
        throw e;
    }
    document.title = "塔卡 (TAKA) - " + pack().title;

    // manifest 先就位（3s 超时容忍），保证点封面时 prologue 的 mp3 能同步起播
    await Promise.race([
        initAudioAssets(),
        new Promise(r => setTimeout(r, 3000))
    ]);
    initSettingsPanel();
    initSpeech();
    initAchievementData();   // 成就表来自故事包
    initAchievements();
    initJourneyLog();        // 如我所书：旅程日志抽屉（故事页 📖）
    initArchive();           // 如我所书：我的书架浮层（关闭按钮）
    initCodex();             // 记忆库：关键词点击委托
    await initAuth();        // 静默恢复登录态；选中孩子则拉断点与成就
    void hydrateCodex();     // 记忆库：登录拉后端 / 游客拉本地
    if (!session.token) void ensureAnonId(); // 游客预注册匿名设备 ID（静默失败，本地照玩）

    initShelf(pickStory);
    setShelfReturn(showShelf); // 结局场景「回到书架」
    setExitToShelfHandler(exitToShelf); // 设置面板「保存并返回书架」
    // 书架上的孩子切换即时反映；记忆库状态同步水合（孩子 × 词条隔离）
    setAfterChildSelect(() => { void hydrateCodex(); if (shelfVisible()) showShelf(); });
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
