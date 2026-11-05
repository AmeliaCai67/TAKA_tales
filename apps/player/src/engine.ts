import {mountSceneSounds} from './mechanics/scene-sounds';
import {resolveStoryText,storyVariables,clearStoryState} from './story-state';
import { reportEvent } from "./events";
import { mountFreeInput, cleanupFreeInput, voiceCapable, toggleVoiceInput } from "./free-input";
import type { GenCtx } from "./engine-types";
import { setFigureState, setFigureMode, setBackground, typeText, stopTyping } from "./scene-presentation";
// 播放引擎：场景渲染 / 打字机 / 选项 / 自由输入 / 电量状态机 / 聆听条
// 与内容完全解耦——所有故事数据来自 pack()（story.json），本模块只负责“怎么播”
import { pack } from "./pack";
import { uiIcon } from "./ui-icons";
import type { Scene } from "./story";
import { loadSettings, showStatus } from "./settings";
import { unlockForScene, showToast, unlock } from "./achievements";
import {
    speakStory, speakChoices, stopSpeech, startWind, stopWind, playSceneAudio, parseTextSegs,
    prefetchSceneAudio, playSpeechCues
} from "./speech";
import { api, ApiError } from "./api";
import { session, selectedChild, clearSession } from "./session";
import { saveLocalProgress } from "./progress";
import { reportAnonEvent } from "./anon";
import { discoverScene, wrapCodexLinks, resetCodexHighlights } from "./codex";
import { setBadge } from "./badge";
import { t } from "./i18n";
import { bookChoicesEl, renderVNTouches, renderHotspots, renderSceneBook, renderSceneMechanic, cleanupMechanic, initMechanicAchievement, parkChromeVN, initBookNav, initBookVoice, resetBook } from "./book";

// ===== 电量状态机：全局真电量，场景只声明 cost（消耗量） =====
// 场景字段（story.json）：
//   cost       进入本场景耗的电（缺省 10）
//   sun        太阳事件回电（先扣后回，且救不了已经耗尽的电量）
//   setBattery 结局场景强制值（ending_a 充满 / ending_b 关机归零）
let battery = 100; // 单个故事的局部状态；进 restartScene 时回满

// 档位：耗尽(0) / 低(1-29) / 中(30-70 含) / 高(71-100)
type Tier = "depleted" | "low" | "mid" | "high";
const tierOf = (b: number): Tier => b <= 0 ? "depleted" : b < 30 ? "low" : b <= 70 ? "mid" : "high";

// 电量弧颜色（2026-09 产品规定）：≥50% 绿（充足）、10-49% 黄（注意）、<10% 红（危险）
function energyColor(b: number): string {
    if (b >= 50) return "#48bb78";  // 绿
    if (b >= 10) return "#f0c33c";  // 黄
    return "#e2503a";               // 红
}
const CORE_C = 2 * Math.PI * 12.5; // 电量弧周长（与 HUD SVG 的 r=12.5 一致，≈78.54）

function updateBatteryHUD(): void {
    document.getElementById("battery-text")!.innerText = battery + "%";
    const drawerEnergy = document.getElementById("sp-energy-value");
    if (drawerEnergy) { drawerEnergy.textContent = battery + "%"; drawerEnergy.style.color = energyColor(battery); }
    const pct = Math.max(0, Math.min(100, battery));
    // 空心圈：电量弧按电量百分比区间变色（绿/黄/红）
    const ico = document.getElementById("core-ico")!;
    ico.style.setProperty("--core", energyColor(battery));
    const arc = document.getElementById("core-arc")!;
    arc.style.strokeDasharray = `${(pct / 100) * CORE_C} ${CORE_C}`;
}

// 场景实际灯光 = 声明的 eyeState 经电量档位修正：
// 耗尽强制关灯；低电量把「待机」压成挣扎闪（场景显式指定的特殊状态不动）
function eyeOf(scene: Scene): string {
    const tier = tierOf(battery);
    return tier === "depleted" ? "st-off"
         : (tier === "low" && scene.eyeState === "st-standby") ? "st-low"
         : (scene.eyeState || "st-standby");
}

