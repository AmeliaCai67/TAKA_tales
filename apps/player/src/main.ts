import { bootStories, setBootStories, loadPack, scheduleIdlePrefetch, pickStory, nextChapterAction } from "./story-navigation";
import { computeBookMode } from "./layout";
import { switchLang, setLanguageRefreshHandler } from "./language-switch";
import { splashProgress, splashHide } from "./boot-splash";
// 入口：i18n → 故事索引 → 首个故事包 → 各子系统初始化 → 启动门 → 书架
import "./styles.css";
import { initSoundEffects } from "./sfx";
import { narrationHasFocus } from "./audioPriority";
import { initShell } from "./shell";
import "./reader-stage.css";
import "./portrait-reader.css";
import "./collections.css";
import "./pickers.css";
import { initTheme } from "./theme";
initTheme();
import { initI18n, applyStatic, t, lang } from "./i18n";
import { loadStoriesIndex } from "./story";
import type { StoryMeta } from "./story";
import { setPack, pack } from "./pack";
import { initSettingsPanel, speechPref, showStatus, setExitToShelfHandler, setLayoutChangeHandler, setLogoutHandler, setIsLoggedInFn, setDrawerCollections } from "./settings";
import {
    initAudioAssets, initSpeech, speakStory, sceneAudioIdle, unlockStoryAudio
} from "./speech";
import { initAchievementData, initAchievements, migrateLegacyAchievements } from "./achievements";
import { initAuth, setAfterChildSelect, logoutEverywhere } from "./auth";
import {  getCurrentText, getCurrentSceneKey, setShelfReturn, setNextChapter, exitToShelf, setBookMode, isBookMode, refreshCurrentScene } from "./engine";
import { initShelf, showShelf, shelfVisible } from "./shelf";
import { lastStoryId } from "./progress";
import { ensureAnonId } from "./anon";
import { initJourneyLog, initArchive, openArchive } from "./archive";
import { initCodex, hydrateCodex, openCodexPanel } from "./codex";
import { session } from "./session";
import { collectPackImages, preloadImages } from "./preload";
import { clearBadge } from "./badge";
import { ENGINE_PIECE_URLS } from "./scene-host";

// 内测远程诊断：?debug=1 动态加载 eruda 控制台（不进正式用户的关键路径，脚本加载失败静默）
if (new URLSearchParams(location.search).get("debug") === "1") {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/eruda@3";
    s.onload = () => window.eruda?.init();
    document.head.appendChild(s);
}

// 启动门：浏览器要求用户手势后才能播放音频（Audio 元素同样受自动播放策略约束）。
// 唤醒动画结束后进入书架，由读者选择故事；已有断点仍在选书后恢复。
function initStartGate(): void {
    initShell(() => showShelf(bootStories), unlockStoryAudio);
    document.getElementById("lang-toggle")?.addEventListener("click", () => {
        void switchLang(lang === "zh" ? "en" : "zh");
    });
}

