// 播放引擎：场景渲染 / 打字机 / 选项 / 自由输入 / 电量状态机 / 聆听条
// 与内容完全解耦——所有故事数据来自 pack()（story.json），本模块只负责“怎么播”
import { pack } from "./pack";
import { ICON_MIC } from "./icons";
import type { Scene } from "./story";
import { loadSettings, showStatus } from "./settings";
import { unlockForScene, showToast, unlock } from "./achievements";
import {
    speakStory, speakChoices, stopSpeech, startWind, stopWind, playSceneAudio, parseTextSegs
} from "./speech";
import { api, ApiError } from "./api";
import { session, selectedChild, clearSession } from "./session";
import { saveLocalProgress } from "./progress";
import { reportAnonEvent, ensureAnonId } from "./anon";
import { discoverScene, wrapCodexLinks, resetCodexHighlights } from "./codex";
import { setBadge } from "./badge";
import { t, lang } from "./i18n";
import { bookChoicesEl, renderHotspots, renderSceneBook, renderSceneCollect, parkChromeVN, initBookNav, resetBook, initCollectComplete, cleanupCollectDrag } from "./book";

/** 选项 C 生成上下文（生成在服务端完成，玩家端只传参） */
export interface GenCtx {
    prevText?: string;
    choiceText?: string;
    custom?: boolean;      // 选项 C 自由输入
    generated?: string;    // 服务端预生成好的文本
}

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

let typing: ReturnType<typeof setInterval> | null = null; // 打字机 timer
let currentText = ""; // 当前场景实际展示的文本，作为下一场景的「前情」
let currentSceneKey = ""; // 当前场景 key（「保存并返回」冲刷云保存用）
let listenTimer: ReturnType<typeof setInterval> | null = null; // 聆听条 timer

// ===== 横屏绘本模式（2026-08-31）：呈现层分派开关，由 main.ts 按宽度阈值/设置档切换 =====
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
    resumePoint = p;
}

// ===== 如我所书（2026-08-19）：会话对话流收集 + 增量上报 =====
// 孩子的话 role=child（导出映射塔卡声线）；固定场景=beat、AI 生成=ai。
export interface DialogueEv { story_id: string; scene_key: string; role: string; text: string; type: string; }

let dialogueQueue: DialogueEv[] = [];
let dialogueTimer: ReturnType<typeof setTimeout> | null = null;

/** 旅程日志抽屉订阅实时对话流（main.ts 注入） */
export let onDialogue: ((evs: DialogueEv[]) => void) | null = null;
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
        return Promise.resolve();
    }
    const evs = dialogueQueue;
    dialogueQueue = [];
    return api.postEvents(sessionId, evs)
        .then(() => {}, () => { dialogueQueue.unshift(...evs); }); // 失败回滚，下次再试
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

function setFigureState(state: string): void {
    document.getElementById("taka-figure")!.className = "taka-figure " + state;
}

// 双模式：水下 = 收腿悬浮（takaBodySwim），陆地 = 伸腿站立（takaBody）
function setFigureMode(mode: "swim" | "land"): void {
    const use = document.querySelector<SVGUseElement>("#taka-figure .takaBody use")!;
    use.setAttribute("href", mode === "swim" ? "#takaBodySwim" : "#takaBody");
}

// ===== 场景背景图：双层交叉淡化；scene.background 缺省 = 保持上一场景 =====
let bgFront: HTMLElement | null = null; // 当前显示层（a/b 轮换）
let bgCurrent = "";                    // 当前图片完整 URL（去重用）

/** 采样背景图顶部条带（顶栏按钮/HUD 所在区域）亮度：亮底自动切深色 UI（on-light-bg）
 *  2026-09：原判据用 BT.709 相对亮度 + 阈值 150，会把 ch02 海底/浅海这类「顶部偏亮的蓝海景」
 *  （实测 142-149）误判成暗底，浅色图标在亮蓝海景上几乎看不见。改用 BT.601 感知亮度
 *  （0.299R/0.587G/0.114B，对蓝色海景更贴人眼明感）+ 阈值降到 135，让亮蓝海景稳定判亮。
 *  注意：书台模式（book-mode）整屏两侧被书壳阴影+压暗层压低、整体偏暗，on-light-bg 会把图标
 *  误判成深色，故书台模式由 CSS 单独强制浅色（见 styles.css body.book-mode …），不依赖本采样。 */
