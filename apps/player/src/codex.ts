// 记忆库（2026-08-25 spec）：叙事层 / 科普层分离的图鉴系统
// - 场景 scene.codex 标注关键词 → 打字机播完后暖黄高亮可点（wrapCodexLinks）
// - 点关键词/面板图标 → 词条卡（真实图片 + 定稿科普 + 塔卡说 + 许可来源 + TTS 朗读）
// - 状态机：未出现（面板不显示，不剧透）/ 已发现（剪影「塔卡好像见过这个…」）/ 已解锁（彩色可回看）
// - 打卡与补解锁双入口殊途同归（不惩罚没点关键词的孩子，与「选 B 不惩罚」同一条价值观）
// - 登录用户入 codex_unlocks 表；游客 localStorage + anon 事件（codex_discover / codex_unlock）
import { api } from "./api";
import { session } from "./session";
import { pack } from "./pack";
import { reportAnonEvent } from "./anon";
import { showStatus } from "./settings";
import { loadStoriesIndex, type CodexEntry, type Scene } from "./story";
import { acquireAudio } from "./audioPriority";
import { TTS_ENDPOINT } from "./config";
import { t, lang } from "./i18n";
import { ICON_CODEX } from "./icons";
import { setBadge } from "./badge";

interface EntryState { d: boolean; u: boolean; tags?: string[]; } // discovered / unlocked / 孩子打的标签（2026-09-07）
const KEY = (storyId: string, entryId: string) => `${storyId}:${entryId}`;
const GUEST_LS = "taka_codex_v1";
const state = new Map<string, EntryState>();

const escHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- 状态：水合 / 持久化 / 上报 ---------- */

/** 登录（拉后端）或游客（拉 localStorage）水合。孩子切换 / 进故事 / 开面板前调用 */
export async function hydrateCodex(): Promise<void> {
    state.clear();
    if (session.token && session.childId) {
        try {
            const r = await api.codexList(session.childId);
            for (const e of r.entries)
                state.set(KEY(e.story_id, e.entry_id), { d: true, u: !!e.unlocked_at, tags: e.tags ?? undefined });
        } catch { /* 离线降级：保持空态，本次游玩仍可正常打卡（写库各自重试） */ }
    } else {
        try {
            const raw = JSON.parse(localStorage.getItem(GUEST_LS) || "{}") as Record<string, EntryState>;
            for (const [k, v] of Object.entries(raw)) state.set(k, { d: !!v?.d, u: !!v?.u, tags: v?.tags });
        } catch { /* 损坏就重来 */ }
    }
}

function persistGuest(): void {
    if (session.token) return;
    const o: Record<string, EntryState> = {};
    for (const [k, v] of state) o[k] = v;
    try { localStorage.setItem(GUEST_LS, JSON.stringify(o)); } catch {}
}

/** 标记发现/解锁。返回「本次是否首次解锁」（决定要不要播打卡反馈） */
function mark(storyId: string, entryId: string, unlock: boolean, tags?: string[]): boolean {
    const k = KEY(storyId, entryId);
    const cur = state.get(k) || { d: false, u: false };
    const firstUnlock = unlock && !cur.u;
    cur.d = true;
    if (unlock) cur.u = true;
    if (tags) cur.tags = tags;
    state.set(k, cur);
    if (session.token && session.childId) {
        (unlock ? api.codexUnlock(session.childId, storyId, entryId, tags) : api.codexDiscover(session.childId, storyId, entryId)).catch(() => {});
    } else {
        persistGuest();
        reportAnonEvent({ story_id: storyId, type: unlock ? "codex_unlock" : "codex_discover",
                          payload: { entry: entryId, tags } });
    }
    return firstUnlock;
}

/** 海底农场录入（2026-09-07）：打完标签后连标签一起录入记忆库。返回是否首次解锁 */
export function recordCollectEntry(storyId: string, entryId: string, tags: string[]): boolean {
    return mark(storyId, entryId, true, tags);
}

/** 某词条的标签（收集页「已录入」光环 / 词条卡「我的标签」） */
export function entryTags(storyId: string, entryId: string): string[] | undefined {
    return state.get(KEY(storyId, entryId))?.tags;
}

