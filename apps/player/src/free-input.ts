// Voice/text input owns recognition and scene-local cleanup. Narrative transitions are injected.
import { suppressSoundEffects } from './sfx';
import { mountVoiceDiscovery } from './voice-discovery';
import { ICON_MIC } from './icons';
import { pack } from './pack';
import { showStatus } from './settings';
import { stopSpeech } from './speech';
import { api, ApiError } from './api';
import { session } from './session';
import { ensureAnonId } from './anon';
import { reportEvent } from './events';
import { t, lang } from './i18n';
import { setFigureState } from './scene-presentation';
import type { Scene } from './story';
import type { GenCtx } from './engine-types';
interface InputContext {
    bookMode: boolean; sceneKey: string; currentText: string;
    restoreFigure(): void;
    render(key: string, ctx?: GenCtx, stay?: boolean): void;
}
let activeRec: { abort(): void; stop(): void } | null = null; // 进行中的语音识别（切场景时打断）
let fiCleanup: (() => void) | null = null; // freeInput 引导/兜底 timer 与气泡清理（mountChoices 开头统一调用）

// 已知不可用平台（2026-09-01 实测）：HarmonyOS/华为（无 Google 语音后端）、iPhone/iPad（WKWebView 不可靠）
const KNOWN_BAD_UA = /HarmonyOS|HUAWEI|HuaweiBrowser|iPhone|iPad|iPod/i.test(navigator.userAgent);
/** 语音输入能力判定（fab/chip/hotspot 共用入口条件）：SR 存在 + 非黑名单 + 未被本机标记降级 */
export function voiceCapable(): boolean {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!SR && !KNOWN_BAD_UA && localStorage.getItem("taka_voice_broken") !== "1";
}
/** 当前场景的语音控制器（绘本模式话筒 hotspot 点按=开始/停止录音）；mountFreeInput 注册，fiCleanup 清除 */
let activeVoice: { toggle(): void } | null = null;


export function cleanupFreeInput(): void {
    fiCleanup?.(); fiCleanup = null;
    if (activeRec) { try { activeRec.abort(); } catch { /* already stopped */ } }
    activeRec = null;
    activeVoice = null;
}
export function toggleVoiceInput(): void { activeVoice?.toggle(); }

