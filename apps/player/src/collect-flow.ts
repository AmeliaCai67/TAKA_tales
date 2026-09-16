// 海底农场收集闭环（2026-09-07 spec）：收集 → 观察小剧本 → 控制台（信息/打标签/问一问）→ 录入记忆库
// (a) 聊天卡：observe 小剧本三句一批出字幕 + 包内预渲染音频；猫猫场景有活猫「喵」音效钮
//     （2026-09-16：删掉跳过/关闭——不连控制台不打标签就通不了关，不给旁路；唯一出口 = 连接控制台）
// (b) 控制台信息卡：facts 逐条播放（console 声线预渲染）
// (c) 问一问：/api/console-qa（仅自由发挥开启时可见，与选项 C 同一道门）
// (d) 打标签：机制判定（包数据 correct），预设文案池反馈，不惩罚选错；tab 排在问一问前面（打标是通关必经）
// (e) 录入：codex unlock + tags → 记忆库词条卡展示「我的标签」
import { api } from "./api";
import { session } from "./session";
import { pack } from "./pack";
import { t, lang } from "./i18n";
import { selectedChild } from "./session";
import { loadSettings } from "./settings";
import { recordCollectEntry } from "./codex";
import { currentAnonId } from "./anon";
import { acquireAudio } from "./audioPriority";
import { TTS_ENDPOINT } from "./config";
import type { CollectItem } from "./story";

export interface FlowCallbacks {
    onRecorded: (item: CollectItem, tags: string[]) => void;
}

const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let overlay: HTMLElement | null = null;
let curAudio: HTMLAudioElement | null = null;
let releaseAudio: (() => void) | null = null;
let dead = false; // 当前流程实例已销毁（异步回调防串场）
let tagsRecorded = false; // 当前物品已录入过（tags tab 显示「已录入」而不是可重打）

function kill(): void {
    dead = true;
    if (curAudio) { try { curAudio.pause(); } catch {} curAudio = null; }
    if (releaseAudio) { releaseAudio(); releaseAudio = null; }
    overlay?.remove();
    overlay = null;
}

export function closeCollectFlow(): void { kill(); }

function audioBase(): string {
    return pack().baseUrl + (lang === "en" ? "audio-en/" : "audio/");
}

async function playSrc(src: string): Promise<void> {
    if (curAudio) { try { curAudio.pause(); } catch {} }
    const a = new Audio(src);
    curAudio = a;
    if (!releaseAudio) releaseAudio = acquireAudio("codex", () => a.pause(), () => void a.play().catch(() => {}));
    try { await a.play(); } catch {}
    await new Promise<void>(res => {
        a.onended = () => res();
        a.onerror = () => res();
    });
    if (curAudio === a) curAudio = null;
}

/** 动态 TTS（问答回答：console 声线实时合成） */
async function playTts(text: string): Promise<void> {
    const src = `${TTS_ENDPOINT}?text=${encodeURIComponent(text)}&who=console&lang=${lang}`;
    await playSrc(src);
}

/* ================= (a) 聊天卡 ================= */