let currentText = ""; // 当前场景实际展示的文本，作为下一场景的「前情」
let currentSceneKey = ""; // 当前场景 key（「保存并返回」冲刷云保存用）
let sceneGeneration = 0;
let choiceTimer: ReturnType<typeof setTimeout> | null = null;
function cancelScenePresentation(): void {
    sceneGeneration++;
    if (choiceTimer) clearTimeout(choiceTimer);
    choiceTimer = null;
    stopTyping();
}
let listenTimer: ReturnType<typeof setInterval> | null = null; // 聆听条 timer

// ===== 横屏绘本模式（2026-08-31）：呈现层分派开关，由 main.ts 按宽度阈值/设置档切换 =====
let sceneSounds:ReturnType<typeof mountSceneSounds>|null=null;
let bookMode = false;
export function setBookMode(on: boolean): void {
    bookMode = on;
    document.body.classList.toggle("book-mode", on);
}
export function isBookMode(): boolean { return bookMode; }

/** 设置面板切布局档后原地重进当前场景（不重复结算电量） */
export function refreshCurrentScene(): void {
    if (!currentSceneKey) return;
    skipCostOnce = true;
    void renderScene(currentSceneKey);
}

// ===== 云端同步（M3）：登录且选了孩子才生效；所有同步失败静默（离线/未登录照玩） =====
let runPath: string[] = [];       // 本轮选择路径（进 restartScene 重置）
let sessionId: number | null = null; // 服务端 play_sessions 行 id
let resumePoint: { sceneKey: string; battery: number; path: string[] } | null = null;
let skipCostOnce = false; // 断点续玩跳场：保存的电量已是扣费后的，恢复时不再结算

/** 家长入口选中孩子后由 auth.ts 设置断点 */
export function setResumePoint(p: { sceneKey: string; battery: number; path: string[] } | null): void {
    resumePoint = p?{...p,sceneKey:pack().sceneAliases?.[p.sceneKey]??p.sceneKey}:null;
}

// ===== 如我所书（2026-08-19）：会话对话流收集 + 增量上报 =====
// 孩子的话 role=child（导出映射塔卡声线）；固定场景=beat、AI 生成=ai。
export interface DialogueEv { story_id: string; scene_key: string; role: string; text: string; type: string; }

let dialogueQueue: DialogueEv[] = [];
let dialogueTimer: ReturnType<typeof setTimeout> | null = null;
let dialogueFlushInFlight: Promise<void> = Promise.resolve();

/** 旅程日志抽屉订阅实时对话流（main.ts 注入） */
let onDialogue: ((evs: DialogueEv[]) => void) | null = null;
export function setDialogueListener(fn: ((evs: DialogueEv[]) => void) | null): void { onDialogue = fn; }

function collectDialogue(evs: DialogueEv[]): void {
    if (!evs.length) return;
    dialogueQueue.push(...evs);
    if (onDialogue) onDialogue(evs);
    if (dialogueTimer) clearTimeout(dialogueTimer);
    dialogueTimer = setTimeout(() => void flushDialogueEvents(), 800);
}

/** 冲刷对话流（防抖；结局前 await 确保成书数据完整） */
function flushDialogueEvents(): Promise<void> {
    if (dialogueTimer) { clearTimeout(dialogueTimer); dialogueTimer = null; }
    if (!sessionId || !session.token || !session.childId || !dialogueQueue.length) {
        return dialogueFlushInFlight;
    }
    const evs = dialogueQueue;
    const targetSession = sessionId;
    dialogueQueue = [];
    dialogueFlushInFlight = dialogueFlushInFlight
        .then(() => api.postEvents(targetSession, evs))
        .then(() => {}, () => { if (sessionId === targetSession) dialogueQueue.unshift(...evs); }); // 失败回滚仅属于原会话
    return dialogueFlushInFlight;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// 「玩一半被删」降级（spec §6 核心场景）：家长在别处删了当前孩子档案 → 云端保存 404。
// 不打断当前故事（本地状态机本来就完整），回落游客态继续播放，仅提示一次。
let fellBackToGuest = false;
function fallbackToGuest(): void {
    if (!session.token || fellBackToGuest) return;
    fellBackToGuest = true;
    clearSession();
    showStatus(t("engine.child_changed"), 4500);
}

function scheduleProgressSave(sceneKey: string): void {
    // 本地镜像无条件写（书架角标 + 游客断点；按「故事 × 孩子」隔离）
    saveLocalProgress(pack().id, { sceneKey, battery, path: runPath.slice() });
    if (!session.token || !session.childId) {
        // 游客：静默上报进度事件（匿名记录，失败不阻塞；登录后由云端 800ms 防抖接管）
        reportAnonEvent({ story_id: pack().id, type: "progress", scene_key: sceneKey,
                          payload: { battery, path: runPath.slice() } });
        return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        api.saveProgress(session.childId!, pack().id, sceneKey, battery, runPath).catch((e) => {
            if (e instanceof ApiError && e.status === 404) fallbackToGuest();
        });
    }, 800); // 防抖：连续跳场景只落最后一次
}

