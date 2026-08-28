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
import { ICON_CODEX } from "./icons";
import { setBadge } from "./badge";

interface EntryState { d: boolean; u: boolean; } // discovered / unlocked
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
                state.set(KEY(e.story_id, e.entry_id), { d: true, u: !!e.unlocked_at });
        } catch { /* 离线降级：保持空态，本次游玩仍可正常打卡（写库各自重试） */ }
    } else {
        try {
            const raw = JSON.parse(localStorage.getItem(GUEST_LS) || "{}") as Record<string, EntryState>;
            for (const [k, v] of Object.entries(raw)) state.set(k, { d: !!v?.d, u: !!v?.u });
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
function mark(storyId: string, entryId: string, unlock: boolean): boolean {
    const k = KEY(storyId, entryId);
    const cur = state.get(k) || { d: false, u: false };
    const firstUnlock = unlock && !cur.u;
    cur.d = true;
    if (unlock) cur.u = true;
    state.set(k, cur);
    if (session.token && session.childId) {
        (unlock ? api.codexUnlock : api.codexDiscover)(session.childId, storyId, entryId).catch(() => {});
    } else {
        persistGuest();
        reportAnonEvent({ story_id: storyId, type: unlock ? "codex_unlock" : "codex_discover",
                          payload: { entry: entryId } });
    }
    return firstUnlock;
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
    if (!el || !scene.codex?.length) return;
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

/** 词条卡 TTS：科普走叙述者声线，塔卡说走塔卡声线（spec §3；/api/tts 无鉴权，游客可听） */
function toggleEntryTts(entry: CodexEntry, btn: HTMLElement): void {
    if (ttsAudio) { stopEntryTts(); return; }
    btn.classList.add("playing");
    btn.textContent = "■ 停止";
    const queue: [string, string][] = [
        [entry.science.join(""), "narrator"],
        [entry.takaSays.join(" "), "taka"],
    ];
    // 图鉴层（中优先）：开始播放时暂停故事剧情，结束/停止后自动恢复
    codexRelease = acquireAudio("codex", () => ttsAudio?.pause(), () => ttsAudio?.play());
    const playNext = async () => {
        const item = queue.shift();
        if (!item) { stopEntryTts(); resetTtsBtn(); return; }
        const a = new Audio(`${TTS_ENDPOINT}?text=${encodeURIComponent(item[0])}&who=${item[1]}`);
        ttsAudio = a;
        a.onended = () => void playNext();
        a.onerror = () => { stopEntryTts(); resetTtsBtn(); };
        try { await a.play(); } catch { stopEntryTts(); resetTtsBtn(); }
    };
    void playNext();
}

function resetTtsBtn(): void {
    const b = document.querySelector(".cc-tts");
    if (b) b.textContent = "🔊 听一听";
}

/** 打开词条卡（点关键词=打卡 / 点面板图标=补解锁，殊途同归）。imgSrc 需已拼好完整路径 */
export function openCodexCard(storyId: string, entry: CodexEntry, imgSrc: string): void {
    const firstUnlock = mark(storyId, entry.id, true);
    closeCodexCard();
    cardOverlay = document.createElement("div");
    cardOverlay.className = "codex-overlay codex-card-overlay";
    cardOverlay.innerHTML = `
        <div class="codex-card">
            <button class="cc-close" title="关闭">✕</button>
            <img class="cc-img" src="${escHtml(imgSrc)}" alt="${escHtml(entry.name)}">
            <div class="cc-body">
                <div class="cc-name">${escHtml(entry.name)}</div>
                <div class="cc-science">${entry.science.map(s => `<p>${escHtml(s)}</p>`).join("")}</div>
                <div class="cc-taka">
                    <span class="cc-taka-label">塔卡说</span>
                    ${entry.takaSays.map(s => `<p>「${escHtml(s)}」</p>`).join("")}
                </div>
                <button class="cc-tts">🔊 听一听</button>
                <div class="cc-src">图片：${escHtml(entry.source.author)} · ${escHtml(entry.source.license)} · <a href="${escHtml(entry.source.url)}" target="_blank" rel="noopener">Wikimedia Commons</a></div>
            </div>
        </div>`;
    cardOverlay.onclick = (e) => { if (e.target === cardOverlay) closeCodexCard(); };
    cardOverlay.querySelector(".cc-close")!.addEventListener("click", closeCodexCard);
    cardOverlay.querySelector(".cc-tts")!.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleEntryTts(entry, e.currentTarget as HTMLElement);
    });
    document.body.appendChild(cardOverlay);
    if (firstUnlock) { showStatus("已存入塔卡的记忆库", 2500); setBadge("codex", true); } // 记忆库更新 → 按钮亮橙黄点
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
        const entries = s.codexEntries || [];
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
                <img class="silhouette" src="${escHtml(e.image)}" alt=""><span>？？？</span>
                <em>塔卡好像见过这个…</em>
            </button>`;
        }).join("");
        const unlocked = entries.filter(e => state.get(KEY(s.id, e.id))?.u).length;
        const hint = hidden ? `<div class="cp-hint">还有 ${hidden} 段记忆，藏在故事里等着被发现。</div>` : "";
        if (!entries.length) return "";
        return `<div class="cp-story">
            <div class="cp-story-name">《${escHtml(s.title)}》<span class="cp-count">${unlocked}/${entries.length}</span></div>
            <div class="cp-grid">${tiles}</div>${hint}
        </div>`;
    }).join("");

    panelOverlay.innerHTML = `
        <div class="codex-panel">
            <div class="cp-head"><span class="cp-title">${ICON_CODEX}记 忆 库</span><button class="cc-close">✕</button></div>
            <div class="cp-body">${groups || '<div class="cp-empty">记忆库是空的。去读故事吧。</div>'}</div>
        </div>`;
    panelOverlay.onclick = (e) => { if (e.target === panelOverlay) closeCodexPanel(); };
    panelOverlay.querySelector(".cc-close")!.addEventListener("click", closeCodexPanel);
    panelOverlay.querySelectorAll<HTMLElement>(".cp-tile").forEach(t => {
        t.onclick = () => {
            const sid = t.dataset.story!, eid = t.dataset.entry!;
            const meta = stories.find(s => s.id === sid);
            const entry = meta?.codexEntries?.find(e => e.id === eid);
            if (entry) openCodexCard(sid, entry, entry.image); // index.json 的 image 已是完整路径
        };
    });
    document.body.appendChild(panelOverlay);
}

/* ---------- 初始化 ---------- */

/** 挂故事文本的关键词点击委托（story-text 每场景重建，委托一劳永逸） */
export function initCodex(): void {
    document.getElementById("story-text")!.addEventListener("click", (e) => {
        const span = (e.target as HTMLElement).closest?.(".codex-link") as HTMLElement | null;
        if (!span) return;
        e.stopPropagation(); // 不触发对话框的打字补完/推进
        openEntryById(pack().id, span.dataset.entry!);
    });
}