async function boot(): Promise<void> {
    splashProgress(5);
    await initI18n();          // i18n 最先：后续所有 UI 文案都要 t()
    applyStatic();             // index.html 静态文案
    splashProgress(10);
    let first: StoryMeta | undefined;
    try {
        const stories = await loadStoriesIndex();
        setBootStories(stories);
        splashProgress(15);
        const last = lastStoryId(stories.map(s => s.id));
        first = stories.find(s => s.id === last) || stories[0];
        setPack(await loadPack(first ? first.id : "ch01-wind"));
        splashProgress(20);
    } catch (e) {
        splashHide();
        showStatus(t("engine.pack_load_fail"), 0);
        throw e;
    }
    document.title = t("misc.doc_title") + " - " + pack().title;
    // 说话人标签：从包取（zh=塔卡 / en=TAKA）
    const spLabel = document.getElementById("speaker-label");
    if (spLabel) {
        const tk = Object.entries(pack().speakers).find(([, v]) => v === "taka");
        spLabel.textContent = tk ? tk[0] : t("misc.doc_title");
    }

    // manifest 先就位（3s 超时容忍），保证点封面时 prologue 的 mp3 能同步起播
    await Promise.race([
        initAudioAssets(),
        new Promise(r => setTimeout(r, 3000))
    ]);
    splashProgress(25);
    // 图片预载（25%→90%）：全部封面 + 首包全部图。失败/超时在 preload 内部兜底，不阻塞
    const covers = bootStories.map(s => s.cover).filter(Boolean);
    await preloadImages([...ENGINE_PIECE_URLS, ...covers, ...collectPackImages(pack())], (done, total) => {
        if (total > 0) splashProgress(25 + Math.round((done / total) * 65));
    });
    splashProgress(90);
    initSettingsPanel();
    initSpeech();
    initAchievementData();   // 成就表来自故事包
    initAchievements();
    migrateLegacyAchievements(); // 旧版全局成就池 → 游客池一次性迁移（未登录才迁；已登录由服务端拉回）
    initJourneyLog();        // 如我所书：旅程日志抽屉（故事页 📖）
    setDrawerCollections(() => { clearBadge("books"); void openArchive(); }, () => { clearBadge("codex"); void openCodexPanel(); });
    initArchive();           // 如我所书：我的书架浮层（关闭按钮）
    initCodex();             // 记忆库：关键词点击委托
    await initAuth();        // 静默恢复登录态；选中孩子则拉断点与成就
    splashProgress(95);
    await hydrateCodex();    // 恢复态必须先就绪；否则快速续玩收集页会把已录入物品显示成未收集。
    if (!session.token) void ensureAnonId(); // 游客预注册匿名设备 ID（静默失败，本地照玩）

    initShelf(pickStory);
    setLanguageRefreshHandler(() => {
        if (shelfVisible()) void showShelf();
        else if (getCurrentSceneKey()) refreshCurrentScene();
    });
    setShelfReturn(showShelf); // 结局场景「回到书架」
    setNextChapter(nextChapterAction); // 结局场景「下一章」主行动（2026-10-07 章节衔接）
    setExitToShelfHandler(exitToShelf); // 设置面板「保存并返回书架」
    setLogoutHandler(logoutEverywhere); // 设置面板「退出登录」（2026-09-02）
    setIsLoggedInFn(() => !!session.token);
    // 布局档切换：重判模式；故事进行中原地重渲当前场景（不重复结算电量）
    setLayoutChangeHandler(() => {
        const bm = computeBookMode();
        if (bm === isBookMode()) return;
        setBookMode(bm);
        if (!shelfVisible() && getCurrentSceneKey()) refreshCurrentScene();
    });

    // 玩途中旋转/折叠屏展开：跨阈值即切换（宽度判定——iOS 工具栏收起只变高不变宽，不会误触）
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("resize", () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const bm = computeBookMode();
            if (bm === isBookMode()) return;
            setBookMode(bm);
            if (!shelfVisible() && getCurrentSceneKey()) refreshCurrentScene();
        }, 250);
    });
    // 书架上的孩子切换即时反映；记忆库状态同步水合（孩子 × 词条隔离）
    setAfterChildSelect(async () => { await hydrateCodex(); if (shelfVisible()) await showShelf(); });
    initStartGate();
    splashProgress(100);
    splashHide();
    scheduleIdlePrefetch(); // 大门/书架展示期间闲时预取其余故事图片

    // 首次交互补读：起播竞态漏读时兜住（播放链空闲才补，避免重复）
    document.addEventListener("pointerdown", function once() {
        document.removeEventListener("pointerdown", once);
        if (speechPref.on && getCurrentText() && sceneAudioIdle()) {
            speakStory(getCurrentText());
        }
    });
}

initSoundEffects({ volume: () => speechPref.volume, narrating: () => !sceneAudioIdle() || narrationHasFocus() });
boot();