function syncSessionStart(): void {
    dialogueQueue = []; // 如我所书：新会话清空待上报队列（旧会话已在结局冲刷）
    resetCodexHighlights(); // 记忆库：新一次游玩，关键词「首次出现高亮」追踪归零
    if (session.token && session.childId) {
        api.startSession(session.childId, pack().id)
            .then(r => { sessionId = r.session_id; })
            .catch(() => {});
        return;
    }
    // 游客：会话开始事件（匿名记录）
    reportAnonEvent({ story_id: pack().id, type: "session_start", scene_key: pack().restartScene });
}

function syncSessionFinish(ending: string): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } // 结局场景自身的延迟保存作废，由归位写取代
    if (sessionId != null) {
        api.finishSession(sessionId, runPath, ending).catch(() => {});
        sessionId = null;
        setBadge("books", true); // 如我所书：结局成书 → 「如我所书」按钮亮橙黄点
    }
    // 进度归位到故事开头：下次「继续上次的故事」不会落在结局页
    if (session.token && session.childId) {
        api.saveProgress(session.childId, pack().id, pack().restartScene, 100, []).catch(() => {});
    } else {
        // 游客：会话结束事件（带完整路径与结局，匿名记录）
        reportAnonEvent({ story_id: pack().id, type: "session_end", scene_key: ending,
                          payload: { path: runPath.slice(), ending } });
    }
    saveLocalProgress(pack().id, { sceneKey: pack().restartScene, battery: 100, path: [], lastEnding: ending });
    resumePoint = null;
}

/** 首次交互补读需要读当前场景文本 */
export function getCurrentText(): string {
    return currentText;
}

/** 切语言后原地重渲用 */
export function getCurrentSceneKey(): string {
    return currentSceneKey;
}

/** 结局判定：setBattery（强制电量）或 ending:true（不动电量）——两者都触发会话收尾与「回到书架」 */
const isEnding = (scene: Scene): boolean => scene.setBattery != null || scene.ending === true;

// 结局场景的「回到书架」按钮：由 main.ts 注入（书架是壳层概念，引擎只留钩子）
let shelfReturn: (() => void) | null = null;
export function setShelfReturn(fn: (() => void) | null): void { shelfReturn = fn; }

// 结局场景的「下一章」主行动按钮（2026-10-07 章节衔接，spec: docs/superpowers/specs/2026-10-07-chapter-flow-and-shelf-journey.md）：
// main.ts boot 时注入一次取值函数，引擎渲染结局选项时才求值——标题语言、当前 pack、索引缺失都在调用时决定，
// 中英切换/异包跳转零额外接线。返回 null（末章/索引缺失）则不渲染。
export interface NextChapterAction {
    id: string;    // 下一章包 id（仅供埋点 payload）
    title: string; // 当前语言标题（展示用）
    cover: string; // 封面完整路径（stories/<id>/cover.jpg，boot 已预载）
    go(): void;    // 壳层导航（内部走 pickStory）
}
let nextChapter: (() => NextChapterAction | null) | null = null;
export function setNextChapter(fn: (() => NextChapterAction | null) | null): void { nextChapter = fn; }

