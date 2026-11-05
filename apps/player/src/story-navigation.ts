// Story selection, resume hydration and cross-chapter navigation.
import type { StoryMeta } from './story';
import { loadStoryPack } from './story';
import { pack, setPack } from './pack';
import { t, lang } from './i18n';
import { collectPackImages, preloadImages, idlePreload } from './preload';
import { showShelf, hideShelf } from './shelf';
import { applyLayout } from './layout';
import { renderScene, setResumePoint, type NextChapterAction } from './engine';
import { initAudioAssets } from './speech';
import { initAchievementData } from './achievements';
import { loadLocalProgress } from './progress';
import { session } from './session';
import { api } from './api';
import { showStatus } from './settings';
import { splashProgress, splashShow, splashHide } from './boot-splash';

export let bootStories: StoryMeta[] = [];
/** 书架/大门展示期间闲时预取其余故事的图片（低并发、不 pin；与 splash 预载共享去重集合） */
export function scheduleIdlePrefetch(): void {
    const others = bootStories.filter(s => s.id !== pack().id);
    let i = 0;
    const ric: (cb: () => void) => void = window.requestIdleCallback
        ? (cb) => window.requestIdleCallback(cb, { timeout: 5000 })
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
export async function loadPack(storyId: string) {
    return loadStoryPack("stories/" + storyId + "/", lang);
}

// 游客用本地断点种子（云端断点由 auth.selectChild 拉取）；无效/已读完则不给
function seedGuestResume(storyId: string): void {
    if (session.token && session.childId) return; // 登录态：云端为准
    const lp = loadLocalProgress(storyId);
    if(lp)lp.sceneKey=pack().sceneAliases?.[lp.sceneKey]??lp.sceneKey;
    // lastEnding 区分「玩完了归位」与「真断点」；restartScene 也可能是合法断点（刚点完开始故事）
    if (lp && !lp.lastEnding && lp.sceneKey !== pack().startScene && pack().scenes[lp.sceneKey]) {
        setResumePoint({ sceneKey: lp.sceneKey, battery: lp.battery, path: lp.path });
    } else setResumePoint(null);
}

/** 结局「下一章」取值（2026-10-07 章节衔接）：按 index.json 数组序求当前章的下一章（引擎不认识索引）。
 *  闭包读 bootStories/lang/pack()——中英切换与异包跳转在调用时天然求值，boot 只注入一次。 */
export function nextChapterAction(): NextChapterAction | null {
    const i = bootStories.findIndex(s => s.id === pack().id);
    const next = i >= 0 ? bootStories[i + 1] : undefined;
    if (!next) return null; // 末章 / 当前章不在索引 / 索引加载失败（bootStories 为 []）
    const title = lang === "en" ? (next.alt?.en?.title || next.title) : next.title;
    return { id: next.id, title, cover: next.cover, go: () => pickStory(next) };
}

// 书架点封面：同包直接开播（保持点击手势内的同步音频起播）；异包异步换装再开播
export function pickStory(s: StoryMeta): void {
    hideShelf();
    applyLayout();
    if (pack().id === s.id) {
        seedGuestResume(s.id);
        void renderScene(pack().startScene);
        return;
    }
    void (async () => {
        // 异包换装：闪屏切「故事加载」模式，pack + manifest + 该包图片齐活后才进第一个场景
        const title = lang === "en" ? (s.alt?.en?.title || s.title) : s.title;
        splashShow(t("boot.loading_story", { title }));
        try {
            splashProgress(5);
            setPack(await loadPack(s.id));
            document.title = t("misc.doc_title") + " - " + pack().title;
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
            void renderScene(pack().startScene);
        } catch {
            splashHide();
            showStatus(t("engine.story_not_ready"), 3000);
            showShelf();
        }
    })();
}

export function setBootStories(stories: StoryMeta[]): void { bootStories = stories; }
