// 播放引擎：场景渲染 / 打字机 / 选项 / 自由输入 / 电量状态机 / 聆听条
// 与内容完全解耦——所有故事数据来自 pack()（story.json），本模块只负责“怎么播”
import { pack } from "./pack";
import { ICON_MIC } from "./icons";
import type { Scene } from "./story";
import { loadSettings, showStatus } from "./settings";
import { unlockForScene, showToast } from "./achievements";
import {
    speakStory, speakChoices, stopSpeech, startWind, stopWind, playSceneAudio, parseTextSegs
} from "./speech";
import { api, ApiError } from "./api";
import { session, selectedChild, clearSession } from "./session";
import { saveLocalProgress } from "./progress";
import { reportAnonEvent, ensureAnonId } from "./anon";
import { discoverScene, wrapCodexLinks, resetCodexHighlights } from "./codex";
import { setBadge } from "./badge";

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

function updateBatteryHUD(): void {
    document.getElementById("battery-text")!.innerText = battery + "%";
    const fill = document.getElementById("battery-fill")!;
    fill.style.width = battery + "%";
    fill.style.background = {
        high: "var(--ok-green)", mid: "var(--accent-dim)",
        low: "var(--low-orange)", depleted: "#7a4a12"
    }[tierOf(battery)];
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
    showStatus("孩子档案有变动，进度将只保存在这台设备上", 4500);
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

function setFigureState(state: string): void {
    document.getElementById("taka-figure")!.className = "taka-figure " + state;
}

// 双模式：水下 = 收腿悬浮（takaBodySwim），陆地 = 伸腿站立（takaBody）
function setFigureMode(mode: "swim" | "land"): void {
    const use = document.querySelector<SVGUseElement>("#taka-figure .takaBody use")!;
    use.setAttribute("href", mode === "swim" ? "#takaBodySwim" : "#takaBody");
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

// 自由输入选项 C：打字 / 语音，提交后编织进骨架（走默认主线 + 自定义文本传给 AI）
function buildFreeInput(scene: Scene): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "choice-input";
    row.onclick = (e) => e.stopPropagation();

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = scene.freeInputMaxLength ?? 300;
    input.placeholder = "你选……";
    row.appendChild(input);

    // 语音输入（浏览器能力：Chrome 走云端，离线/不支持时隐藏 🎤）
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
        const mic = document.createElement("button");
        mic.innerHTML = ICON_MIC;
        mic.title = "语音输入";
        const rec = new SR();
        rec.lang = "zh-CN";
        rec.interimResults = true;
        rec.onresult = (e: any) => {
            input.value = Array.from(e.results as any[]).map((r: any) => r[0].transcript).join("");
        };
        rec.onend = () => { mic.classList.remove("recording"); if (activeRec === rec) activeRec = null; };
        rec.onerror = (e: any) => {
            const why = ({
                "not-allowed": "请允许麦克风权限（地址栏左侧图标可改）",
                "service-not-allowed": "请允许麦克风权限（地址栏左侧图标可改）",
                "network": "语音识别需要联网（Chrome 走云端）",
                "audio-capture": "没找到麦克风",
                "no-speech": "没听清，再试一次"
            } as Record<string, string>)[e.error as string] || e.error;
            showStatus(why, 3500);
        };
        mic.onclick = () => {
            if (activeRec === rec) { rec.stop(); return; }
            try {
                rec.start();
                activeRec = rec;
                mic.classList.add("recording");
                // 语音输入限时 20s（2026-08-09 决策：防 prompt 过长）
                setTimeout(() => {
                    if (activeRec === rec) { rec.stop(); showStatus("语音最长 20 秒哦", 2500); }
                }, 20000);
            } catch {}
        };
        row.appendChild(mic);
    }

    const send = document.createElement("button");
    send.innerText = "✓";
    send.title = "提交";
    const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        if (activeRec) { try { activeRec.abort(); } catch {} }
        const box = document.getElementById("choices")!;
        box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement | HTMLInputElement).disabled = true);

        // 自定义选择没有 fallback 文案可退（孩子的整活只有 AI 接得住）：
        // 先在当前场景生成，成功才切场景；失败则恢复选项，孩子再选一次
        // 2026-08-20：freeInput 场景可能无预设选项（如抹香鲸"等你开口"），跳转目标用 scene.next
        const nextKey = (scene.choices && scene.choices[0]) ? scene.choices[0].next : scene.next!;
        setFigureState("st-pondering"); // 思考演出：思想泡泡 + 眼睛漫游 + 光晕（区别于 0.9s 选项预告）
        showStatus("塔卡在想...");
        try {
            // 游客也可自由输入（展示 AI 能力）：无孩子时用匿名设备 ID 走游客生成通道
            const anonId = (session.token && session.childId) ? undefined
                         : (await ensureAnonId()) || undefined;
            const r = await api.generate(
                session.token && session.childId ? session.childId! : null,
                pack().id, nextKey, currentText, text, currentSceneKey, anonId);
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
            const why = status === 401 ? "需要家长登录后，塔卡才能听懂你"
                      : status === 429 ? "今天的故事灵感用完啦，明天再来"
                      : status === 503 ? "塔卡没听懂，再选一次吧"
                      : "网络开小差了，再试一次";
            showStatus(why, 4500);
            setFigureState(eyeOf(scene));
            box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement | HTMLInputElement).disabled = false);
        }
    };
    send.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    row.appendChild(send);
    return row;
}

