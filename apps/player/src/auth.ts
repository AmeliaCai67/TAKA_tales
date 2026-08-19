// 家长入口：邮箱验证码登录 → 孩子档案选择/新建 → 断点续玩与成就上云
// 未登录完全可玩（本地存储），登录是「家长动作」，不挡孩子
import { pack } from "./pack";
import { ICON_PARENT } from "./icons";
import { api } from "./api";
import type { ChildInfo } from "./api";
import { session, setToken, setChild, clearSession } from "./session";
import { syncFromServer } from "./achievements";
import { setResumePoint } from "./engine";
import { showStatus } from "./settings";



function syncParentBtn(): void {
    const btn = document.getElementById("parent-btn")!;
    if (!btn.dataset.iconSet) { btn.innerHTML = ICON_PARENT; btn.dataset.iconSet = "1"; }
    // 已登录：chip 下拉是唯一家长枢纽，故事界面的「家长」入口隐藏（spec §2.4）；未登录保持可用
    btn.style.display = session.token ? "none" : "";
    const child = session.children.find(c => c.id === session.childId);
    btn.title = session.token
        ? "家长：" + session.email + (child ? " / " + child.nickname : "")
        : "家长入口";
}

/** 选中孩子后的回调（书架重渲用），main.ts 可注入 */
export let afterChildSelect: (() => void) | null = null;
export function setAfterChildSelect(fn: (() => void) | null): void { afterChildSelect = fn; }

/** 选中孩子：成就合并 + 拉断点 */
export async function selectChild(id: number): Promise<void> {
    setChild(id);
    await syncFromServer();
    try {
        const p = await api.loadProgress(id, pack().id);
        if (p.found && p.scene_key && p.scene_key !== pack().restartScene) {
            setResumePoint({ sceneKey: p.scene_key, battery: p.battery ?? 100, path: p.path ?? [] });
        } else {
            setResumePoint(null);
        }
    } catch { setResumePoint(null); }
    syncParentBtn();
    if (afterChildSelect) afterChildSelect();
}

/* ===== 弹窗两种状态渲染 ===== */

/** 关掉弹窗；若还在大门上，以游客身份进书架（记住选择，不再反复打扰） */
function dismissAsGuest(): void {
    localStorage.setItem("taka_guest", "1");
    document.getElementById("parent-overlay")!.hidden = true;
    document.getElementById("gate-btn")?.click(); // 大门还立着则顺势进入
}

function closeBtn(): string {
    return '<button class="pm-close" id="pm-close" title="关闭">✕</button>';
}

function bindClose(body: HTMLElement): void {
    body.querySelector("#pm-close")?.addEventListener("click", e => {
        e.stopPropagation();
        dismissAsGuest();
    });
}

/** 大门上完成「选孩子/建档」→ 关门进书架；故事/书架里则只重渲弹窗 */
function advanceIfOnGate(body: HTMLElement): void {
    const gateBtn = document.getElementById("gate-btn");
    if (gateBtn) {
        document.getElementById("parent-overlay")!.hidden = true;
        gateBtn.click();
        return;
    }
    renderLoggedIn(body);
}

function renderLoggedOut(body: HTMLElement): void {
    body.innerHTML = `
        ${closeBtn()}
        <div class="pm-note">邮箱验证码登录（内测）。登录后孩子的进度、成就会跟着账号走。</div>
        <input type="email" id="pm-email" placeholder="邮箱" autocomplete="email">
        <div class="pm-row">
            <input type="text" id="pm-code" placeholder="6 位验证码" maxlength="6" inputmode="numeric">
            <button id="pm-send">发送验证码</button>
        </div>
        <div class="pm-hint" id="pm-hint"></div>
        <button class="pm-main" id="pm-login">登 录</button>
        <button class="pm-guest" id="pm-guest">先随便逛逛（游客模式，进度只存在这台设备上）</button>`;
    bindClose(body);
    body.querySelector("#pm-guest")!.addEventListener("click", e => {
        e.stopPropagation();
        dismissAsGuest();
    });
    const hint = body.querySelector("#pm-hint")!;
    let devCode = "";
    body.querySelector("#pm-send")!.addEventListener("click", async () => {
        const email = (body.querySelector("#pm-email") as HTMLInputElement).value.trim();
        if (!email) return;
        hint.textContent = "发送中...";
        try {
            const r = await api.sendCode(email);
            devCode = r.dev_code || "";
            hint.textContent = r.sent ? "已发送，请查收邮箱"
                                      : "开发模式验证码：" + devCode; // SMTP 未配置时回显
        } catch (e: any) { hint.textContent = "发送失败：" + e.message; }
    });
    body.querySelector("#pm-login")!.addEventListener("click", async () => {
        const email = (body.querySelector("#pm-email") as HTMLInputElement).value.trim();
        const code = (body.querySelector("#pm-code") as HTMLInputElement).value.trim();
        if (!email || !code) return;
        try {
            const r = await api.verify(email, code);
            setToken(r.token);
            session.email = email;
            await refreshMe();
            renderLoggedIn(body);
            syncParentBtn();
        } catch (e: any) { hint.textContent = e.message; }
    });
}