function adaptChrome(img: HTMLImageElement): void {
    try {
        const w = 48, h = 10;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.16, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4)
            sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; // BT.601 感知亮度
        document.body.classList.toggle("on-light-bg", sum / (d.length / 4) > 135);
    } catch { /* 采样失败保持默认深色 UI */ }
}

function setBackground(rel?: string): void {
    if (!rel) return;
    const url = pack().baseUrl + rel;
    if (url === bgCurrent) return;
    bgCurrent = url;
    const a = document.getElementById("bg-a")!;
    const b = document.getElementById("bg-b")!;
    if (!bgFront) bgFront = a;
    const back = bgFront === a ? b : a;
    const img = new Image(); // 先预载，加载完再淡入，避免白闪
    img.onload = () => {
        back.style.backgroundImage = `url("${url}")`;
        back.classList.add("show");
        bgFront!.classList.remove("show");
        bgFront = back;
        adaptChrome(img);
    };
    img.src = url;
}

function typeText(text: string, onDone: () => void): void {
    const el = document.getElementById("story-text")!;
    el.innerText = "";
    el.scrollTop = 0; // 新场景从顶部开始；不做自动滚动（避免文字跑在语音前面）
    let i = 0;
    if (typing) clearInterval(typing);
    typing = setInterval(() => {
        el.innerText = text.slice(0, ++i);
        if (i >= text.length) { if (typing) clearInterval(typing); typing = null; onDone(); }
    }, 45);
    // 点击对话框立即补完
    document.getElementById("dialog")!.onclick = () => {
        if (typing) { clearInterval(typing); typing = null; el.innerText = text; onDone(); }
    };
}

/** 结局判定：setBattery（强制电量）或 ending:true（不动电量）——两者都触发会话收尾与「回到书架」 */
const isEnding = (scene: Scene): boolean => scene.setBattery != null || scene.ending === true;

let activeRec: { abort(): void; stop(): void } | null = null; // 进行中的语音识别（切场景时打断）

// 结局场景的「回到书架」按钮：由 main.ts 注入（书架是壳层概念，引擎只留钩子）
let shelfReturn: (() => void) | null = null;
export function setShelfReturn(fn: (() => void) | null): void { shelfReturn = fn; }

// 选项/ hotspot 统一点选入口：禁用全部可点元素（防双击重复生成）后跳场
export function navChoice(next: string, ctx?: GenCtx): void {
    document.querySelectorAll<HTMLButtonElement>(".choice-btn, .hotspot").forEach(b => (b.disabled = true));
    void renderScene(next, ctx);
}