// 选项/ hotspot 统一点选入口：禁用全部可点元素（防双击重复生成）后跳场
function navChoice(next: string, ctx?: GenCtx): void {
    document.querySelectorAll<HTMLButtonElement>(".choice-btn, .hotspot").forEach(b => (b.disabled = true));
    void renderScene(next, ctx);
}

// 选项呈现：VN 挂 #choices（对话框上方）；绘本挂右页 .book-choices + 左页 hotspot 物化
function mountChoices(scene: Scene, sceneKey: string): void {
    const box = bookMode ? bookChoicesEl() : document.getElementById("choices")!;
    box.innerHTML = "";
    // 绘本模式：有 hotspot 物化声明的选项不重复出气泡按钮
    const hotspotIdx = new Set(bookMode ? (scene.book?.hotspots || []).map(h => h.choice) : []);
    // 断点续玩：开场场景且存在云端断点时，首位提供「继续上次的故事」
    if (sceneKey === pack().startScene && resumePoint && resumePoint.sceneKey !== pack().startScene) {
        const rp = resumePoint;
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = t("engine.resume");
        btn.onclick = (e) => {
            e.stopPropagation();
            box.querySelectorAll("button").forEach(b => (b as HTMLButtonElement).disabled = true);
            resumePoint = null;
            battery = rp.battery;
            updateBatteryHUD();
            runPath = rp.path.slice();
            skipCostOnce = true; // 恢复的是「已进入该场景」的状态，不再扣费
            syncSessionStart(); // 续玩也计一次新会话
            renderScene(rp.sceneKey); // 不带 ctx：恢复的路径不再追加
        };
        box.appendChild(btn);
    }
    // 结局场景「下一章」主行动（D1.2：排在包自带「重新开始故事」之前——3-6 岁只看第一个大按钮）；
    // 末章/索引缺失时 nextChapter() 返回 null，不渲染（UI 与现状一致）。
    // 被动结局（depletedScene）不加特判：判定统一走 isEnding，与「回到书架」同条件。
    if (isEnding(scene) && nextChapter) {
        const act = nextChapter();
        if (act) {
            const btn = document.createElement("button");
            btn.className = "choice-btn next-chapter";
            const img = document.createElement("img");
            img.className = "nc-cover";
            img.src = act.cover;
            img.alt = "";
            const label = document.createElement("span");
            label.textContent = t("engine.next_chapter", { title: act.title });
            btn.append(img, label);
            btn.onclick = (e) => {
                e.stopPropagation();
                box.querySelectorAll("button").forEach(b => (b as HTMLButtonElement).disabled = true); // 防双击（pickStory 无幂等保护）
                stopSpeech();
                stopWind();
                reportEvent({ type: "chapter_next_click", scene_key: currentSceneKey, payload: { to: act.id } });
                act.go(); // 复用 pickStory 通道：闪屏「故事加载模式」/manifest/预载/断点种子全套自带
            };
            box.appendChild(btn);
        }
    }
    (scene.choices || []).forEach((c, i) => {
        if (hotspotIdx.has(i)) return; // 已物化为左页 hotspot
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = c.text;
        // stopPropagation：choices 在 dialog 内，阻止冒泡触发打字机补完
        btn.onclick = (e) => {
            e.stopPropagation();
            navChoice(c.next, { prevText: currentText, choiceText: c.text });
        };
        box.appendChild(btn);
    });
    // 线性场景（有 next 无 choices 且非自由输入专属场景）：「继续」导航按钮——freeInput 场景以自由输入为唯一推进
    if (scene.next && !(scene.choices && scene.choices.length) && !scene.freeInput) {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.classList.add("continue-action");
        btn.textContent = t("engine.continue");
        btn.insertAdjacentHTML("beforeend", uiIcon("play"));
        btn.onclick = (e) => {
            e.stopPropagation();
            btn.disabled = true;
            renderScene(scene.next!, { prevText: currentText });
        };
        box.appendChild(btn);
    }
    // 悬浮钮默认隐藏；有 freeInput 且条件允许时由 mountFreeInput 显示
    cleanupFreeInput(); // 清掉上一场景的引导气泡/兜底计时器（防串场景）
    document.getElementById("mic-fab")!.hidden = true;
    // 选项 C 渲染条件：本机开关开 + 家长后台未关该孩子自由发挥；游客也可用（2026-08-20 展示 AI 能力）
    const childOff = selectedChild()?.prefs?.ai_enabled === false;
    const fiAllowed = !!(scene.freeInput && loadSettings().enabled && !childOff);
    if (fiAllowed) {
        box.appendChild(mountFreeInput(scene, box, {
            bookMode, sceneKey: currentSceneKey, currentText,
            restoreFigure: () => setFigureState(eyeOf(scene)),
            render: (key, ctx, stay) => { if (stay) skipCostOnce = true; void renderScene(key, ctx); },
        }));
    }
    // 结局场景：追加「回到书架」
    if (isEnding(scene) && shelfReturn) {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = t("engine.back_shelf");
        btn.onclick = (e) => {
            e.stopPropagation();
            stopSpeech();
            stopWind();
            shelfReturn!();
        };
        box.appendChild(btn);
    }
    // 绘本：物化选项上左页（打字播完才出现，与气泡按钮同步）；
    // 第二参=freeInput 且本机语音可用时追加话筒 hotspot（2026-09-28 发现率优化，引擎内置件不进包数据）
    if (bookMode) renderHotspots(scene, fiAllowed && voiceCapable());
    speakChoices(scene.choices, scene.freeInput); // 排队在正文朗读之后
}

