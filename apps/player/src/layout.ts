import { loadLayoutPref } from './settings';
import { setBookMode, isBookMode } from './engine';

// ===== 横屏绘本模式分派（2026-08-31）：宽度阈值制（折叠屏展开自动覆盖），设置三档可强制 =====
// 阈值 700 实测依据：iPhone 17 横屏 innerWidth=750（不是规格表的 874——Safari 会扣掉竖排时代理的宽度），
// 竖屏 402；iPad mini 竖屏 744；折叠屏展开 717+。700 把手机横屏/平板/折叠屏全部收进绘本，手机竖屏留 VN。
const BOOK_MIN_WIDTH = 700;
const NO_HINT_KEY = "taka_no_rotate_hint";

export function computeBookMode(): boolean {
    const pref = loadLayoutPref();
    if (pref === "book") return true;
    if (pref === "vn") return false;
    return window.innerWidth >= BOOK_MIN_WIDTH;
}

/** 窄屏进故事弹「横屏更佳」（不阻塞；勾选不再提示后永久免打扰） */
function maybeRotateHint(): void {
    if (window.innerWidth >= BOOK_MIN_WIDTH || localStorage.getItem(NO_HINT_KEY)) return;
    const el = document.getElementById("rotate-hint")!;
    el.hidden = false;
    document.getElementById("rh-ok")!.onclick = () => {
        if ((document.getElementById("rh-never") as HTMLInputElement).checked) {
            localStorage.setItem(NO_HINT_KEY, "1");
        }
        el.hidden = true;
    };
}

/** 进故事前判定模式；窄屏顺带提示。每次 pickStory 重判（折叠屏在书架页展开/收起后生效） */
export function applyLayout(offerRotateHint = true): void {
    setBookMode(computeBookMode());
    if (!isBookMode() && offerRotateHint) maybeRotateHint();
}
