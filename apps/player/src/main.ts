// 入口：i18n → 故事索引 → 首个故事包 → 各子系统初始化 → 启动门 → 书架
import "./styles.css";
import { initI18n, applyStatic, t, lang, setLang } from "./i18n";
import { loadStoryPack, loadStoriesIndex } from "./story";
import type { StoryMeta } from "./story";
import { setPack, pack } from "./pack";
import { initSettingsPanel, speechPref, showStatus, setExitToShelfHandler, loadLayoutPref, setLayoutChangeHandler, setLogoutHandler, setIsLoggedInFn } from "./settings";
import {
    initAudioAssets, initSpeech, speakStory, sceneAudioIdle
} from "./speech";
import { initAchievementData, initAchievements, migrateLegacyAchievements } from "./achievements";
import { initAuth, setAfterChildSelect, openParentModal, logoutEverywhere } from "./auth";
import { renderScene, getCurrentText, getCurrentSceneKey, setResumePoint, setShelfReturn, setNextChapter, exitToShelf, setBookMode, isBookMode, refreshCurrentScene } from "./engine";
import type { NextChapterAction } from "./engine";
import { initShelf, showShelf, hideShelf, shelfVisible } from "./shelf";
import { loadLocalProgress } from "./progress";
import { ensureAnonId } from "./anon";
import { initJourneyLog, initArchive } from "./archive";
import { initCodex, hydrateCodex } from "./codex";
import { api } from "./api";
import { session } from "./session";
import { collectPackImages, preloadImages, idlePreload } from "./preload";
import { ENGINE_PIECE_URLS } from "./scene-host";

// 内测远程诊断：?debug=1 动态加载 eruda 控制台（不进正式用户的关键路径，脚本加载失败静默）
if (new URLSearchParams(location.search).get("debug") === "1") {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/eruda@3";
    s.onload = () => (window as any).eruda?.init();
    document.head.appendChild(s);
}

/* ===== 启动闪屏（2026-09-28，spec: docs/superpowers/specs/2026-09-28-boot-preload-loading-ux.md）=====
   元素在 index.html 静态就位（内联 CSS，首帧即见）；显隐用 .bs-out 类而非 hidden 属性
   （本仓老坑：class 的 display 会盖掉 hidden 语义，.bs-out 用 opacity+visibility 双断）。 */
let bootStories: StoryMeta[] = []; // boot 时拉到的书架索引（boot 预载封面 + 闲时预取其余包用）

function splashProgress(pct: number): void {
    const fill = document.getElementById("bs-fill");
    const label = document.getElementById("bs-pct");
    if (fill) fill.style.width = pct + "%";
    if (label) label.textContent = pct > 0 && pct < 100 ? pct + "%" : "";
}
function splashShow(statusText: string): void {
    const el = document.getElementById("boot-splash");
    if (!el) return;
    el.classList.remove("bs-out");
    splashProgress(0);
    const st = document.getElementById("bs-status");
    if (st) st.textContent = statusText;
}
function splashHide(): void {
    document.getElementById("boot-splash")?.classList.add("bs-out");
}

/** 书架/大门展示期间闲时预取其余故事的图片（低并发、不 pin；与 splash 预载共享去重集合） */
function scheduleIdlePrefetch(): void {
    const others = bootStories.filter(s => s.id !== pack().id);
    let i = 0;
    const ric: (cb: () => void) => void = (window as any).requestIdleCallback
        ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 5000 })
        : (cb) => setTimeout(cb, 2000);
    const next = () => {
        const s = others[i++];
        if (!s) return;
        void loadPack(s.id)
            .then(p => idlePreload(collectPackImages(p)))
            .catch(() => { /* 闲时预取失败静默：进故事时 splash 路径会再拉 */ })
            .finally(() => ric(next));
    };
    ric(next);
}

/** 加载当前语言的包（en 优先 story.en.json，缺失回退中文） */
async function loadPack(storyId: string) {
    return loadStoryPack("stories/" + storyId + "/", lang);
}

/** 语言切换后重载当前包 + 原地重渲（spec §2：scene_key 语言无关，进度/成就零迁移） */
export async function switchLang(l: "zh" | "en"): Promise<void> {
    setLang(l);
    const currentId = pack().id;
    const sceneKey = getCurrentSceneKey(); // 当前场景键（切语言后原地重渲）
    try {
        setPack(await loadPack(currentId));
        // 音频 manifest 按语言分（audio/ vs audio-en/）；切语言后必须重载，
        // 否则 audioManifest 还是上一语言的（用旧 manifest 段名去新语言目录找文件会 404→被吞）
        await Promise.race([initAudioAssets(), new Promise(r => setTimeout(r, 3000))]);
        // 说话人标签从包里取（zh=塔卡 / en=TAKA）
        const sp = document.getElementById("speaker-label");
        if (sp) {
            const tk = Object.entries(pack().speakers).find(([, v]) => v === "taka");
            sp.textContent = tk ? tk[0] : t("misc.doc_title");
        }
        applyStatic(); // 静态 DOM 换文案
        document.title = t("misc.doc_title") + " - " + pack().title;
        if (shelfVisible()) {
            showShelf();
        } else if (sceneKey) {
            renderScene(sceneKey); // 故事页原地重渲当前场景
        }
    } catch { /* 网络异常时保持现状 */ }
}

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
    // 顶栏语言切换钮（顶栏右侧）
    document.getElementById("lang-toggle")?.addEventListener("click", () => {
        void switchLang(lang === "zh" ? "en" : "zh");
    });
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

