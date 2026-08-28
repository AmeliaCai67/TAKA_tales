// 如我所书（2026-08-19）：旅程存档系统前端
// - 旅程日志抽屉：故事页左上角 📖 打开，实时展示当前故事线的对话流（左滑抽屉）
// - 我的书架：主界面顶栏「我的书架」打开书书架（网格）→ 翻页阅读 → 导出有声书 MP3
import { api } from "./api";
import { session, selectedChild } from "./session";
import { pack } from "./pack";
import type { BookInfo, BookDetail } from "./api";
import { setDialogueListener } from "./engine";
import type { DialogueEv } from "./engine";
import { showStatus } from "./settings";
import { ICON_LOG } from "./icons";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function roleLabel(role: string): string {
    const m: Record<string, string> = {
        child: "你", taka: "塔卡", narrator: "旁白", seagull: "海鸥",
        oldmachine: "老机器", whale: "抹香鲸", rivet: "小钉", "rivet-calm": "小钉（平静）", recording: "录音",
    };
    return m[role] || role;
}

// ===== 旅程日志抽屉（故事页） =====

let drawer: HTMLElement | null = null;
let scrim: HTMLElement | null = null;
let logEntries: DialogueEv[] = [];
let drawerOpen = false;

export function initJourneyLog(): void {
    const btn = document.getElementById("log-btn");
    if (!btn) return;
    btn.innerHTML = ICON_LOG;
    btn.onclick = (e) => { e.stopPropagation(); toggleDrawer(); };
    setDialogueListener(evs => {
        logEntries.push(...evs);
        if (drawerOpen) renderLog();
    });
}

function closeDrawer(): void {
    if (drawer) drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    drawerOpen = false;
}

function toggleDrawer(): void {
    const d = drawer || (drawer = document.createElement("div"));
    if (!d.isConnected) {
        d.id = "journey-drawer";
        d.className = "journey-drawer";
        d.innerHTML = `
            <div class="jd-head"><span class="jd-title">旅 程</span><button class="jd-close">✕</button></div>
            <div class="jd-body"></div>`;
        (d.querySelector(".jd-close") as HTMLElement).onclick = (e) => {
            e.stopPropagation();
            closeDrawer();
        };
        d.querySelector(".jd-body")!.addEventListener("click", e => e.stopPropagation());
        // 遮罩：点抽屉外任意位置收起（移动端小屏友好），同时挡住底层故事区的误触
        scrim = document.createElement("div");
        scrim.className = "journey-scrim";
        scrim.hidden = true;
        scrim.onclick = () => closeDrawer();
        document.body.appendChild(scrim);
        d.hidden = true;  // 新建即隐藏，否则首次点击的反转变成「创建即关」（要点两次才开）
        document.body.appendChild(d);
    }
    const opening = d.hidden;
    d.hidden = !opening;
    if (scrim) scrim.hidden = !opening;
    drawerOpen = opening;   // 先切换，再记录打开态（否则打开后 drawerOpen=false，实时刷新失效）
    if (drawerOpen) renderLog();
}

function renderLog(): void {
    const d = drawer;
    if (!d) return;
    const body = d.querySelector(".jd-body")!;
    const story = pack().title;
    // 旅程日志 = 当前故事线层级（2026-08-27 修复串场）：只显示 pack().id 这一条故事线的对话，
    // 否则切故事后 logEntries 仍含上一故事内容 → 标题是《ch03》内容却是《ch02》（内容串掉）
    const rows = logEntries.filter(e => e.story_id === pack().id).map(e => {
        const cls = e.role === "child" ? "jd-child" : "jd-role";
        const icon = e.type === "freeinput" ? "🪶"
                    : e.type === "ai" ? "⭐"
                    : e.type === "choice" ? "⚡" : "";
        return `<div class="jd-row ${cls}">
            <span class="jd-icon">${icon}</span>
            <span class="jd-who">${roleLabel(e.role)}</span>
            <span class="jd-text">${esc(e.text)}</span>
        </div>`;
    }).join("");
    body.innerHTML = `<div class="jd-story">《${esc(story)}》<span class="jd-writing">书写中...</span></div>`
        + (rows || '<div class="jd-empty">旅途还没开始。</div>');
}