/** 某词条是否已解锁（收集页恢复「已录入」勾选态用） */
export function entryUnlocked(storyId: string, entryId: string): boolean {
    return !!state.get(KEY(storyId, entryId))?.u;
}

/* ---------- 故事内：发现 + 关键词高亮 ---------- */

/** 一次游玩中已高亮过的词条（2026-08-25 修：只在第一次出现时高亮——
 *  之前 split/join 全量包裹，ch03 高潮段「铆钉」满屏闪烁；现在每词条每次游玩只亮第一处） */
const highlightedThisRun = new Set<string>(); // key = storyId:entryId

/** 新游玩会话开始时调用（syncSessionStart）：重置「首次出现」追踪 */
export function resetCodexHighlights(): void { highlightedThisRun.clear(); }

/** 进场景时调用：场景标注的词条记为「已发现」（记忆库出现剪影） */
export function discoverScene(scene: Scene): void {
    for (const l of scene.codex || []) {
        if (!state.get(KEY(pack().id, l.entry))?.d) mark(pack().id, l.entry, false);
    }
}

/** 打字机播完/补完后调用：把标注的关键词包成可点高亮（spec §2）
 *  2026-08-25 修：每个词条每次游玩只在第一次出现时高亮第一处，后续场景/出现不再亮 */
export function wrapCodexLinks(scene: Scene): void {
    const el = document.getElementById("story-text");
    if (el) wrapCodexIn(el, scene);
}

/** 单元素版（绘本模式逐气泡调用；el 必须是纯文本节点容器） */
export function wrapCodexIn(el: HTMLElement, scene: Scene): void {
    if (!scene.codex?.length) return;
    let html = escHtml(el.innerText); // pre-line CSS：\n 直接渲染换行，无需 <br>
    for (const l of scene.codex) {
        const k = KEY(pack().id, l.entry);
        if (highlightedThisRun.has(k)) continue; // 本次游玩已亮过：后面不再高亮
        const w = escHtml(l.word);
        const idx = html.indexOf(w);            // 只包第一处（不是 split/join 全量）
        if (idx < 0) continue;                  // AI 重写的文本可能不含原词，跳过即可
        const unlocked = state.get(k)?.u;
        // 未解锁：呼吸闪烁邀请点击；已解锁：静态高亮可回看（spec §8.3）
        const span = `<span class="codex-link${unlocked ? "" : " locked"}" data-entry="${l.entry}">${w}</span>`;
        html = html.slice(0, idx) + span + html.slice(idx + w.length);
        highlightedThisRun.add(k);
    }
    el.innerHTML = html;
}

/* ---------- 词条卡 ---------- */

let cardOverlay: HTMLElement | null = null;
let panelOverlay: HTMLElement | null = null;
let ttsAudio: HTMLAudioElement | null = null;
let codexRelease: (() => void) | null = null; // 图鉴层音频焦点（暂停故事剧情用）

function stopEntryTts(): void {
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    if (codexRelease) { codexRelease(); codexRelease = null; } // 释放图鉴层焦点 → 恢复被暂停的故事
    document.querySelector(".cc-tts.playing")?.classList.remove("playing");
}

export function closeCodexCard(): void {
    stopEntryTts();
    cardOverlay?.remove();
    cardOverlay = null;
}

/** 词条卡 TTS：科普走叙述者声线，塔卡说走塔卡声线（spec §3）
 *  2026-08-28：优先包内预渲染（audio[-en]/codex/<id>.science|taka.mp3），404 才回退服务端动态 TTS——
 *  实时链路冷渲染首段 ~7s + 段间死气，被用户感知为「卡/塔卡说被吞掉」 */