// ===== 横屏绘本模式分派（2026-08-31）：宽度阈值制（折叠屏展开自动覆盖），设置三档可强制 =====
// 阈值 700 实测依据：iPhone 17 横屏 innerWidth=750（不是规格表的 874——Safari 会扣掉竖排时代理的宽度），
// 竖屏 402；iPad mini 竖屏 744；折叠屏展开 717+。700 把手机横屏/平板/折叠屏全部收进绘本，手机竖屏留 VN。
export const BOOK_MIN_WIDTH = 700;
const NO_HINT_KEY = "taka_no_rotate_hint";

function computeBookMode(): boolean {
    const pref = loadLayoutPref();
    if (pref === "book") return true;
    if (pref === "vn") return false;
    return window.innerWidth >= BOOK_MIN_WIDTH;
}

/** 窄屏进故事弹「横屏更佳」（不阻塞；勾选不再提示后永久免打扰） */
function maybeRotateHint(): void {
    if (window.innerWidth >= BOOK_MIN_WIDTH || localStorage.getItem(NO_HINT_KEY)) return;
    const el = document.getElementById("rotate-hint")!;
    el.hidden = false;
    document.getElementById("rh-ok")!.onclick = () => {
        if ((document.getElementById("rh-never") as HTMLInputElement).checked) {
            localStorage.setItem(NO_HINT_KEY, "1");
        }
        el.hidden = true;
    };
}

/** 进故事前判定模式；窄屏顺带提示。每次 pickStory 重判（折叠屏在书架页展开/收起后生效） */
function applyLayout(): void {
    setBookMode(computeBookMode());
    if (!isBookMode()) maybeRotateHint();
}

/** 结局「下一章」取值（2026-10-07 章节衔接）：按 index.json 数组序求当前章的下一章（引擎不认识索引）。
 *  闭包读 bootStories/lang/pack()——中英切换与异包跳转在调用时天然求值，boot 只注入一次。 */
function nextChapterAction(): NextChapterAction | null {
    const i = bootStories.findIndex(s => s.id === pack().id);
    const next = i >= 0 ? bootStories[i + 1] : undefined;
    if (!next) return null; // 末章 / 当前章不在索引 / 索引加载失败（bootStories 为 []）
    const title = lang === "en" ? (next.alt?.en?.title || next.title) : next.title;
    return { id: next.id, title, cover: next.cover, go: () => pickStory(next) };
}

// 书架点封面：同包直接开播（保持点击手势内的同步音频起播）；异包异步换装再开播
function pickStory(s: StoryMeta): void {
    hideShelf();
    applyLayout();
    if (pack().id === s.id) {
        seedGuestResume(s.id);
        renderScene(pack().startScene);
        return;
    }
    void (async () => {
        // 异包换装：闪屏切「故事加载」模式，pack + manifest + 该包图片齐活后才进第一个场景
        const title = lang === "en" ? (s.alt?.en?.title || s.title) : s.title;
        splashShow(t("boot.loading_story", { title }));
        try {
            splashProgress(5);
            setPack(await loadPack(s.id));
            splashProgress(15);
            await Promise.race([initAudioAssets(), new Promise(r => setTimeout(r, 3000))]);
            splashProgress(25);
            await preloadImages(collectPackImages(pack()), (done, total) => {
                if (total > 0) splashProgress(25 + Math.round((done / total) * 70));
            });
            splashProgress(96);
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
            splashProgress(100);
            splashHide();
            renderScene(pack().startScene);
        } catch {
            splashHide();
            showStatus(t("engine.story_not_ready"), 3000);
            showShelf();
        }
    })();
}

async function boot(): Promise<void> {
    splashProgress(5);
    await initI18n();          // i18n 最先：后续所有 UI 文案都要 t()
    applyStatic();             // index.html 静态文案
    splashProgress(10);
    let first: StoryMeta | undefined;
    try {
        const stories = await loadStoriesIndex();
        bootStories = stories;
        splashProgress(15);
        first = stories[0];
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
    initArchive();           // 如我所书：我的书架浮层（关闭按钮）
    initCodex();             // 记忆库：关键词点击委托
    await initAuth();        // 静默恢复登录态；选中孩子则拉断点与成就
    splashProgress(95);
    void hydrateCodex();     // 记忆库：登录拉后端 / 游客拉本地
    if (!session.token) void ensureAnonId(); // 游客预注册匿名设备 ID（静默失败，本地照玩）

    initShelf(pickStory);
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
    setAfterChildSelect(() => { void hydrateCodex(); if (shelfVisible()) showShelf(); });
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

boot();