// ===== 我的书架（主界面） =====

let archiveOpen = false;
let currentBooks: BookInfo[] = [];

export function initArchive(): void {
    const close = document.getElementById("archive-close");
    if (close) close.onclick = () => closeArchive();
    const overlay = document.getElementById("archive-overlay");
    if (overlay) {
        overlay.onclick = () => closeArchive();       // 点遮罩关闭
        // 面板内点击不冒泡到遮罩（否则点书卡片/翻页会瞬间关闭弹窗）
        overlay.querySelector(".archive-panel")?.addEventListener("click", e => e.stopPropagation());
    }
}

/** 主界面顶栏「我的书架」→ 书书架（游客提示登录） */
export async function openArchive(): Promise<void> {
    if (!session.token || !session.childId) {
        showStatus("登录后就能看到你和塔卡写下的书了", 3000);
        return;
    }
    try {
        currentBooks = (await api.listBooks(session.childId!)).books;
    } catch { currentBooks = []; }
    const overlay = document.getElementById("archive-overlay");
    if (!overlay) return;
    archiveOpen = true;
    overlay.hidden = false;
    renderShelf();
}

/** 书标题 → 故事名：《第一次听见风声·第1版》 → 第一次听见风声 */
function storyName(title: string): string {
    return title.replace(/^《/, "").replace(/·第\d+版》$/, "").replace(/》$/, "");
}

/** 书架（树状改版 2026-08-25）：故事分组 → 版次行，行内直接「阅读 / 导出」 */
function renderShelf(): void {
    const box = document.getElementById("archive-body");
    if (!box) return;
    if (!currentBooks.length) {
        box.innerHTML = '<div class="ar-empty">还没有写完的书——<br>听完一个完整的故事，它就会出现在这里。</div>';
        return;
    }
    const groups: { storyId: string; name: string; cover: string; books: BookInfo[] }[] = [];
    for (const b of currentBooks) {
        let g = groups.find(x => x.storyId === b.story_id);
        if (!g) {
            g = { storyId: b.story_id, name: storyName(b.title), cover: b.cover, books: [] };
            groups.push(g);
        }
        g.books.push(b);
    }
    for (const g of groups) g.books.sort((a, b) => a.edition - b.edition);
    box.innerHTML = groups.map(g => `
        <div class="ar-group">
            <div class="ar-group-head">
                ${g.cover ? `<img class="ar-group-cover" src="stories/${g.storyId}/${g.cover}" alt="">` : ""}
                <span class="ar-group-name">《${esc(g.name)}》</span>
                <span class="ar-group-count">${g.books.length} 个版本</span>
            </div>
            ${g.books.map(b => `
            <div class="ar-row" data-id="${b.id}">
                <button class="ar-row-main" data-id="${b.id}">
                    <span class="ar-edition">第 ${b.edition} 版</span>
                    <span class="ar-row-meta">${fmtDate(b.finished_at)} · ${b.total_events} 句</span>
                    <span class="ar-state ${b.audio_status}">${stateLabel(b.audio_status)}</span>
                </button>
                <button class="ar-dl" data-id="${b.id}" title="导出有声书 MP3">导 出</button>
            </div>`).join("")}
        </div>`).join("");
    box.querySelectorAll<HTMLElement>(".ar-row-main").forEach(row => {
        row.addEventListener("click", () => void openBook(Number(row.dataset.id)));
    });
    box.querySelectorAll<HTMLElement>(".ar-dl").forEach(btn => {
        btn.addEventListener("click", () => void exportBookRow(Number(btn.dataset.id)));
    });
}

function stateLabel(s: string): string {
    return s === "ready" ? "🎧 已装订"
         : s === "pending" ? "装订中..."
         : s === "failed" ? "装订失败·点导出重试" : "待装订";
}