function runListenBar(scene: Scene): void {
    const bar = document.getElementById("listen-bar")!;
    const fill = document.getElementById("progress-fill")!;
    bar.style.display = "flex";
    fill.style.width = "0%";
    let p = 0;
    listenTimer = setInterval(() => {
        fill.style.width = (p += 2) + "%";
        if (p >= 100) {
            if (listenTimer) clearInterval(listenTimer);
            listenTimer = null;
            const label = scene.listenLabel || t("engine.listen_fallback");
            const btn = document.createElement("button");
            btn.className = "choice-btn";
            btn.innerText = label + "...";
            btn.onclick = (e) => {
                e.stopPropagation();
                btn.disabled = true;
                renderScene(scene.next!, { prevText: currentText, choiceText: t("engine.listen_done_choice") });
            };
            const box = bookMode ? bookChoicesEl() : document.getElementById("choices")!;
            box.innerHTML = "";
            box.appendChild(btn);
            speakChoices([{ text: label }]);
        }
    }, 80);
}

/** 设置面板「保存并返回书架」：冲刷云端防抖 + 清理语音/计时器 + 回书架。
 *  进度本来就连场景即存（本地即时 / 云端 800ms 防抖），这里补的是最后一哩的确定性。 */
export function exitToShelf(): void {
    cancelScenePresentation();
    cleanupFreeInput();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    // 同一本书从书架重新打开时不会重拉云端，保留本次退出的续玩点。
    // 结局已由 syncSessionFinish 归位，不能再把结局场景覆盖回云端。
    const scene = pack().scenes[currentSceneKey];
    const resumable = scene && !isEnding(scene);
    const pendingResume = currentSceneKey === pack().startScene && resumePoint;
    resumePoint = resumable ? pendingResume || { sceneKey: currentSceneKey, battery, path: runPath.slice() } : null;
    if (resumable && session.token && session.childId) {
        api.saveProgress(session.childId, pack().id, resumePoint!.sceneKey, resumePoint!.battery, resumePoint!.path).catch(() => {});
    }
    stopTyping();
    if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }
    stopSpeech();
    stopWind();
    resetBook(); // 绘本：清掉气泡揭示计时器（防回书架后还在翻页）
    cleanupMechanic();
    sceneSounds?.cleanup();sceneSounds=null; // 玩法组件：还原立绘/卸监听（从收集等玩法页退出书架）
    if (shelfReturn) shelfReturn();
}