// 自由输入选项 C v3（2026-09-01）：语音入口为全局悬浮钮（#mic-fab，固定屏幕右下角，远离文字区）。
// 打字行仍挂在选项容器里，默认收起，由悬浮钮短按展开。
// 交互：短按 = 展开/收起打字行；长按 = 语音输入；松开 = 直接发送；按住上滑 = 转文字进输入框可改。
// 录音开始时停有声书朗读（stopSpeech），不再一边播故事一边录音。
// 不在选项容器里创建话筒按钮——避免文字区误触（Mate 60 实测）。
export function mountFreeInput(scene: Scene, box: HTMLElement): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "choice-input fi-row";
    row.hidden = true; // 默认收起，由悬浮钮短按展开
    row.onclick = (e) => e.stopPropagation();

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = scene.freeInputMaxLength ?? 300;
    input.placeholder = t("engine.input_ph");
    row.appendChild(input);

    const hint = document.createElement("div");
    hint.className = "fi-hint";
    hint.hidden = true;
    row.appendChild(hint); // 提示条跟打字行一起走（展开时才可见）

    // 语音输入（浏览器能力：Chrome/ArkWeb 走云端；不支持时打字行常驻、悬浮钮隐藏）
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recording = false, slideUp = false, transcript = "";
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let startY = 0;
    let rec: any = null;
    let gotResult = false; // 本会话是否收到过任何识别结果（区分「服务不可用」与「没听清」）
    // 已知不可用平台（2026-09-01 实测）：
    //   - HarmonyOS/华为浏览器：无 Google 语音后端，僵尸识别（start 后无事件）
    //   - iPhone/iPad 全部浏览器（WKWebView）：webkitSpeechRecognition 不可靠
    // 进章节即检测并隐藏话筒，只留打字框（产品决定 2026-09-01）
    const KNOWN_BAD_UA = /HarmonyOS|HUAWEI|HuaweiBrowser|iPhone|iPad|iPod/i.test(navigator.userAgent);
    // 华为等无语音后端的内核：constructor 能建、start 静默无果/只报错——诚实降级为纯打字
    let voiceBroken = KNOWN_BAD_UA || localStorage.getItem("taka_voice_broken") === "1";
    const markBroken = () => {
        voiceBroken = true;
        localStorage.setItem("taka_voice_broken", "1"); // 持久化：下次进来直接不出话筒
        const f = document.getElementById("mic-fab");
        if (f) f.hidden = true; // 立即藏话筒
        row.hidden = false;     // 打字行常驻
    };

    if (SR) {
        rec = new SR();
        rec.lang = lang === "zh" ? "zh-CN" : "en-US";
        rec.interimResults = true;
        rec.onresult = (e: any) => {
            transcript = Array.from(e.results as any[]).map((r: any) => r[0].transcript).join("");
            gotResult = true;
            // 录音中实时回显转写（兼作「听到没有」的可视反馈，低端机排障用）
            if (recording && transcript) hint.textContent = transcript.slice(0, 40);
        };
        // 收尾必须在 onend：华为 ArkWeb 等内核在 stop() 之后才一次性给结果，
        // pointerup 时立刻读 transcript 必为空（2026-09-01 Mate 60 实测 bug）
        rec.onend = () => {
            const fab = document.getElementById("mic-fab");
            fab?.classList.remove("recording");
            if (activeRec === rec) activeRec = null;
            finalize();
        };
        rec.onerror = (e: any) => {
            // 先恢复 UI（onerror 不一定跟着 onend，不清理会卡在录音脉冲态——Mate 60 实测）
            recording = false;
            hint.hidden = true;
            document.getElementById("mic-fab")?.classList.remove("recording");
            const fabEl = document.getElementById("mic-fab");
            if (activeRec === rec) activeRec = null;
            // 服务级错误（无后端/网络）= 这台设备不可用，降级纯打字；权限错误给指引不降级
            if (e.error === "network" || e.error === "service-not-allowed") markBroken();
            const why = ({
                "not-allowed": t("engine.mic_not_allowed"),
                "service-not-allowed": t("engine.mic_unavailable"),
                "network": t("engine.mic_unavailable"),
                "audio-capture": t("engine.mic_no_device"),
                "no-speech": t("engine.mic_no_speech")
            } as Record<string, string>)[e.error as string] || e.error;
            showStatus(why, 3500);
            if (fabEl && voiceBroken) row.hidden = false; // 降级：打字行直接展开
        };
    }

    const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        if (activeRec) { try { activeRec.abort(); } catch {} }
        box.querySelectorAll("button, input").forEach(b => ((b as HTMLButtonElement | HTMLInputElement).disabled = true));

        // 自定义选择没有 fallback 文案可退（孩子的整活只有 AI 接得住）：
        // 先在当前场景生成，成功才切场景；失败则恢复选项，孩子再选一次
        // 2026-08-20：freeInput 场景可能无预设选项（如抹香鲸"等你开口"），跳转目标用 scene.next
        // 2026-09：新增 freeInputNext 指定回流目标（第四章「自由输入统跳 E」），优先于 choices[0].next / scene.next
        const nextKey = scene.freeInputNext || ((scene.choices && scene.choices[0]) ? scene.choices[0].next : scene.next!);
        setFigureState("st-pondering"); // 思考演出：思想泡泡 + 眼睛漫游 + 光晕（区别于 0.9s 选项预告）
        showStatus(t("engine.thinking"));
        try {
            // 游客也可自由输入（展示 AI 能力）：无孩子时用匿名设备 ID 走游客生成通道
            const anonId = (session.token && session.childId) ? undefined
                         : (await ensureAnonId()) || undefined;
            const r = await api.generate(
                session.token && session.childId ? session.childId! : null,
                pack().id, nextKey, currentText, text, currentSceneKey, anonId, lang);
            showStatus("");
            if (r.type === "stay") {
                // nonsense：原地停留——重渲当前场景（微调文案），不耗电、不计路径、可再输入
                skipCostOnce = true;
                renderScene(currentSceneKey, { custom: true, generated: r.text });
            } else if (r.type === "ignore") {
                // 脏话：零反馈——不回应、不记录路径，直接走默认主线的定稿文本
                renderScene(nextKey);
            } else {
                renderScene(nextKey, { prevText: currentText, choiceText: text, custom: true, generated: r.text });
            }
        } catch (e: any) {
            const status = e instanceof ApiError ? e.status : 0;
            const why = status === 401 ? t("engine.err_401")
                      : status === 429 ? t("engine.err_429")
                      : status === 503 ? t("engine.err_503")
                      : t("engine.err_network");
            showStatus(why, 4500);
            setFigureState(eyeOf(scene));
            box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement | HTMLInputElement).disabled = false);
        }
    };

    // 松开后的落地动作：onend 时执行（结果可能 stop() 后才到）；1s 超时兜底防 onend 不来
    let pendingAction: "send" | "edit" | null = null;
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
    const finalize = () => {
        if (!pendingAction) return;
        if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; }
        const action = pendingAction;
        pendingAction = null;
        const text = transcript.trim();
        if (!text) {
            // 从未收到过任何结果 = 服务根本没工作（不是孩子没说话）——降级纯打字
            if (!gotResult) {
                markBroken();
                row.hidden = false;
                showStatus(t("engine.mic_unavailable"), 3500);
            } else {
                showStatus(t("engine.mic_no_speech"), 2500);
            }
            return;
        }
        input.value = text;
        if (action === "edit") {
            row.hidden = false;
            input.focus();
        } else {
            void submit();
        }
    };

    // ===== 悬浮钮接线 =====
    const fab = document.getElementById("mic-fab")!;
    if (!fab.dataset.iconSet) {
        fab.innerHTML = ICON_MIC;
        fab.dataset.iconSet = "1";
    }
    fab.hidden = !SR || voiceBroken; // 不支持/已知不可用：话筒不出现，只留打字框
    if (!SR || voiceBroken) {
        row.hidden = false; // 打字行常驻
    }

    if (SR && rec) {
        const startRec = () => {
            if (voiceBroken) return; // 已知不可用：话筒已隐藏，理论到不了这里（防御）
            recording = true;
            slideUp = false;
            transcript = "";
            stopSpeech(); // 录音开始 = 有声书停播（2026-09-01 bugfix）
            if (activeRec) { try { activeRec.abort(); } catch {} }
            try {
                rec.start();
                activeRec = rec;
                fab.classList.add("recording");
                hint.textContent = t("engine.voice_hint_hold");
                hint.hidden = false;
                hint.classList.remove("slide");
                row.hidden = false; // 录音时展开打字行显示提示
                // 语音输入限时 20s（2026-08-09 决策：防 prompt 过长）
                setTimeout(() => {
                    if (activeRec === rec) {
                        stopRec(); // 走统一出口（清 UI + 超时落地）
                        showStatus(t("engine.mic_too_long"), 2500);
                    }
                }, 20000);
            } catch { recording = false; hint.hidden = true; fab.classList.remove("recording"); }
        };
        const stopRec = () => {
            recording = false;
            hint.hidden = true;
            fab.classList.remove("recording"); // UI 立即恢复，不等 onend（华为 onend 可能永远不来）
            try { rec.stop(); } catch {}
            // onend 大概率马上来；不来（部分内核 stop 后静默）1s 后用手头结果落地
            if (finalizeTimer) clearTimeout(finalizeTimer);
            finalizeTimer = setTimeout(finalize, 1000);
        };

        fab.oncontextmenu = (e) => e.preventDefault(); // 长按别弹系统菜单
        fab.onpointerdown = (e) => {
            e.preventDefault();
            // 指针捕获：手指按住后哪怕滑出按钮，move/up 事件也必定送达本元素
            // （2026-09-01 Mate 60 实测 bug：无捕获时手指微漂 → pointerup 落空 → 录音悬挂不发送）
            try { fab.setPointerCapture(e.pointerId); } catch {}
            startY = e.clientY;
            pressTimer = setTimeout(startRec, 350); // 350ms 内松开 = 短按（250ms 在手机上误触发录音率高）
        };
        fab.onpointermove = (e) => {
            if (!recording) return;
            const up = startY - e.clientY > 50;
            if (up !== slideUp) {
                slideUp = up;
                hint.textContent = up ? t("engine.voice_hint_slide") : t("engine.voice_hint_hold");
                hint.classList.toggle("slide", up);
            }
        };
        fab.onpointerup = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            if (!recording) {
                // 短按：展开/收起打字行。不自动 focus（防软键盘弹顶，孩子点输入框才弹）；
                // 展开后点页面空白处可收起（2026-09-01 Mate 60 实测：没有取消路径很挫败）
                row.hidden = !row.hidden;
                if (!row.hidden) {
                    setTimeout(() => document.addEventListener("pointerdown", function closeOnOut(ev) {
                        if (!row.contains(ev.target as Node) && !fab.contains(ev.target as Node)) {
                            row.hidden = true;
                            document.removeEventListener("pointerdown", closeOnOut);
                        }
                    }), 0); // setTimeout：本次 pointerup 的后续事件不能触发刚挂的监听
                }
                return;
            }
            pendingAction = slideUp ? "edit" : "send"; // 落地动作交给 onend/超时兜底
            stopRec();
        };
        fab.onpointercancel = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            if (recording) { pendingAction = null; stopRec(); }
        };
    }

    const send = document.createElement("button");
    send.innerText = "✓";
    send.title = t("engine.submit");
    send.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    row.appendChild(send);
    return row;
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
        btn.innerText = t("engine.continue");
        btn.onclick = (e) => {
            e.stopPropagation();
            btn.disabled = true;
            renderScene(scene.next!, { prevText: currentText });
        };
        box.appendChild(btn);
    }
    // 悬浮钮默认隐藏；有 freeInput 且条件允许时由 mountFreeInput 显示
    document.getElementById("mic-fab")!.hidden = true;
    // 选项 C 渲染条件：本机开关开 + 家长后台未关该孩子自由发挥；游客也可用（2026-08-20 展示 AI 能力）
    const childOff = selectedChild()?.prefs?.ai_enabled === false;
    if (scene.freeInput && loadSettings().enabled && !childOff) {
        box.appendChild(mountFreeInput(scene, box));
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
    if (bookMode) renderHotspots(scene); // 绘本：物化选项上左页（打字播完才出现，与气泡按钮同步）
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
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (session.token && session.childId && currentSceneKey) {
        api.saveProgress(session.childId, pack().id, currentSceneKey, battery, runPath).catch(() => {});
    }
    if (typing) { clearInterval(typing); typing = null; }
    if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }
    stopSpeech();
    stopWind();
    resetBook(); // 绘本：清掉气泡揭示计时器（防回书架后还在翻页）
    if (activeRec) { try { activeRec.abort(); } catch {} activeRec = null; }
    if (shelfReturn) shelfReturn();
}