// 自由输入选项 C v3（2026-09-01）：语音入口为全局悬浮钮（#mic-fab，固定屏幕右下角，远离文字区）。
// 打字行仍挂在选项容器里，默认收起，由悬浮钮短按展开。
// 交互：短按 = 展开/收起打字行；长按 = 语音输入；松开 = 直接发送；按住上滑 = 转文字进输入框可改。
// 录音开始时停有声书朗读（stopSpeech），不再一边播故事一边录音。
// 不在选项容器里创建话筒按钮——避免文字区误触（Mate 60 实测）。
export function mountFreeInput(scene: Scene, box: HTMLElement, ctx: InputContext): HTMLDivElement {
    const { bookMode, sceneKey: currentSceneKey, currentText, render } = ctx;
    let disposed = false;
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
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let releaseEffects: (() => void) | null = null;
    const releaseSfx = () => { releaseEffects?.(); releaseEffects = null; };
    let recording = false, slideUp = false, transcript = "";
    let recordLimit: ReturnType<typeof setTimeout> | null = null;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let startY = 0;
    let rec: BrowserSpeechRecognition | null = null;
    let gotResult = false; // 本会话是否收到过任何识别结果（区分「服务不可用」与「没听清」）
    let viaVoice = false;  // 本次提交文本是否源自语音（漏斗区分 voice_submit / text_submit）
    // KNOWN_BAD_UA 已上提模块级（voiceCapable 共用）；华为等无语音后端的内核：constructor 能建、
    // start 静默无果/只报错——诚实降级为纯打字（产品决定 2026-09-01）
    let voiceBroken = KNOWN_BAD_UA || localStorage.getItem("taka_voice_broken") === "1";
    const markBroken = () => {
        voiceBroken = true;
        localStorage.setItem("taka_voice_broken", "1"); // 持久化：下次进来直接不出话筒
        reportEvent({ type: "voice_mark_broken", scene_key: currentSceneKey }); // 漏斗分母修正
        const f = document.getElementById("mic-fab");
        if (f) f.hidden = true; // 立即藏话筒
        row.hidden = false;     // 打字行常驻
    };

    if (SR) {
        rec = new SR();
        rec.lang = lang === "zh" ? "zh-CN" : "en-US";
        rec.interimResults = true;
        rec.onresult = (e) => {
            transcript = Array.from(e.results).map((r) => r[0].transcript).join("");
            gotResult = true;
            // 录音中实时回显转写（兼作「听到没有」的可视反馈，低端机排障用）
            if (recording && transcript) hint.textContent = transcript.slice(0, 40);
        };
        // 收尾必须在 onend：华为 ArkWeb 等内核在 stop() 之后才一次性给结果，
        // pointerup 时立刻读 transcript 必为空（2026-09-01 Mate 60 实测 bug）
        rec.onend = () => {
            releaseSfx();
            const fab = document.getElementById("mic-fab");
            fab?.classList.remove("recording");
            if (activeRec === rec) activeRec = null;
            finalize();
        };
        rec.onerror = (e) => {
            releaseSfx();
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
            } as Record<string, string>)[e.error] || e.error;
            showStatus(why, 3500);
            if (fabEl && voiceBroken) row.hidden = false; // 降级：打字行直接展开
        };
    }

    let dismissGuide: ((silent?: boolean) => void) | null = null;
    const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        // 漏斗转化事件：语音/打字分流（2026-09-28）；voice_first_submit 保留兼容旧聚合
        reportEvent({ type: viaVoice ? "voice_submit" : "text_submit", scene_key: currentSceneKey });
        viaVoice = false;
        // 语音引导退出条件之一：完成任意一次提交（语音或打字），永不再引导（2026-09-22）
        if (localStorage.getItem("taka_voice_guided") !== "1") {
            localStorage.setItem("taka_voice_guided", "1");
            reportEvent({ type: "voice_first_submit", scene_key: currentSceneKey });
        }
        dismissGuide?.(true); // 提交即摘引导气泡（不重复计 dismissed）
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
            if (disposed) return;
            showStatus("");
            if (r.type === "stay") {
                // nonsense：原地停留——重渲当前场景（微调文案），不耗电、不计路径、可再输入
                render(currentSceneKey, { custom: true, generated: r.text }, true);
            } else if (r.type === "ignore") {
                // 脏话：零反馈——不回应、不记录路径，直接走默认主线的定稿文本
                render(nextKey);
            } else {
                render(nextKey, { prevText: currentText, choiceText: text, custom: true, generated: r.text });
            }
        } catch (e) {
            if (disposed) return;
            const status = e instanceof ApiError ? e.status : 0;
            const why = status === 401 ? t("engine.err_401")
                      : status === 429 ? t("engine.err_429")
                      : status === 503 ? t("engine.err_503")
                      : t("engine.err_network");
            showStatus(why, 4500);
            ctx.restoreFigure();
            box.querySelectorAll("button, input").forEach(b => (b as HTMLButtonElement | HTMLInputElement).disabled = false);
        }
    };

    // 松开后的落地动作：onend 时执行（结果可能 stop() 后才到）；1s 超时兜底防 onend 不来
    let pendingAction: "send" | "edit" | null = null;
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
    const finalize = () => {
        releaseSfx();
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
        viaVoice = true; // 文本源自语音转写（含 edit 后再改再提交——语音始发的都算 voice_submit）
        if (action === "edit") {
            row.hidden = false;
            input.focus();
        } else {
            void submit();
        }
    };

    // ===== 悬浮钮接线 =====
    const fab = document.getElementById("mic-fab")!;
    fab.setAttribute("aria-label", t("engine.voice_hotspot_label"));
    if (!fab.dataset.iconSet) {
        fab.innerHTML = ICON_MIC;
        fab.dataset.iconSet = "1";
    }
    // 绘本模式：语音入口物化为左页 hotspot（renderHotspots 注入）——FAB 与 hotspot 互斥，只出现一个
    const micAsHotspot = bookMode && voiceCapable();
    fab.hidden = !SR || voiceBroken || micAsHotspot; // 不支持/已知不可用/已有 hotspot：话筒不出现，只留打字框
    if (!SR || voiceBroken || micAsHotspot) {
        row.hidden = false; // 打字行常驻
    }

    const discovery = mountVoiceDiscovery({ scene, box, row, hint, fab, bookMode, micAsHotspot, sceneKey: currentSceneKey });
    dismissGuide = discovery.dismiss;
    const listeners = new AbortController();
    fiCleanup = () => {
        disposed = true;
        pendingAction = null;
        if (pressTimer) clearTimeout(pressTimer);
        if (finalizeTimer) clearTimeout(finalizeTimer);
        if (recordLimit) clearTimeout(recordLimit);
        if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; }
        fab.onpointerdown = fab.onpointermove = fab.onpointerup = fab.onpointercancel = null;
        fab.oncontextmenu = null;
        listeners.abort();
        discovery.dispose();
        releaseSfx();
        activeVoice = null;
    };

    if (SR && rec) {
        const startRec = () => {
            if (voiceBroken) return; // 已知不可用：话筒已隐藏，理论到不了这里（防御）
            releaseSfx(); releaseEffects = suppressSoundEffects();
            recording = true;
            slideUp = false;
            transcript = "";
            stopSpeech(); // 录音开始 = 有声书停播（2026-09-01 bugfix）
            if (activeRec) { try { activeRec.abort(); } catch {} }
            try {
                rec.start();
                activeRec = rec;
                reportEvent({ type: "voice_record_start", scene_key: currentSceneKey }); // 漏斗：尝试
                fab.classList.add("recording");
                hint.textContent = t("engine.voice_hint_hold");
                hint.hidden = false;
                hint.classList.remove("slide");
                row.hidden = false; // 录音时展开打字行显示提示
                // 语音输入限时 20s（2026-08-09 决策：防 prompt 过长）
                if (recordLimit) clearTimeout(recordLimit);
                recordLimit = setTimeout(() => {
                    if (activeRec === rec) {
                        stopRec(); // 走统一出口（清 UI + 超时落地）
                        showStatus(t("engine.mic_too_long"), 2500);
                    }
                }, 20000);
            } catch { releaseSfx(); recording = false; hint.hidden = true; fab.classList.remove("recording"); }
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

        // 按压手势接线（fab 与 VN chip 共用同一套）：短按=展开/收起打字行，长按=录音，
        // 松开=发送，按住上滑=转文字可改。pointer 捕获防手指微漂落空（2026-09-01 Mate 60 实测）。
        const wirePress = (el: HTMLElement) => {
            el.oncontextmenu = (e) => e.preventDefault(); // 长按别弹系统菜单
            el.onpointerdown = (e) => {
                e.preventDefault();
                try { el.setPointerCapture(e.pointerId); } catch {}
                startY = e.clientY;
                pressTimer = setTimeout(startRec, 350); // 350ms 内松开 = 短按（250ms 在手机上误触发录音率高）
            };
            el.onpointermove = (e) => {
                if (!recording) return;
                const up = startY - e.clientY > 50;
                if (up !== slideUp) {
                    slideUp = up;
                    hint.textContent = up ? t("engine.voice_hint_slide") : t("engine.voice_hint_hold");
                    hint.classList.toggle("slide", up);
                }
            };
            el.onpointerup = () => {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                if (!recording) {
                    // 短按：展开/收起打字行。不自动 focus（防软键盘弹顶，孩子点输入框才弹）；
                    // 展开后点页面空白处可收起（2026-09-01 Mate 60 实测：没有取消路径很挫败）
                    reportEvent({ type: "voice_fab_tap", scene_key: currentSceneKey }); // 漏斗：尝试·轻
                    row.hidden = !row.hidden;
                    if (!row.hidden) {
                        setTimeout(() => { if (disposed) return; document.addEventListener("pointerdown", function closeOnOut(ev) {
                            if (!row.contains(ev.target as Node) && !fab.contains(ev.target as Node)) {
                                row.hidden = true;
                                document.removeEventListener("pointerdown", closeOnOut);
                            }
                        }, { signal: listeners.signal }); }, 0); // setTimeout：本次 pointerup 的后续事件不能触发刚挂的监听
                    }
                    return;
                }
                pendingAction = slideUp ? "edit" : "send"; // 落地动作交给 onend/超时兜底
                stopRec();
            };
            el.onpointercancel = () => {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                if (recording) { pendingAction = null; stopRec(); }
            };
        };
        wirePress(fab);

        // 绘本话筒 hotspot 的点按入口（engine 尾部 initBookVoice 注入给 book.ts）：点按=开始/停止录音
        activeVoice = {
            toggle: () => {
                reportEvent({ type: "voice_fab_tap", scene_key: currentSceneKey, payload: { via: "hotspot" } });
                if (recording) { pendingAction = "send"; stopRec(); }
                else startRec();
            }
        };

        // VN 模式语音 chip（2026-09-28 发现率优化）：与 A/B 选项同排同视觉权重。
        // 手势与 fab 一致（点按=打字行，误触零代价；按住=录音）。绘本模式的对应物=左页话筒 hotspot。
        if (!bookMode && !voiceBroken) {
            const chip = document.createElement("button");
            chip.className = "choice-btn voice-chip";
            chip.innerHTML = ICON_MIC + "<span></span>";
            chip.querySelector("span")!.textContent = t("engine.voice_chip");
            chip.title = t("engine.mic_title");
            wirePress(chip);
            box.appendChild(chip); // 先于 row 被挂（row 由调用方在 mountFreeInput 返回后 append）→ 顺序：选项…、chip、打字行
            // Touch readers already have a full-width voice choice; a second floating mic covers it.
            if (matchMedia('(pointer: coarse)').matches) fab.hidden = true;
        }
    }

    const send = document.createElement("button");
    send.innerText = "✓";
    send.title = t("engine.submit");
    send.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    row.appendChild(send);
    return row;
}