function openChatCard(item: CollectItem, cb: FlowCallbacks): void {
    kill();
    dead = false;
    const lines = item.observe || [];
    overlay = document.createElement("div");
    overlay.className = "cf-chat";
    overlay.innerHTML = `
        <div class="cf-chat-head">
            <span class="cf-chat-title">${esc(item.label || "")}</span>
            <span class="cf-chat-actions">
                ${item.meowSfx ? `<button class="cf-meow" title="${t("collect.meow")}">🔊 ${t("collect.meow")}</button>` : ""}
            </span>
        </div>
        <div class="cf-chat-body"></div>
        <div class="cf-chat-foot" hidden>
            <button class="cf-to-console">${t("collect.to_console")}</button>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector(".cf-meow")?.addEventListener("click", () => void playSrc(pack().baseUrl + "audio/" + item.meowSfx!));  // 猫叫与语言无关，固定走 audio/
    overlay.querySelector(".cf-to-console")!.addEventListener("click", () => openConsole(item, cb, "info"));

    const body = overlay.querySelector(".cf-chat-body") as HTMLElement;
    const foot = overlay.querySelector(".cf-chat-foot") as HTMLElement;
    let idx = 0;

    // 三句一批：先把一批字幕全打出来，再连播这批的语音（单句节奏太慢，2026-09-16 用户反馈）
    const BATCH = 3;
    const next = async (): Promise<void> => {
        if (dead) return;
        if (idx >= lines.length) { foot.hidden = false; return; }
        const start = idx;
        const batch = lines.slice(start, start + BATCH);
        idx += batch.length;
        const rows = batch.map(l => appendLine(l));
        for (let i = 0; i < rows.length; i++) {
            await typewrite(rows[i].querySelector(".cf-line-text") as HTMLElement, batch[i].line);
            if (dead) return;
        }
        for (let i = 0; i < batch.length; i++) {
            if (dead) return;
            await playSrc(`${audioBase()}collect/${item.id}.observe_${String(start + i + 1).padStart(2, "0")}.mp3`);
        }
        void next();
    };

    function appendLine(line: { who: string; line: string }): HTMLElement {
        const row = document.createElement("div");
        row.className = "cf-line cf-who-" + line.who;
        row.innerHTML = `<span class="cf-line-who">${esc(t("collect.who." + line.who))}</span><span class="cf-line-text"></span>`;
        body.appendChild(row);
        body.scrollTop = body.scrollHeight;
        return row;
    }

    void next();
}

async function typewrite(el: HTMLElement, text: string): Promise<void> {
    for (let i = 0; i < text.length; i++) {
        if (dead) return;
        el.textContent += text[i];
        el.parentElement!.parentElement!.scrollTop = 1e6;
        await new Promise(r => setTimeout(r, 28));
    }
}

/* ================= (b)-(e) 控制台 ================= */

type TabId = "info" | "qa" | "tags";

function qaAllowed(): boolean {
    // 与选项 C 同一道门：本机 AI 开关开 + 家长后台未关该孩子自由发挥（游客默认开）
    return loadSettings().enabled && selectedChild()?.prefs?.ai_enabled !== false;
}

function openConsole(item: CollectItem, cb: FlowCallbacks, tab: TabId): void {
    kill();
    dead = false;
    const showQa = qaAllowed();
    overlay = document.createElement("div");
    overlay.className = "cf-console-overlay";
    overlay.innerHTML = `
        <div class="cf-console">
            <div class="cf-con-head">
                <span class="cf-con-title">⌁ ${t("collect.console_title")}</span>
                <span class="cf-con-sub">${esc(item.label || "")}</span>
                ${tagsRecorded ? `<button class="cf-close">✕</button>` : ""}
            </div>
            ${tagsRecorded ? "" : `<div class="cf-con-note">${t("collect.tag_note")}</div>`}
            <div class="cf-con-tabs">
                <button data-tab="info" class="on">${t("collect.tab_info")}</button>
                <button data-tab="tags">${t("collect.tab_tags")}</button>
                ${showQa ? `<button data-tab="qa">${t("collect.tab_qa")}</button>` : ""}
            </div>
            <div class="cf-con-page" data-page="info">
                ${(item.facts || []).map((f, i) => `
                    <div class="cf-fact">
                        <button class="cf-fact-play" data-i="${i}">▶</button>
                        <span class="cf-fact-text">${esc(f)}</span>
                    </div>`).join("")}
                ${item.meowSfx ? `<button class="cf-meow-big">🔊 ${t("collect.meow")}</button>` : ""}
                ${item.meowLicense ? `<div class="cf-attr">${t("collect.meow_attr")}: ${esc(item.meowLicense.title)} · ${esc(item.meowLicense.author)} · ${esc(item.meowLicense.license)}</div>` : ""}
            </div>
            ${showQa ? `
            <div class="cf-con-page" data-page="qa" hidden>
                <div class="cf-qa-log"></div>
                <div class="cf-qa-row">
                    <input class="cf-qa-input" maxlength="200" placeholder="${t("collect.qa_ph")}">
                    <button class="cf-qa-send">${t("collect.qa_send")}</button>
                </div>
                <div class="cf-qa-hint">${t("collect.qa_hint")}</div>
            </div>` : ""}
            <div class="cf-con-page" data-page="tags" hidden>
                <div class="cf-tags-recorded" hidden>
                    <div class="cf-tags-recorded-mark">✓</div>
                    <div>${t("collect.tags_recorded")}</div>
                </div>
                <div class="cf-tags-tip">${t("collect.tags_tip", { n: item.tags?.pick ?? 2 })}</div>
                <div class="cf-chips">
                    ${(item.tags?.pool || []).map(x => `<button class="cf-chip" data-tag="${esc(x)}">${esc(x)}</button>`).join("")}
                </div>
                <div class="cf-tags-feedback" hidden></div>
                <button class="cf-tags-submit" disabled>${t("collect.tags_submit")}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    // 关闭钮只在「已录入回看」模式存在（未录入时唯一出路是打完标签，2026-09-16）
    overlay.querySelector(".cf-close")?.addEventListener("click", kill);
    overlay.querySelector(".cf-meow-big")?.addEventListener("click", () => void playSrc(pack().baseUrl + "audio/" + item.meowSfx!));
    overlay.querySelectorAll(".cf-fact-play").forEach(b => b.addEventListener("click", (e) => {
        const i = +(e.currentTarget as HTMLElement).dataset.i!;
        void playSrc(`${audioBase()}collect/${item.id}.fact_${String(i + 1).padStart(2, "0")}.mp3`);
    }));

    // tab 切换
    overlay.querySelectorAll(".cf-con-tabs button").forEach(b => b.addEventListener("click", () => {
        overlay!.querySelectorAll(".cf-con-tabs button").forEach(x => x.classList.remove("on"));
        b.classList.add("on");
        overlay!.querySelectorAll<HTMLElement>(".cf-con-page").forEach(p => { p.hidden = p.dataset.page !== (b as HTMLElement).dataset.tab; });
    }));

    if (tab !== "info") (overlay.querySelector(`.cf-con-tabs [data-tab="${tab}"]`) as HTMLElement)?.click();

    if (tagsRecorded) {
        // 已录入：tags tab 只展示「已录入」，不再可打
        overlay.querySelectorAll('[data-page="tags"] .cf-chip, [data-page="tags"] .cf-tags-submit, [data-page="tags"] .cf-tags-tip')
            .forEach(el => ((el as HTMLElement).style.display = "none"));
        (overlay.querySelector(".cf-tags-recorded") as HTMLElement).hidden = false;
    } else {
        wireTags(item, cb);
    }
    wireQa(item);
}