export async function renderScene(key: string, ctx?: GenCtx): Promise<void> {
    const scene = pack().scenes[key];
    if (!scene) return;
    currentSceneKey = key;
    if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }
    // 收集小游戏节点：控制整页布局开关 + 卸掉上一 collect 场景遗留的塔卡拖拽监听
    document.body.classList.toggle("collect-active", !!scene.collect);
    cleanupCollectDrag();

    // --- 电量结算：先扣后回，太阳救不了已经耗尽的电量；续玩跳场跳过 ---
    if (key === pack().restartScene) { // 每个故事开始回满、开新会话、清空路径
        battery = 100;
        runPath = [];
        syncSessionStart();
    }
    if (ctx && ctx.choiceText && key !== pack().restartScene) {
        runPath.push(ctx.choiceText); // 记录选择路径（重开点击不算剧情选择）
        // 如我所书：孩子的话入对话流（自由输入=custom → freeinput，预设选支 → choice）
        collectDialogue([{ story_id: pack().id, scene_key: key, role: "child", text: ctx.choiceText,
                           type: ctx.custom ? "freeinput" : "choice" }]);
    }
    if (!skipCostOnce) {
        battery = Math.max(0, battery - (scene.cost ?? 10));    // 推进剧情耗电
        if (scene.sun && battery > 0)                           // 太阳回电
            battery = Math.min(100, battery + scene.sun);
    }
    skipCostOnce = false;
    if (scene.setBattery != null) battery = scene.setBattery;
    updateBatteryHUD();
    scheduleProgressSave(key);

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
    if (isEnding(scene)) { // 结局：先冲刷对话流（确保成书数据完整），再会话收尾
        await flushDialogueEvents();
        syncSessionFinish(key);
    }
    stopWind();   // 风声只属于且听风吟场景
    if (scene.isSpecialListen) startWind(); // 风声起：这 4 秒，风是主角
    if (activeRec) { try { activeRec.abort(); } catch {} activeRec = null; }
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
    // 收集小游戏节点：文本只是 UI 提示，不朗读、不入对话流。
    if (text && !scene.collect) {
        const segs = parseTextSegs(text, scene.voiceOverrides);
        collectDialogue(segs.map(s => ({
            story_id: pack().id, scene_key: key, role: s.who, text: s.text, type: usedAI ? "ai" : "beat"
        })));
    }

    // 打字机期间 standby 临时切 speaking（spec §7）；特殊状态不被打断
    const eye = eyeOf(scene); // 电量档位修正后的实际灯光
    const duringTyping = eye === "st-standby" ? "st-speaking" : eye;
    setFigureState(duringTyping);

    currentText = text;
    discoverScene(scene); // 记忆库：读到即「发现」（面板出现剪影）
    // 语音双轨：固定文本 → 预渲染 mp3 包（定稿声线）；AI 生成 → 浏览器 TTS 实时念
    // 且听风吟场景两种轨道都 duck 到 0.55，风声与人声平起平坐；收集节点静默（无旁白）
    const played = !usedAI && !scene.collect && playSceneAudio(key, scene.isSpecialListen);
    if (!played && !scene.collect) speakStory(text, scene.isSpecialListen ? 0.55 : undefined, scene.voiceOverrides);

    // 打字播完后的统一收尾：codex 高亮（绘本内部逐气泡已包，VN 在这里整段包）→ 灯光归位 → 选项/聆听条
    const onTextDone = () => {
        if (!bookMode) wrapCodexLinks(scene); // 绘本模式由 renderSceneBook 逐气泡 wrapCodexIn
        setFigureState(scene.endState || eye);
        if (scene.isSpecialListen) {
            runListenBar(scene);
        } else if (scene.choices && !scene.endState) {
            // 思考预告：闪三下（约 0.9s）再浮出选项
            const prev = eye;
            setFigureState("st-thinking");
            setTimeout(() => { setFigureState(prev); mountChoices(scene, key); }, 900);
        } else {
            mountChoices(scene, key); // endState 场景（结局 B）直接给「重新开始」
        }
    };

    if (scene.collect) {
        // 收集小游戏节点（横屏整页）：右页隐藏、塔卡可拖、物化物品收集计数
        // 窄屏时 collect 场景自行叠加「横过来」提示；玩法仍渲染（横屏后即可玩）
        renderSceneCollect(scene, onTextDone);
        return;
    }
    if (bookMode) {
        renderSceneBook(key, scene, text, onTextDone); // 绘本：翻页 + 气泡流
    } else {
        typeText(text, onTextDone); // VN：打字机
    }
}

// 绘本 hotspot 的导航回调注入（book.ts 不反向 import engine，防循环依赖）；
// currentText 在点击当下惰性读取，与 VN 选项路径的 prevText 语义一致
initBookNav((next, choiceText) => navChoice(next, { prevText: currentText, choiceText }));

// 收集小游戏节点：集满要求数量时解锁对应成就（collect.achievement）
initCollectComplete((ach) => {
    if (!ach) return;
    const a = unlock(ach);
    if (a) {
        showToast(a.icon + " " + t("ach.toast_unlock", { name: a.name }) + "<br><span class=\"toast-desc\">" + a.desc + "</span>");
    }
});
