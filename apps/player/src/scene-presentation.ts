// Figure, background transition and typewriter DOM; no narrative/session state.
import { pack } from './pack';
let typing: ReturnType<typeof setInterval> | null = null;
export function stopTyping(): void {
    if (typing) clearInterval(typing);
    typing = null;
    document.getElementById('dialog')!.onclick = null;
}

export function setFigureState(state: string): void {
    const f = document.getElementById("taka-figure")!;
    // 保留场景级类（2026-09-28：collect 场景的像素塔卡 px-mode/px-swim/px-scan/px-interested 不被眼部状态机冲掉）
    const keep = [...f.classList].filter(c => c.startsWith("px-")).join(" ");
    f.className = ("taka-figure " + state + " " + keep).trim();
}

// 双模式：水下 = 收腿悬浮（takaBodySwim），陆地 = 伸腿站立（takaBody）
export function setFigureMode(mode: "swim" | "land"): void {
    const use = document.querySelector<SVGUseElement>("#taka-figure .takaBody use")!;
    use.setAttribute("href", mode === "swim" ? "#takaBodySwim" : "#takaBody");
}

// ===== 场景背景图：双层交叉淡化；scene.background 缺省 = 保持上一场景 =====
let bgFront: HTMLElement | null = null; // 当前显示层（a/b 轮换）
let bgCurrent = "";                    // 当前图片完整 URL（去重用）

/** 采样背景图顶部条带（顶栏按钮/HUD 所在区域）亮度：亮底自动切深色 UI（on-light-bg）
 *  2026-09：原判据用 BT.709 相对亮度 + 阈值 150，会把 ch02 海底/浅海这类「顶部偏亮的蓝海景」
 *  （实测 142-149）误判成暗底，浅色图标在亮蓝海景上几乎看不见。改用 BT.601 感知亮度
 *  （0.299R/0.587G/0.114B，对蓝色海景更贴人眼明感）+ 阈值降到 135，让亮蓝海景稳定判亮。
 *  注意：书台模式（book-mode）整屏两侧被书壳阴影+压暗层压低、整体偏暗，on-light-bg 会把图标
 *  误判成深色，故书台模式由 CSS 单独强制浅色（见 styles.css body.book-mode …），不依赖本采样。 */
function adaptChrome(img: HTMLImageElement): void {
    try {
        const w = 48, h = 10;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.16, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4)
            sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; // BT.601 感知亮度
        document.body.classList.toggle("on-light-bg", sum / (d.length / 4) > 135);
    } catch { /* 采样失败保持默认深色 UI */ }
}

/** 移动端 WebKit：背景淡入后立绘 SVG 里的 filter: url(#tk-edge/#tk-grain) 会失效，
 *  表现是机身（渐变填充 + 内层噪点滤镜的 rect）整块不画，只剩描边。
 *  2026-11-01 真机（微信 8.0.79）确认：重建一次节点，色块立刻回来——与「切横屏再切回」
 *  的恢复现象同源（都是重新解析 SVG）。这里只在背景真的换了之后重建，开销是一次 DOM clone。 */
function rebuildFigureSvg(): void {
    const host = document.getElementById("taka-figure");
    const svg = host?.querySelector("svg");
    if (!host || !svg) return;
    host.replaceChild(svg.cloneNode(true), svg);
}

export function setBackground(rel?: string): void {
    if (!rel) return;
    const url = pack().baseUrl + rel;
    if (url === bgCurrent) return;
    bgCurrent = url;
    const a = document.getElementById("bg-a")!;
    const b = document.getElementById("bg-b")!;
    if (!bgFront) bgFront = a;
    const back = bgFront === a ? b : a;
    const img = new Image(); // 先预载，加载完再淡入，避免白闪
    img.onload = () => {
        if (bgCurrent !== url) return;
        back.style.backgroundImage = `url("${url}")`;
        back.classList.add("show");
        bgFront!.classList.remove("show");
        bgFront = back;
        adaptChrome(img);
        rebuildFigureSvg();
    };
    img.src = url;
}

export function typeText(text: string, onDone: () => void): void {
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
