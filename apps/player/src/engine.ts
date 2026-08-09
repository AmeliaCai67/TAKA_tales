// 播放引擎：场景渲染 / 打字机 / 选项 / 自由输入 / 电量状态机 / 聆听条
// 与内容完全解耦——所有故事数据来自 pack()（story.json），本模块只负责“怎么播”
import { pack } from "./pack";
import type { Scene } from "./story";
import { loadSettings, showStatus } from "./settings";
import { generateSceneText } from "./ai";
import type { GenCtx } from "./ai";
import { unlockForScene, showToast } from "./achievements";
import {
    speakStory, speakChoices, stopSpeech, startWind, stopWind, playSceneAudio
} from "./speech";

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
            try { rec.start(); activeRec = rec; mic.classList.add("recording"); } catch {}
        };
        row.appendChild(mic);
    }

    const send = document.createElement("button");
    send.innerText = "✓";
    send.title = "提交";
    const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        const settings = loadSettings();
        if (!(settings.enabled && settings.apiKey)) {
            // 留在页面：不清空输入、不走主线，孩子可以改选 A/B 或等大人开启 AI
            showStatus("塔卡还听不懂，需要大人在设置里开启 AI", 3000);
            return;
        }
        if (activeRec) { try { activeRec.abort(); } catch {} }
        const box = document.getElementById("choices")!;
        box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement).disabled = true);

        // 自定义选择没有 fallback 文案可退（孩子的整活只有 AI 接得住）：
        // 先在当前场景生成，成功才切场景；失败则恢复选项，孩子再选一次
        const nextKey = scene.choices![0].next;
        const nextScene = pack().scenes[nextKey];
        setFigureState("st-thinking");
        showStatus("塔卡在想...");
        try {
            const genText = await generateSceneText(nextScene,
                { prevText: currentText, choiceText: text, custom: true }, settings);
            showStatus("");
            renderScene(nextKey, { prevText: currentText, choiceText: text, custom: true, generated: genText });
        } catch (e: any) {
            console.warn("自定义选择生成失败：", e);
            const why = e.name === "AbortError" ? "超时" : (e.message || "网络错误");
            showStatus("塔卡没听懂（" + why + "），再选一次吧", 4500);
            setFigureState(eyeOf(scene));
            box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement).disabled = false);
        }
    };
    send.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    row.appendChild(send);
    return row;
}

function showChoices(scene: Scene): void {
    const box = document.getElementById("choices")!;
    box.innerHTML = "";
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
    if (scene.freeInput) box.appendChild(buildFreeInput(scene));
    speakChoices(scene.choices, scene.freeInput); // 排队在正文朗读之后
}

function runListenBar(next: string): void {
    const bar = document.getElementById("listen-bar")!;
    const fill = document.getElementById("progress-fill")!;
    bar.style.display = "flex";
    fill.style.width = "0%";
    let p = 0;
    const t = setInterval(() => {
        fill.style.width = (p += 2) + "%";
        if (p >= 100) {
            clearInterval(t);
            const btn = document.createElement("button");
            btn.className = "choice-btn";
            btn.innerText = "睁开眼睛，太阳升起来了...";
            btn.onclick = (e) => {
                e.stopPropagation();
                btn.disabled = true;
                renderScene(next, { prevText: currentText, choiceText: "静静听完风声" });
            };
            const box = document.getElementById("choices")!;
            box.innerHTML = "";
            box.appendChild(btn);
            speakChoices([{ text: "睁开眼睛，太阳升起来了" }]);
        }
    }, 80);
}

export async function renderScene(key: string, ctx?: GenCtx): Promise<void> {
    const scene = pack().scenes[key];
    if (!scene) return;

    // --- 电量结算：先扣后回，太阳救不了已经耗尽的电量 ---
    if (key === pack().restartScene) battery = 100;             // 每个故事开始回满
    battery = Math.max(0, battery - (scene.cost ?? 10));        // 推进剧情耗电
    if (scene.sun && battery > 0)                               // 太阳回电
        battery = Math.min(100, battery + scene.sun);
    if (scene.setBattery != null) battery = scene.setBattery;
    updateBatteryHUD();

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
    stopWind();   // 风声只属于且听风吟场景
    if (scene.isSpecialListen) startWind(); // 风声起：这 4 秒，风是主角
    if (activeRec) { try { activeRec.abort(); } catch {} activeRec = null; }
    document.getElementById("choices")!.innerHTML = "";
    document.getElementById("listen-bar")!.style.display = "none";
    setFigureMode(scene.mode || "land");

    // AI 生成：仅中段场景（scene.ai）；无 key / 开关关 / 失败均静默回退内置文案
    let text = scene.text, usedAI = false;
    const settings = loadSettings();
    if (ctx && ctx.generated) {
        text = ctx.generated; // 自定义选择：提交时已生成好，直接用（生成失败不会走到这里）
        usedAI = true;
    } else if (scene.ai && settings.enabled && settings.apiKey) {
        setFigureState("st-thinking"); // 思考态即 loading：眼睛闪三下
        showStatus("塔卡在想...");
        try {
            text = await generateSceneText(scene, ctx, settings);
            usedAI = true;
            showStatus("");
        } catch (e: any) {
            console.warn("AI 生成失败，回退本地文案：", e);
            const why = e.name === "AbortError" ? "超时" : (e.message || "网络错误");
            showStatus("已切换本地故事（" + why + "）", 4000);
        }
    }

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
            runListenBar(scene.next!);
        } else if (scene.choices && !scene.endState) {
            // 思考预告：闪三下（约 0.9s）再浮出选项
            const prev = eye;
            setFigureState("st-thinking");
            setTimeout(() => { setFigureState(prev); showChoices(scene); }, 900);
        } else {
            showChoices(scene); // endState 场景（结局 B）直接给「重新开始」
        }
    });
}