function renderLoggedIn(body: HTMLElement): void {
    const rows = session.children.map(c =>
        `<button class="pm-child${c.id === session.childId ? " active" : ""}" data-id="${c.id}">` +
        `${c.nickname}<span class="pm-band">${c.age_band} 岁</span></button>`).join("");
    body.innerHTML = `
        ${closeBtn()}
        <div class="pm-note">${session.email}</div>
        <div class="pm-label">谁在玩？</div>
        <div class="pm-children">${rows || '<div class="pm-hint">还没有孩子档案，加一个吧</div>'}</div>
        <div class="pm-row">
            <input type="text" id="pm-nick" placeholder="孩子昵称" maxlength="12">
            <select id="pm-band"><option>3-4</option><option>4-5</option><option>5-6</option></select>
            <button id="pm-add">＋</button>
        </div>
        <button class="pm-main pm-logout" id="pm-logout">退出登录</button>`;
    bindClose(body);
    body.querySelectorAll(".pm-child").forEach(b =>
        b.addEventListener("click", async () => {
            await selectChild(Number((b as HTMLElement).dataset.id));
            advanceIfOnGate(body);
        }));
    body.querySelector("#pm-add")!.addEventListener("click", async () => {
        const nick = (body.querySelector("#pm-nick") as HTMLInputElement).value.trim();
        const band = (body.querySelector("#pm-band") as HTMLSelectElement).value;
        if (!nick) return;
        try {
            const c = await api.createChild(nick, band);
            session.children.push(c);
            await selectChild(c.id);
            advanceIfOnGate(body);
        } catch (e: any) { showStatus(e.message, 3000); }
    });
    body.querySelector("#pm-logout")!.addEventListener("click", () => {
        clearSession();
        session.children = [];
        setResumePoint(null);
        renderLoggedOut(body);
        syncParentBtn();
    });
}

async function refreshMe(): Promise<void> {
    const r = await api.me();
    session.email = r.parent.email;
    session.children = r.children;
}

/** 打开家长弹窗（登录/档案/退出）。导出给大门：未登录点「听风声」先弹这个 */
export async function openParentModal(): Promise<void> {
    const overlay = document.getElementById("parent-overlay")!;
    const body = document.getElementById("parent-body")!;
    overlay.hidden = false;
    if (session.token) {
        try { await refreshMe(); renderLoggedIn(body); }
        catch { clearSession(); renderLoggedOut(body); } // token 过期
    } else {
        renderLoggedOut(body);
    }
}

/** 启动时静默恢复登录态：有 token 拉 me；唯一孩子自动选中；多孩子等家长在弹窗里选 */
export async function initAuth(): Promise<void> {
    const overlay = document.getElementById("parent-overlay")!;
    document.getElementById("parent-btn")!.onclick = openParentModal;
    // 启动门上的家长入口（家长先登录再递给孩子）；阻止冒泡触发大门开播
    const gateParent = document.getElementById("gate-parent");
    if (gateParent) gateParent.onclick = (e) => { e.stopPropagation(); void openParentModal(); };
    overlay.onclick = () => { overlay.hidden = true; };
    overlay.querySelector(".ach-modal")!.addEventListener("click", e => e.stopPropagation());
    syncParentBtn();

    if (!session.token) return;
    try {
        await refreshMe();
        const saved = session.children.find(c => c.id === session.childId);
        if (saved) await selectChild(saved.id);
        else {
            // 原选中档案已不在（被删/进回收站）：清掉残留 childId，回落「选择孩子」；唯一孩子则直接选中
            setChild(null);
            if (session.children.length === 1) await selectChild(session.children[0].id);
        }
        syncParentBtn();
    } catch {
        clearSession(); // token 失效，安静退回未登录
        syncParentBtn();
    }
}
