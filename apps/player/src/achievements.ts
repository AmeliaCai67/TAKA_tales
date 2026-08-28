// 成就系统：进场景即解锁，幂等，localStorage 持久化（M3 后同步服务端）
// 成就定义与场景绑定均在故事包内（story.json achievements[].unlockScene）
import { pack } from "./pack";
import { ICON_ACHIEVEMENT } from "./icons";
import type { AchievementDef } from "./story";
import { loadStoriesIndex } from "./story";
import { api } from "./api";
import { session } from "./session";
import { reportAnonEvent } from "./anon";
import { setBadge } from "./badge";

type AchievementState = AchievementDef & { unlocked: boolean };

const ACH_KEY = "taka_achievements";
let achievements: Record<string, AchievementState> = {};
let sceneAchievements: Record<string, string> = {}; // 场景 → 成就 id

/** 全局已解锁 id 集（跨故事累加，只增不减——2026-08-15 前按当前包覆写会丢其他故事的档） */
function readUnlockedIds(): string[] {
    try { return JSON.parse(localStorage.getItem(ACH_KEY) || "[]") as string[]; }
    catch { return []; }
}
function writeUnlockedIds(ids: string[]): void {
    localStorage.setItem(ACH_KEY, JSON.stringify([...new Set(ids)]));
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
            showToast("成就「" + (achievements[id]?.name || id) + "」同步失败，重进将自动补录");
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
    bodyEl.innerHTML = '<div class="ach-wall-loading">珊瑚正在数…</div>';
    const stories = await loadStoriesIndex();
    const unlocked = new Set(readUnlockedIds());
    bodyEl.innerHTML = stories.map(s => {
        const achs = s.achievements || [];
        const got = achs.filter(a => unlocked.has(a.id)).length;
        const rows = achs.map(a => `
            <div class="aw-item${unlocked.has(a.id) ? "" : " locked"}">
                <span class="aw-icon">${a.icon}</span>
                <span class="aw-text"><span class="aw-name">${a.name}</span>
                <span class="aw-desc">${a.desc}</span></span>
                <span class="aw-state">${unlocked.has(a.id) ? "✓" : ""}</span>
            </div>`).join("");
        return `<div class="aw-story">
            <div class="aw-story-head"><span class="aw-title">《${s.title}》</span>
            <span class="aw-count">${got}/${achs.length}</span></div>
            ${rows}
        </div>`;
    }).join("");
}
