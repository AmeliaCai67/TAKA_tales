// 播放引擎：场景渲染 / 打字机 / 选项 / 自由输入 / 电量状态机 / 聆听条
// 与内容完全解耦——所有故事数据来自 pack()（story.json），本模块只负责“怎么播”
import { pack } from "./pack";
import type { Scene } from "./story";
import { loadSettings, showStatus } from "./settings";
import { unlockForScene, showToast } from "./achievements";
import {
    speakStory, speakChoices, stopSpeech, startWind, stopWind, playSceneAudio
} from "./speech";
import { api, ApiError } from "./api";
import { session, selectedChild } from "./session";

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

// ===== 云端同步（M3）：登录且选了孩子才生效；所有同步失败静默（离线/未登录照玩） =====
let runPath: string[] = [];       // 本轮选择路径（进 restartScene 重置）
let sessionId: number | null = null; // 服务端 play_sessions 行 id
let resumePoint: { sceneKey: string; battery: number; path: string[] } | null = null;
let skipCostOnce = false; // 断点续玩跳场：保存的电量已是扣费后的，恢复时不再结算

/** 家长入口选中孩子后由 auth.ts 设置断点 */
export function setResumePoint(p: { sceneKey: string; battery: number; path: string[] } | null): void {
    resumePoint = p;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleProgressSave(sceneKey: string): void {
    if (!session.token || !session.childId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        api.saveProgress(session.childId!, pack().id, sceneKey, battery, runPath).catch(() => {});
    }, 800); // 防抖：连续跳场景只落最后一次
}

function syncSessionStart(): void {
    if (!session.token || !session.childId) return;
    api.startSession(session.childId, pack().id)
        .then(r => { sessionId = r.session_id; })
        .catch(() => {});
}

function syncSessionFinish(ending: string): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } // 结局场景自身的延迟保存作废，由归位写取代
    if (sessionId != null) {
        api.finishSession(sessionId, runPath, ending).catch(() => {});
        sessionId = null;
    }
    // 进度归位到故事开头：下次「继续上次的故事」不会落在结局页
    if (session.token && session.childId) {
        api.saveProgress(session.childId, pack().id, pack().restartScene, 100, []).catch(() => {});
    }
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

let activeRec: { abort(): void; stop(): void } | null = null; // 进行中的语音识别（切场景时打断）

// 自由输入选项 C：打字 / 语音，提交后编织进骨架（走默认主线 + 自定义文本传给 AI）
function buildFreeInput(scene: Scene): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "choice-input";
    row.onclick = (e) => e.stopPropagation();

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 50;
    input.placeholder = "你选……";
    row.appendChild(input);

    // 语音输入（浏览器能力：Chrome 走云端，离线/不支持时隐藏 🎤）
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
        const mic = document.createElement("button");
        mic.innerText = "🎤";
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
            showStatus("🎤 " + why, 3500);
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
        if (!(session.token && session.childId)) { // 双保险：未登录本不该看到选项 C
            showStatus("需要家长登录后，塔卡才能听懂你", 3000);
            return;
        }
        if (activeRec) { try { activeRec.abort(); } catch {} }
        const box = document.getElementById("choices")!;
        box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement).disabled = true);

        // 自定义选择没有 fallback 文案可退（孩子的整活只有 AI 接得住）：
        // 先在当前场景生成，成功才切场景；失败则恢复选项，孩子再选一次
        const nextKey = scene.choices![0].next;
        setFigureState("st-thinking");
        showStatus("塔卡在想...");
        try {
            const r = await api.generate(session.childId!, pack().id, nextKey, currentText, text);
            showStatus("");
            renderScene(nextKey, { prevText: currentText, choiceText: text, custom: true, generated: r.text });
        } catch (e: any) {
            const status = e instanceof ApiError ? e.status : 0;
            const why = status === 401 ? "需要家长登录后，塔卡才能听懂你"
                      : status === 429 ? "今天的故事灵感用完啦，明天再来"
                      : status === 503 ? "塔卡没听懂，再选一次吧"
                      : "网络开小差了，再试一次";
            showStatus(why, 4500);
            setFigureState(eyeOf(scene));
            box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement).disabled = false);
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
    // 选项 C 渲染条件：登录 + 选了孩子 + 本机开关开 + 家长后台未关该孩子的自由发挥（游客不显示）
    const childOff = selectedChild()?.prefs?.ai_enabled === false;
    if (scene.freeInput && session.token && session.childId && loadSettings().enabled && !childOff) {
        box.appendChild(buildFreeInput(scene));
    }
    speakChoices(scene.choices, scene.freeInput); // 排队在正文朗读之后
}

function runListenBar(scene: Scene): void {
    const bar = document.getElementById("listen-bar")!;
    const fill = document.getElementById("progress-fill")!;
    bar.style.display = "flex";
    fill.style.width = "0%";
    let p = 0;
    const t = setInterval(() => {
        fill.style.width = (p += 2) + "%";
        if (p >= 100) {
            clearInterval(t);
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

export async function renderScene(key: string, ctx?: GenCtx): Promise<void> {
    const scene = pack().scenes[key];
    if (!scene) return;

    // --- 电量结算：先扣后回，太阳救不了已经耗尽的电量；续玩跳场跳过 ---
    if (key === pack().restartScene) { // 每个故事开始回满、开新会话、清空路径
        battery = 100;
        runPath = [];
        syncSessionStart();
    }
    if (ctx && ctx.choiceText && key !== pack().restartScene) runPath.push(ctx.choiceText); // 记录选择路径（重开点击不算剧情选择）
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
    if (battery === 0 && scene.setBattery == null) {
        renderScene(pack().depletedScene, ctx);
        return;
    }

    // 成就：进场景即解锁（幂等，重开不重复弹；耗尽打断进结局也会解锁）
    const unlocked = unlockForScene(key);
    if (unlocked) {
        showToast(unlocked.icon + " 解锁成就「" + unlocked.name + "」<br><span class=\"toast-desc\">" + unlocked.desc + "</span>");
    }

    stopSpeech(); // 切场景打断上一段朗读
    if (scene.setBattery != null) syncSessionFinish(key); // 结局：会话收尾（路径+结局上报）
    stopWind();   // 风声只属于且听风吟场景
    if (scene.isSpecialListen) startWind(); // 风声起：这 4 秒，风是主角
    if (activeRec) { try { activeRec.abort(); } catch {} activeRec = null; }
    document.getElementById("choices")!.innerHTML = "";
    document.getElementById("listen-bar")!.style.display = "none";
    setFigureMode(scene.mode || "land");

    // 场景文本永远是故事包定稿（作者定稿制）；仅选项 C 携带服务端预生成文本
    const text = (ctx && ctx.generated) || scene.text;
    const usedAI = !!(ctx && ctx.generated);

    // 打字机期间 standby 临时切 speaking（spec §7）；特殊状态不被打断
    const eye = eyeOf(scene); // 电量档位修正后的实际灯光
    const duringTyping = eye === "st-standby" ? "st-speaking" : eye;
    setFigureState(duringTyping);

    currentText = text;
    // 语音双轨：固定文本 → 预渲染 mp3 包（定稿声线）；AI 生成 → 浏览器 TTS 实时念
    // 且听风吟场景两种轨道都 duck 到 0.55，风声与人声平起平坐
    const played = !usedAI && playSceneAudio(key, scene.isSpecialListen);
    if (!played) speakStory(text, scene.isSpecialListen ? 0.55 : undefined);
    typeText(text, () => {
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