function showChoices(scene: Scene, sceneKey: string): void {
    const box = document.getElementById("choices")!;
    box.innerHTML = "";
    // 断点续玩：开场场景且存在云端断点时，首位提供「继续上次的故事」
    if (sceneKey === pack().startScene && resumePoint && resumePoint.sceneKey !== pack().startScene) {
        const rp = resumePoint;
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = "继续上次的故事";
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
    (scene.choices || []).forEach(c => {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = c.text;
        // stopPropagation：choices 在 dialog 内，阻止冒泡触发打字机补完
        btn.onclick = (e) => {
            e.stopPropagation();
            // 立即禁用所有按钮，防双击产生重复生成请求
            box.querySelectorAll("button").forEach(b => (b as HTMLButtonElement).disabled = true);
            renderScene(c.next, { prevText: currentText, choiceText: c.text });
        };
        box.appendChild(btn);
    });
    // 线性场景（有 next 无 choices 且非自由输入专属场景）：「继续」导航按钮——freeInput 场景以自由输入为唯一推进
    if (scene.next && !(scene.choices && scene.choices.length) && !scene.freeInput) {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = "继续 ▶";
        btn.onclick = (e) => {
            e.stopPropagation();
            btn.disabled = true;
            renderScene(scene.next!, { prevText: currentText });
        };
        box.appendChild(btn);
    }
    // 选项 C 渲染条件：本机开关开 + 家长后台未关该孩子自由发挥；游客也可用（2026-08-20 展示 AI 能力）
    const childOff = selectedChild()?.prefs?.ai_enabled === false;
    if (scene.freeInput && loadSettings().enabled && !childOff) {
        box.appendChild(buildFreeInput(scene));
    }
    // 结局场景：追加「回到书架」
    if (isEnding(scene) && shelfReturn) {
        const btn = document.createElement("button");
        btn.className = "choice-btn";
        btn.innerText = "回到书架";
        btn.onclick = (e) => {
            e.stopPropagation();
            stopSpeech();
            stopWind();
            shelfReturn!();
        };
        box.appendChild(btn);
    }
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
            const label = scene.listenLabel || "睁开眼睛，太阳升起来了";
            const btn = document.createElement("button");
            btn.className = "choice-btn";
            btn.innerText = label + "...";
            btn.onclick = (e) => {
                e.stopPropagation();
                btn.disabled = true;
                renderScene(scene.next!, { prevText: currentText, choiceText: "静静听完风声" });
            };
            const box = document.getElementById("choices")!;
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
    if (activeRec) { try { activeRec.abort(); } catch {} activeRec = null; }
    if (shelfReturn) shelfReturn();
}

export async function renderScene(key: string, ctx?: GenCtx): Promise<void> {
    const scene = pack().scenes[key];
    if (!scene) return;
    currentSceneKey = key;
    if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }

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
        showToast(unlocked.icon + " 解锁成就「" + unlocked.name + "」<br><span class=\"toast-desc\">" + unlocked.desc + "</span>");
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

    // 场景文本永远是故事包定稿（作者定稿制）；仅选项 C 携带服务端预生成文本
    const text = (ctx && ctx.generated) || scene.text;
    const usedAI = !!(ctx && ctx.generated);

    // 如我所书：场景文本按说话人切句入对话流（固定场景=beat，AI 生成=ai；含开场/序章）
    if (text) {
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
    // 且听风吟场景两种轨道都 duck 到 0.55，风声与人声平起平坐
    const played = !usedAI && playSceneAudio(key, scene.isSpecialListen);
    if (!played) speakStory(text, scene.isSpecialListen ? 0.55 : undefined, scene.voiceOverrides);
    typeText(text, () => {
        wrapCodexLinks(scene); // 记忆库：打字机播完，关键词亮起可点（spec §2 打字中不可点）
        setFigureState(scene.endState || eye);
        if (scene.isSpecialListen) {
            runListenBar(scene);
        } else if (scene.choices && !scene.endState) {
            // 思考预告：闪三下（约 0.9s）再浮出选项
            const prev = eye;
            setFigureState("st-thinking");
            setTimeout(() => { setFigureState(prev); showChoices(scene, key); }, 900);
        } else {
            showChoices(scene, key); // endState 场景（结局 B）直接给「重新开始」
        }
    });
}
