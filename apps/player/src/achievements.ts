// 成就系统：进场景即解锁，幂等，localStorage 持久化（M3 后同步服务端）
// 成就定义与场景绑定均在故事包内（story.json achievements[].unlockScene）
import { pack } from "./pack";
import { ICON_ACHIEVEMENT } from "./icons";
import type { AchievementDef } from "./story";
import { loadStoriesIndex } from "./story";
import { api } from "./api";
import { session, wasGuestAtLoad } from "./session";
import { t, lang } from "./i18n";
import { reportAnonEvent } from "./anon";
import { setBadge } from "./badge";

type AchievementState = AchievementDef & { unlocked: boolean };

/** 成就本地池按「孩子 / 游客」隔离（2026-08-30 修复：避免新建孩子继承其他孩子/游客的成就）。
 *  对齐 progress.ts 的 `taka_prog_*_<childId ?? "guest">`。服务端 achievements 表始终是唯一真源。 */
function achKey(): string {
    return "taka_achievements_" + (session.childId ?? "guest");
}
const GUEST_KEY = "taka_achievements_guest";
const LEGACY_KEY = "taka_achievements"; // 旧版全局池（无后缀），仅用于一次性迁入游客池
let guestCarried = false; // 本页面会话是否已做过「游客→登录」携带（只带一次）

let achievements: Record<string, AchievementState> = {};
let sceneAchievements: Record<string, string> = {}; // 场景 → 成就 id

/** 当前池已解锁 id 集（跨故事累加，只增不减——2026-08-15 前按当前包覆写会丢其他故事的档） */
function readUnlockedIds(): string[] {
    try { return JSON.parse(localStorage.getItem(achKey()) || "[]") as string[]; }
    catch { return []; }
}
function writeUnlockedIds(ids: string[]): void {
    localStorage.setItem(achKey(), JSON.stringify([...new Set(ids)]));
}

/** 当前池已解锁 id（只读出口：书架卡片计数等外部展示用）。
 *  ⚠️ 外部一律走这个函数，不要自己拼 localStorage key——2026-08-30 起成就池按
 *  「孩子 / 游客」隔离（`taka_achievements_<childId ?? guest>`），旧全局 key 已废弃。 */
export function unlockedAchievementIds(): string[] {
    return readUnlockedIds();
}

/** 旧版全局池 → 游客池一次性迁移（启动时调用；仅未登录时迁，避免误归属到具体孩子）。幂等。 */
export function migrateLegacyAchievements(): void {
    if (session.token) return; // 已登录：真实玩家成就由服务端拉回，不迁旧全局池
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    try {
        const ids = JSON.parse(legacy) as string[];
        if (!ids.length) { localStorage.removeItem(LEGACY_KEY); return; }
        const cur = new Set<string>(JSON.parse(localStorage.getItem(GUEST_KEY) || "[]"));
        ids.forEach(id => cur.add(id));
        localStorage.setItem(GUEST_KEY, JSON.stringify([...cur]));
        localStorage.removeItem(LEGACY_KEY);
    } catch { /* 旧数据非法则丢弃 */ }
}

/** 游客→登录一次性携带：把游客池并入【首个被选中的孩子】的池，然后清空游客池。
 *  之后新建的第二个孩子不再携带（_guest 已被消费）→ 该孩子从 0 开始。
 *  仅在「页面原本是游客态」且登录后首次 selectChild 时触发。 */
export function carryGuestAchievements(childId: number): void {
    if (!session.token || guestCarried) return;
    if (!wasGuestAtLoad) return; // 页面加载时已登录（老账号/恢复会话），不做游客携带
    try {
        const guestIds = JSON.parse(localStorage.getItem(GUEST_KEY) || "[]") as string[];
        if (!guestIds.length) return;
        const childKey = "taka_achievements_" + childId;
        const cur = new Set<string>(JSON.parse(localStorage.getItem(childKey) || "[]"));
        guestIds.forEach(id => cur.add(id));
        localStorage.setItem(childKey, JSON.stringify([...cur]));
        localStorage.removeItem(GUEST_KEY);
        guestCarried = true;
    } catch { /* 游客池非法则跳过 */ }
}

/** 故事包加载后调用一次：从包内成就表建索引，并合并本机已解锁记录 */
export function initAchievementData(): void {
    achievements = {};
    sceneAchievements = {};
    for (const a of pack().achievements) {
        achievements[a.id] = { ...a, unlocked: false };
        sceneAchievements[a.unlockScene] = a.id;
    }
    // 读档：已解锁的 id 合并进定义
    const unlocked = new Set(readUnlockedIds());
    unlocked.forEach(id => { if (achievements[id]) achievements[id].unlocked = true; });
}

/** 云端同步（登录且选孩子才发）。带重试 + 可见日志，避免静默丢失（曾致成就永久从 server 缺失）。
 *  最终仍失败则 console.error + toast 提示「成就同步失败」，本地仍是真源，留待对账补录。 */
async function pushUnlock(id: string, attempt = 0): Promise<boolean> {
    if (!session.token || !session.childId) return false;
    try {
        await api.unlockAchievement(session.childId, id);
        return true;
    } catch (e) {
        if (attempt < 2) {
            await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
            return pushUnlock(id, attempt + 1);
        }
        console.error("[achievements] 云端同步失败，已本地记录待对账:", id, e);
        try {
            showToast(t("ach.toast_sync_fail", { name: achievements[id]?.name || id }));
        } catch {}
        return false;
    }
}