export async function renderScene(key: string, ctx?: GenCtx): Promise<void> {
    key=pack().sceneAliases?.[key]??key;
    const original = pack().scenes[key];
    if (!original) return;
    const scene={...original,text:resolveStoryText(original.text)};
    cancelScenePresentation();
    const generation = sceneGeneration;
    cleanupFreeInput();
    // Choosing the opening again starts a fresh run; the explicit Resume button
    // clears resumePoint itself and deliberately preserves mechanic checkpoints.
    if (ctx && currentSceneKey === pack().startScene && resumePoint) {
        resumePoint = null;
        clearStoryState();
    }
    currentSceneKey = key;
    if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }
    // 玩法场景（mechanic）：卸载上一场景的玩法组件（还原立绘/卸监听/摘布局类；无玩法时为空操作）
    cleanupMechanic();
    sceneSounds?.cleanup();sceneSounds=null;

    // --- 电量结算：先扣后回，太阳救不了已经耗尽的电量；续玩跳场跳过 ---
    if (key === pack().restartScene) { // 每个故事开始回满、开新会话、清空路径
        battery = 100;
        if(!resumePoint)clearStoryState();
        runPath = [];
        syncSessionStart();
    }
    if (ctx && ctx.choiceText && key !== pack().restartScene) {
        runPath.push(ctx.choiceText); // 记录选择路径（重开点击不算剧情选择）
        // 如我所书：孩子的话入对话流（自由输入=custom → freeinput，预设选支 → choice）
        collectDialogue([{ story_id: pack().id, scene_key: key, role: "child", text: ctx.choiceText,
                           type: ctx.custom ? "freeinput" : "choice" }]);
    }
    // 开局场景（restartScene）不扣费：回满 100 后立刻被自身 cost 扣掉，「新章初始电量 100%」
    // 不成立（ch02/ch03/ch04 首景 cost:5 → 一进章就显示 95%）。开局=满电出发，与 line 34 注释一致。
    if (!skipCostOnce && key !== pack().restartScene) {
        battery = Math.max(0, battery - (scene.cost ?? 10));    // 推进剧情耗电
        if (scene.sun && battery > 0)                           // 太阳回电
            battery = Math.min(100, battery + scene.sun);
    }
    skipCostOnce = false;
    if (scene.setBattery != null) battery = scene.setBattery;
    updateBatteryHUD();
    // 打开封面后的序章只提供「继续 / 重开」，还没作出选择时保留原断点。
    if (!(key === pack().startScene && resumePoint && resumePoint.sceneKey !== key)) scheduleProgressSave(key);

    // 非结局场景电量耗尽 → 系统级打断，强制被动结局（优先级高于任何选项）
    if (battery === 0 && !isEnding(scene)) {
        renderScene(pack().depletedScene, ctx);
        return;
    }

    // 成就：进场景即解锁（幂等，重开不重复弹；耗尽打断进结局也会解锁）
    const unlocked = unlockForScene(key);
    if (unlocked) {
        showToast(unlocked.icon + " " + t("ach.toast_unlock", { name: unlocked.name }) + "<br><span class=\"toast-desc\">" + unlocked.desc + "</span>");
    }

    stopSpeech(); // 切场景打断上一段朗读
    stopWind();   // 风声只属于且听风吟场景
    if (scene.isSpecialListen) startWind(); // 风声起：这 4 秒，风是主角
    document.getElementById("choices")!.innerHTML = "";
    document.getElementById("listen-bar")!.style.display = "none";
    setFigureMode(scene.mode || "land");
    if (!bookMode) parkChromeVN(); // 立绘/聆听条归位到 VN 容器（从绘本切回时还原）
    // 背景层两种模式都跟随场景：VN 全屏铺满；绘本下 CSS 加模糊压暗成「书外磨砂」氛围
    setBackground(scene.background);

    // 场景文本永远是故事包定稿（作者定稿制）；仅选项 C 携带服务端预生成文本
    const text = (ctx && ctx.generated) || scene.text;
    const usedAI = !!(ctx && ctx.generated);

    // 如我所书：场景文本按说话人切句入对话流（固定场景=beat，AI 生成=ai；含开场/序章）。
    // 玩法提示不入对话流；带显式台词 cue 的合并页仍保留正文记录。
    if (text && (!scene.mechanic || scene.speechCue)) {
        const segs = parseTextSegs(text, scene.voiceOverrides);
        collectDialogue(segs.map(s => ({
            story_id: pack().id, scene_key: key, role: s.who, text: s.text, type: usedAI ? "ai" : "beat"
        })));
    }
    if (isEnding(scene)) { // 结局本身也必须入书；等待之前的防抖上报和本次结局一起落库再装订。
        await flushDialogueEvents();
        if (generation !== sceneGeneration) return;
        syncSessionFinish(key);
    }

    // 打字机期间 standby 临时切 speaking（spec §7）；特殊状态不被打断
    const eye = eyeOf(scene); // 电量档位修正后的实际灯光
    const duringTyping = eye === "st-standby" ? "st-speaking" : eye;
    setFigureState(duringTyping);

    sceneSounds=mountSceneSounds(scene,key);
    currentText = text;
    discoverScene(scene); // 记忆库：读到即「发现」（面板出现剪影）
    // 语音双轨：固定文本 → 预渲染 mp3 包（定稿声线）；AI 生成 → 浏览器 TTS 实时念
    // 且听风吟场景两种轨道都 duck 到 0.55，风声与人声平起平坐；玩法场景静默（无旁白）
    const played = (!usedAI || text === scene.text) && !scene.mechanic && playSceneAudio(key, scene.isSpecialListen);
    if (!played && !scene.mechanic) {
        if(scene.speechCue)void playSpeechCues([{id:key,kind:'tts',...scene.speechCue}],storyVariables());
        else speakStory(text, scene.isSpecialListen ? 0.55 : undefined, scene.voiceOverrides);
    }
    prefetchSceneAudio(key); // P1 滚动预取：当前+下一可选场景静态音频进内存（P1-B 统一通道的取用点）

    // 打字播完后的统一收尾：codex 高亮（绘本内部逐气泡已包，VN 在这里整段包）→ 灯光归位 → 选项/聆听条
    const onTextDone = () => {
        if (generation !== sceneGeneration) return;
        sceneSounds?.read();
        if (!bookMode) wrapCodexLinks(scene); // 绘本模式由 renderSceneBook 逐气泡 wrapCodexIn
        setFigureState(scene.endState || eye);
        if (scene.isSpecialListen) {
            runListenBar(scene);
        } else if (scene.choices && !scene.endState) {
            // 思考预告：闪三下（约 0.9s）再浮出选项
            const prev = eye;
            setFigureState("st-thinking");
            choiceTimer = setTimeout(() => {
                if (generation !== sceneGeneration) return;
                setFigureState(prev); mountChoices(scene, key);
            }, 900);
        } else {
            mountChoices(scene, key); // endState 场景（结局 B）直接给「重新开始」
        }
    };

    if (scene.mechanic) {
        // 玩法场景（mechanic 声明 → registry 分发，如第四章收集）：宿主建画布，组件接管左页
        // 窄屏「横过来」提示由组件自理；玩法仍渲染（横屏后即可玩）
        renderSceneMechanic(key, scene, onTextDone);
        return;
    }
    if (bookMode) {
        renderSceneBook(scene, text, onTextDone, key); // 绘本：翻页 + 气泡流
    } else {
        typeText(text, onTextDone); // VN：打字机
        renderVNTouches(scene,key);
    }
}

// 绘本 hotspot 的导航回调注入（book.ts 不反向 import engine，防循环依赖）；
// currentText 在点击当下惰性读取，与 VN 选项路径的 prevText 语义一致
initBookNav((next, choiceText, generated) => navChoice(next, { prevText: currentText, choiceText, generated, custom:!!generated }));

// 绘本话筒 hotspot 的点按回调注入（同 initBookNav 模式，2026-09-28 发现率优化）：
// activeVoice 由 mountFreeInput 在场景内注册、切场景清除；无控制器时点按静默无效
initBookVoice(toggleVoiceInput);

// 玩法组件成就回调（如收集「录满」→ mechanics 声明里的 achievement）：解锁 + toast
initMechanicAchievement((ach) => {
    if (!ach) return;
    const a = unlock(ach);
    if (a) {
        showToast(a.icon + " " + t("ach.toast_unlock", { name: a.name }) + "<br><span class=\"toast-desc\">" + a.desc + "</span>");
    }
});