/* ---- (c) 问一问 ---- */

function wireQa(item: CollectItem): void {
    const page = overlay?.querySelector('[data-page="qa"]');
    if (!page) return;
    const logEl = page.querySelector(".cf-qa-log") as HTMLElement;
    const input = page.querySelector(".cf-qa-input") as HTMLInputElement;
    const send = page.querySelector(".cf-qa-send") as HTMLButtonElement;
    let busy = false;

    const ask = async () => {
        const q = input.value.trim();
        if (!q || busy || dead) return;
        busy = true;
        input.value = "";
        logEl.insertAdjacentHTML("beforeend", `<div class="cf-qa-q">${esc(q)}</div>`);
        const ans = document.createElement("div");
        ans.className = "cf-qa-a";
        ans.textContent = t("collect.qa_thinking");
        logEl.appendChild(ans);
        logEl.scrollTop = 1e6;
        try {
            const r = await api.consoleQa(session.childId ?? null, pack().id, item.id, q,
                                          session.token ? undefined : (currentAnonId() ?? undefined), lang);
            if (dead) return;
            if (r.type === "ignore") {
                ans.textContent = t("collect.qa_ignored"); // profanity 零反馈：控制台没有回应
            } else {
                ans.textContent = "";
                await typewriteInline(ans, r.text);
                if (!dead) void playTts(r.text);
            }
        } catch (e: any) {
            if (!dead) ans.textContent = e?.status === 429 ? t("collect.qa_quota") : t("collect.qa_error");
        }
        busy = false;
        logEl.scrollTop = 1e6;
    };
    send.addEventListener("click", () => void ask());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void ask(); });
}