export function unlock(id: string): AchievementState | null {
    const a = achievements[id];
    if (!a || a.unlocked) return null;
    a.unlocked = true;
    writeUnlockedIds([...readUnlockedIds(), id]); // 并入全局集，不覆写
    renderAchievements();
    setBadge("ach", true); // 成就更新 → 「成 就」按钮亮橙黄点
    if (session.token && session.childId) {
        void pushUnlock(id); // 异步重试，不阻塞场景
    } else {
        // 游客：成就事件（匿名记录）
        reportAnonEvent({ story_id: pack().id, type: "achievement", payload: { achievement_id: id } });
    }
    return a;
}

/** 选中孩子后拉服务端成就合并进本地（不回弹 toast）；并对账：本地有、server 缺的补 POST（自愈） */
export async function syncFromServer(): Promise<void> {
    if (!session.token || !session.childId) return;
    try {
        const r = await api.listAchievements(session.childId);
        const serverIds = r.achievements.map(x => x.id);
        const before = readUnlockedIds();
        writeUnlockedIds([...before, ...serverIds]); // 全局并集，不丢其他故事
        let changed = false;
        for (const id of serverIds) {
            const a = achievements[id];
            if (a && !a.unlocked) { a.unlocked = true; changed = true; }
        }
        // 对账：本地已解锁（本故事包内）但 server 缺失 → 补 POST（静默丢失的自愈）
        const serverSet = new Set(serverIds);
        for (const id of readUnlockedIds()) {
            if (serverSet.has(id)) continue;
            if (!achievements[id]) continue;      // 非本包成就（其他故事），跳过
            if (!achievements[id].unlocked) continue;
            void pushUnlock(id);
        }
        if (changed) renderAchievements();
    } catch (e) {
        console.error("[achievements] syncFromServer 失败:", e);
    }
}

/** 引擎进场景时调用：该场景绑定了成就则解锁，返回解锁的成就（未解锁过才非 null） */
export function unlockForScene(sceneId: string): AchievementState | null {
    const achId = sceneAchievements[sceneId];
    return achId ? unlock(achId) : null;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(html: string): void {
    const t = document.getElementById("toast")!;
    t.innerHTML = html;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// 成就弹窗列表：未解锁置灰（名字不遮，demo 需要可见）
function renderAchievements(): void {
    const box = document.getElementById("ach-list");
    if (!box) return;
    box.innerHTML = Object.values(achievements).map(a =>
        `<div class="ach-item${a.unlocked ? "" : " locked"}">` +
        `<span class="ach-icon">${a.icon}</span><div>` +
        `<div class="ach-name">${a.name}</div><div class="ach-desc">${a.desc}</div>` +
        `</div></div>`
    ).join("");
}

export function initAchievements(): void {
    document.getElementById("ach-btn")!.innerHTML = ICON_ACHIEVEMENT;
    document.getElementById("ach-btn")!.onclick = () => void openAchWall();
    // 成就墙：整页覆盖，点遮罩/✕ 关闭
    const wall = document.getElementById("ach-wall")!;
    wall.onclick = () => { wall.hidden = true; };
    wall.querySelector(".ach-wall-panel")!.addEventListener("click", (e) => e.stopPropagation());
    wall.querySelector("#aw-close")!.addEventListener("click", () => { wall.hidden = true; });
    renderAchievements();
}

/** 成就墙：按故事分节展示全宇宙成就（index.json 内联定义 + 全局解锁集） */
export async function openAchWall(): Promise<void> {
    const wall = document.getElementById("ach-wall")!;
    const bodyEl = document.getElementById("ach-wall-body")!;
    wall.hidden = false;
    bodyEl.innerHTML = `<div class="ach-wall-loading">${t("ach.wall_loading")}</div>`;
    const stories = await loadStoriesIndex();
    const unlocked = new Set(readUnlockedIds());
    bodyEl.innerHTML = stories.map(s => {
        // i18n：en 模式用 alt.en 的成就表和标题（2026-08-28 修：成就墙没跟语言走）
        const achs = (lang === "en" ? (s.alt?.en?.achievements || s.achievements) : s.achievements) || [];
        const sTitle = lang === "en" ? (s.alt?.en?.title || s.title) : s.title;
        const got = achs.filter(a => unlocked.has(a.id)).length;
        const rows = achs.map(a => `
            <div class="aw-item${unlocked.has(a.id) ? "" : " locked"}">
                <span class="aw-icon">${a.icon}</span>
                <span class="aw-text"><span class="aw-name">${a.name}</span>
                <span class="aw-desc">${a.desc}</span></span>
                <span class="aw-state">${unlocked.has(a.id) ? "✓" : ""}</span>
            </div>`).join("");
        return `<div class="aw-story">
            <div class="aw-story-head"><span class="aw-title">${lang === "en" ? sTitle : `《${sTitle}》`}</span>
            <span class="aw-count">${got}/${achs.length}</span></div>
            ${rows}
        </div>`;
    }).join("");
}