function toggleEntryTts(entry: CodexEntry, btn: HTMLElement, storyId: string): void {
    if (ttsAudio) { stopEntryTts(); return; }
    btn.classList.add("playing");
    btn.textContent = t("codex.stop");
    // 音频路径按词条所属故事拼（面板可跨故事开卡，pack() 是当前加载的故事，会错）
    const audioBase = `stories/${storyId}/` + (lang === "en" ? "audio-en/" : "audio/") + "codex/";
    const tts = (text: string, who: string) =>
        `${TTS_ENDPOINT}?text=${encodeURIComponent(text)}&who=${who}${lang === "en" ? "&lang=en" : ""}`;
    // [主 URL（包内预渲染）, 回退 URL（动态 TTS）]
    const queue: [string, string][] = [
        [audioBase + entry.id + ".science.mp3", tts(entry.science.join(""), "narrator")],
        [audioBase + entry.id + ".taka.mp3", tts(entry.takaSays.join(" "), "taka")],
    ];
    // 图鉴层（中优先）：开始播放时暂停故事剧情，结束/停止后自动恢复
    codexRelease = acquireAudio("codex", () => ttsAudio?.pause(), () => ttsAudio?.play());
    const playNext = async () => {
        const item = queue.shift();
        if (!item) { stopEntryTts(); resetTtsBtn(); return; }
        const a = new Audio(item[0]);
        ttsAudio = a;
        a.onended = () => void playNext();
        let fellBack = false;
        a.onerror = () => {
            if (!fellBack) {  // 包内文件不存在 → 换动态 TTS 重试本段（只换一次）
                fellBack = true;
                a.src = item[1];
                void a.play().catch(() => { stopEntryTts(); resetTtsBtn(); });
                return;
            }
            stopEntryTts(); resetTtsBtn();
        };
        try { await a.play(); } catch { stopEntryTts(); resetTtsBtn(); }
    };
    void playNext();
}

function resetTtsBtn(): void {
    const b = document.querySelector(".cc-tts");
    if (b) b.textContent = t("codex.listen");
}

/** 打开词条卡（点关键词=打卡 / 点面板图标=补解锁，殊途同归）。imgSrc 需已拼好完整路径 */
export function openCodexCard(storyId: string, entry: CodexEntry, imgSrc: string): void {
    const firstUnlock = mark(storyId, entry.id, true);
    closeCodexCard();
    cardOverlay = document.createElement("div");
    cardOverlay.className = "codex-overlay codex-card-overlay";
    cardOverlay.innerHTML = `
        <div class="codex-card">
            <button class="cc-close" title="${t("codex.close")}">✕</button>
            <img class="cc-img" src="${escHtml(imgSrc)}" alt="${escHtml(entry.name)}">
            <div class="cc-body">
                <div class="cc-name">${escHtml(entry.name)}</div>
                <div class="cc-science">${entry.science.map(s => `<p>${escHtml(s)}</p>`).join("")}</div>
                <div class="cc-taka">
                    <span class="cc-taka-label">${t("codex.taka_says")}</span>
                    ${entry.takaSays.map(s => `<p>「${escHtml(s)}」</p>`).join("")}
                </div>
                ${(() => { const tags = entryTags(storyId, entry.id); return tags?.length ? `<div class="cc-tags"><span class="cc-tags-label">${t("codex.my_tags")}</span>${tags.map(x => `<span class="cc-tag">${escHtml(x)}</span>`).join("")}</div>` : ""; })()}
                <button class="cc-tts">${t("codex.listen")}</button>
                <div class="cc-src">${t("codex.src_prefix")}${escHtml(entry.source.author)} · ${escHtml(entry.source.license)} · <a href="${escHtml(entry.source.url)}" target="_blank" rel="noopener">${entry.source.url.includes("wikimedia") ? "Wikimedia Commons" : t("codex.src_link")}</a>${entry.source.url2 ? ` · <a href="${escHtml(entry.source.url2)}" target="_blank" rel="noopener">${entry.source.url2.includes("wikimedia") ? "Wikimedia Commons" : t("codex.src_link")}</a>` : ""}</div>
            </div>
        </div>`;
    cardOverlay.onclick = (e) => { if (e.target === cardOverlay) closeCodexCard(); };
    cardOverlay.querySelector(".cc-close")!.addEventListener("click", closeCodexCard);
    cardOverlay.querySelector(".cc-tts")!.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleEntryTts(entry, e.currentTarget as HTMLElement, storyId);
    });
    document.body.appendChild(cardOverlay);
    if (firstUnlock) { showStatus(t("codex.toast_unlocked"), 2500); setBadge("codex", true); } // 记忆库更新 → 按钮亮橙黄点
}

