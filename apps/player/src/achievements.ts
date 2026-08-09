// 成就系统：进场景即解锁，幂等，localStorage 持久化（M3 后同步服务端）
// 成就定义与场景绑定均在故事包内（story.json achievements[].unlockScene）
import { pack } from "./pack";
import type { AchievementDef } from "./story";

type AchievementState = AchievementDef & { unlocked: boolean };

const ACH_KEY = "taka_achievements";
let achievements: Record<string, AchievementState> = {};
let sceneAchievements: Record<string, string> = {}; // 场景 → 成就 id

/** 故事包加载后调用一次：从包内成就表建索引，并合并本机已解锁记录 */
export function initAchievementData(): void {
    achievements = {};
    sceneAchievements = {};
    for (const a of pack().achievements) {
        achievements[a.id] = { ...a, unlocked: false };
        sceneAchievements[a.unlockScene] = a.id;
    }
    // 读档：已解锁的 id 合并进定义
    try {
        (JSON.parse(localStorage.getItem(ACH_KEY) || "[]") as string[]).forEach(id => {
            if (achievements[id]) achievements[id].unlocked = true;
        });
    } catch {}
}

export function unlock(id: string): AchievementState | null {
    const a = achievements[id];
    if (!a || a.unlocked) return null;
    a.unlocked = true;
    localStorage.setItem(ACH_KEY, JSON.stringify(
        Object.keys(achievements).filter(k => achievements[k].unlocked)));
    renderAchievements();
    return a;
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
    const overlay = document.getElementById("ach-overlay")!;
    document.getElementById("ach-btn")!.onclick = () => {
        renderAchievements();
        overlay.hidden = !overlay.hidden;
    };
    overlay.onclick = () => { overlay.hidden = true; }; // 点遮罩关闭
    overlay.querySelector(".ach-modal")!.addEventListener("click", (e) => e.stopPropagation());
    renderAchievements();
}