/** 行内导出（2026-08-25）：ready 直接下载；pending/failed → 触发装订后轮询，好了自动下载 */
async function exportBookRow(id: number): Promise<void> {
    const b = currentBooks.find(x => x.id === id);
    if (!b) return;
    if (b.audio_status === "ready") { void downloadBookAudio(id, b.title); return; }
    try {
        const r = await api.exportBook(id); // failed→重新装订；pending→已在装订
        b.audio_status = r.audio_status;
        renderShelf();
        if (r.audio_status === "ready") { void downloadBookAudio(id, b.title); return; }
        void pollAndDownload(id, b.title);
    } catch { showStatus("导出失败，请重试", 3000); }
}

async function pollAndDownload(id: number, title: string): Promise<void> {
    showStatus("装订中，好了自动开始下载", 3000);
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const d = await api.bookDetail(id);
            const b = currentBooks.find(x => x.id === id);
            if (b) b.audio_status = d.audio_status;
            if (d.audio_status === "ready") {
                if (archiveOpen) renderShelf();
                showStatus("装订完成", 2000);
                void downloadBookAudio(id, title);
                return;
            }
            if (d.audio_status === "failed") {
                if (archiveOpen) renderShelf();
                showStatus("装订失败，点导出可重试", 3500);
                return;
            }
        } catch { /* 网络抖动，继续等 */ }
    }
    showStatus("装订时间较长，稍后点导出即可", 3500);
}

/** 连续书页阅读器（2026-08-25 改版：一页一句 → 按场景分节的段落流，上下滚动） */
async function openBook(id: number): Promise<void> {
    const box = document.getElementById("archive-body");
    if (!box) return;
    let detail: BookDetail;
    try { detail = await api.bookDetail(id); }
    catch { showStatus("这本书打不开了", 3000); return; }
    const nickname = selectedChild()?.nickname || "你";
    // 正文：按场景分节；角色前缀着色（你=蓝 / 塔卡=暖黄 / 其他=灰）
    let body = "";
    let lastScene = "";
    for (const e of detail.events) {
        if (e.scene_key !== lastScene) {
            if (lastScene) body += '<div class="rl-break"></div>';
            lastScene = e.scene_key;
        }
        const who = e.role === "child" ? "你" : roleLabel(e.role);
        const cls = e.role === "child" ? "rl child" : e.role === "taka" ? "rl taka" : "rl";
        body += `<p class="${cls}"><span class="rl-who">${esc(who)}</span>${esc(e.text)}</p>`;
    }
    box.innerHTML = `<div class="ar-reader2">
        <div class="ar-r-head">
            <button class="ar-back">← 书架</button>
            <div class="ar-r-title">${esc(detail.title)}</div>
            <div class="ar-r-meta">${fmtDate(detail.finished_at)} · ${detail.total_events} 句 · <span class="ar-state ${detail.audio_status}">${stateLabel(detail.audio_status)}</span></div>
            <button class="pg-export" data-id="${id}">🎧 导出有声书（MP3）</button>
        </div>
        <div class="ar-r-body">${body || '<div class="jd-empty">这本书还没有内容。</div>'}</div>
        <div class="ar-r-foot">
            <div class="pg-end-title">本书由 ${esc(nickname)} 与塔卡共同书写</div>
            <button class="pg-export" data-id="${id}">🎧 导出有声书（MP3）</button>
        </div>
    </div>`;
    box.querySelector(".ar-back")!.addEventListener("click", () => renderShelf());
    box.querySelectorAll<HTMLElement>(".pg-export").forEach(exp => {
        exp.addEventListener("click", () => void exportBookRow(Number(exp.dataset.id)));
    });
}

/** 有声书下载：fetch + Bearer token 拿 blob 再触发下载（window.open 新标签不带 header → 401，且移动端易被拦截） */
async function downloadBookAudio(id: number, title: string): Promise<void> {
    if (!session.token) { showStatus("请先登录", 3000); return; }
    try {
        const res = await fetch(api.bookAudioUrl(id), {
            headers: { "Authorization": "Bearer " + session.token },
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (title || "有声书") + ".mp3";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showStatus("有声书已开始下载", 2500);
    } catch {
        showStatus("下载失败，请重试", 3000);
    }
}

function fmtDate(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 关闭我的书架（shelf 重渲时调用） */
export function closeArchive(): void {
    const overlay = document.getElementById("archive-overlay");
    if (overlay) overlay.hidden = true;
    archiveOpen = false;
}