/** 当前故事内点关键词的入口（事件委托，initCodex 挂一次） */
function openEntryById(storyId: string, entryId: string): void {
    const entry = pack().codex?.entries.find(e => e.id === entryId);
    if (!entry) return;
    openCodexCard(storyId, entry, pack().baseUrl + entry.image);
}

/* ---------- 记忆库面板（书架入口） ---------- */

export function closeCodexPanel(): void {
    closeCodexCard();
    panelOverlay?.remove();
    panelOverlay = null;
}

export async function openCodexPanel(): Promise<void> {
    await hydrateCodex(); // 对齐最新状态（孩子切换/刚打完卡）
    const stories = await loadStoriesIndex();
    closeCodexPanel();
    panelOverlay = document.createElement("div");
    panelOverlay.className = "codex-overlay codex-panel-overlay";

    const groups = stories.map(s => {
        // i18n：en 模式用 alt.en 的词条和标题（2026-08-28 修：记忆库面板没跟语言走）
        const entries = (lang === "en" ? (s.alt?.en?.codexEntries || s.codexEntries) : s.codexEntries) || [];
        const sTitle = lang === "en" ? (s.alt?.en?.title || s.title) : s.title;
        let hidden = 0;
        const tiles = entries.map(e => {
            const st = state.get(KEY(s.id, e.id));
            if (!st?.d) { hidden++; return ""; } // 未出现：不显示（不剧透）
            if (st.u) {
                return `<button class="cp-tile" data-story="${s.id}" data-entry="${e.id}">
                    <img src="${escHtml(e.image)}" alt="${escHtml(e.name)}"><span>${escHtml(e.name)}</span>
                </button>`;
            }
            // 已发现未解锁：剪影 + 邀请语
            return `<button class="cp-tile locked" data-story="${s.id}" data-entry="${e.id}">
                <img class="silhouette" src="${escHtml(e.image)}" alt=""><span>${t("codex.unknown")}</span>
                <em>${t("codex.locked_hint")}</em>
            </button>`;
        }).join("");
        const unlocked = entries.filter(e => state.get(KEY(s.id, e.id))?.u).length;
        const hint = hidden ? `<div class="cp-hint">${t("codex.hidden_hint", { n: hidden })}</div>` : "";
        if (!entries.length) return "";
        return `<div class="cp-story">
            <div class="cp-story-name">${lang === "en" ? escHtml(sTitle) : `《${escHtml(sTitle)}》`}<span class="cp-count">${unlocked}/${entries.length}</span></div>
            <div class="cp-grid">${tiles}</div>${hint}
        </div>`;
    }).join("");

    panelOverlay.innerHTML = `
        <div class="codex-panel">
            <div class="cp-head"><span class="cp-title">${ICON_CODEX}${t("codex.title")}</span><button class="cc-close">✕</button></div>
            <div class="cp-body">${groups || `<div class="cp-empty">${t("codex.empty")}</div>`}</div>
        </div>`;
    panelOverlay.onclick = (e) => { if (e.target === panelOverlay) closeCodexPanel(); };
    panelOverlay.querySelector(".cc-close")!.addEventListener("click", closeCodexPanel);
    panelOverlay.querySelectorAll<HTMLElement>(".cp-tile").forEach(t => {
        t.onclick = () => {
            const sid = t.dataset.story!, eid = t.dataset.entry!;
            const meta = stories.find(s => s.id === sid);
            const list = lang === "en" ? (meta?.alt?.en?.codexEntries || meta?.codexEntries) : meta?.codexEntries;
            const entry = list?.find(e => e.id === eid);
            if (entry) openCodexCard(sid, entry, entry.image); // index.json 的 image 已是完整路径
        };
    });
    document.body.appendChild(panelOverlay);
}

/* ---------- 初始化 ---------- */

/** 挂关键词点击委托（document 级：story-text 每场景重建、绘本模式气泡也是动态节点，委托一劳永逸） */
export function initCodex(): void {
    document.addEventListener("click", (e) => {
        const span = (e.target as HTMLElement).closest?.(".codex-link") as HTMLElement | null;
        if (!span) return;
        e.stopPropagation(); // 不触发对话框的打字补完/推进
        openEntryById(pack().id, span.dataset.entry!);
    }, true); // capture：故事文本容器的 onclick 会先停冒泡，捕获阶段才能拿到
}