async function typewriteInline(el: HTMLElement, text: string): Promise<void> {
    for (let i = 0; i < text.length; i++) {
        if (dead) return;
        el.textContent += text[i];
        el.parentElement!.scrollTop = 1e6;
        await new Promise(r => setTimeout(r, 30));
    }
}

/* ---- (d) 打标签（机制判定 + 预设文案池）---- */

function wireTags(item: CollectItem, cb: FlowCallbacks): void {
    const page = overlay?.querySelector('[data-page="tags"]');
    if (!page || !item.tags) return;
    const { correct, pick } = item.tags;
    const chosen = new Set<string>();
    const submit = page.querySelector(".cf-tags-submit") as HTMLButtonElement;
    const feedback = page.querySelector(".cf-tags-feedback") as HTMLElement;
    const chips = [...page.querySelectorAll<HTMLElement>(".cf-chip")];

    for (const chip of chips) chip.addEventListener("click", () => {
        const tag = chip.dataset.tag!;
        if (chosen.has(tag)) { chosen.delete(tag); chip.classList.remove("on"); }
        else if (chosen.size < pick) { chosen.add(tag); chip.classList.add("on"); }
        submit.disabled = chosen.size !== pick;
        feedback.hidden = true;
    });

    // 预设反馈文案池（2026-09-07 拍板：不用 AI 包装）。鼓励 + 方向提示，不惩罚
    const wrongPool = t("collect.tags_wrong_pool").split("|");
    const rightMsg = t("collect.tags_right");

    submit.addEventListener("click", () => {
        const sel = [...chosen];
        const allRight = sel.every(x => correct.includes(x)) && sel.length === pick;
        feedback.hidden = false;
        if (allRight) {
            feedback.className = "cf-tags-feedback ok";
            feedback.textContent = rightMsg;
            submit.disabled = true;
            chips.forEach(c => c.setAttribute("disabled", ""));
            // (e) 录入记忆库（解锁 + 标签）
            if (item.codexId) recordCollectEntry(pack().id, item.codexId, sel);
            setTimeout(() => { if (!dead) { kill(); cb.onRecorded(item, sel); } }, 1400);
        } else {
            feedback.className = "cf-tags-feedback no";
            feedback.textContent = wrongPool[Math.floor(Math.random() * wrongPool.length)];
            // 错选的 chip 抖动一下后放开，允许重选
            for (const c of chips) if (c.classList.contains("on") && !correct.includes(c.dataset.tag!)) {
                c.classList.add("shake");
                setTimeout(() => { c.classList.remove("shake", "on"); chosen.delete(c.dataset.tag!); submit.disabled = chosen.size !== pick; }, 650);
            }
        }
    });
}

/* ================= 入口 ================= */

/** 收集成功后：先聊（观察小剧本）→ 控制台。已收集过的物品再点：直接进控制台补流程。
 *  recorded=true 时 tags tab 展示「已录入」不可重打 */
export function openCollectFlow(item: CollectItem, cb: FlowCallbacks, startAt: "chat" | "console" = "chat", recorded = false): void {
    tagsRecorded = recorded;
    if (startAt === "console" || !item.observe?.length) openConsole(item, cb, "info");
    else openChatCard(item, cb);
}
