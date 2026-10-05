// 动态 TTS 句级切分（2026-10-03 流水线，plan: docs/superpowers/plans/2026-10-03-dynamic-tts-sentence-pipeline.md）
// 纯函数零依赖——speech.ts 引用，也可直接 node 跑断言用例（test/tts-sentence.test.mjs，node≥23 原生吃 TS）。
// 设计约束：不用正则 lookbehind（老 Safari/WKWebView 在正则编译期就崩，本仓移动内核跨度大）。

/** 单句渲染时长与句长正相关：软上限，超过在逗号/顿号兜底切（防一整句逗号连到底渲太久） */
const SOFT_LIMIT = 40;
const BREAKS = "，、,";

/** 句读切分：句末标点（中英）+ 无歧义闭合符跟切；无句读的尾巴整段成句。
 *  ⚠ ASCII 直引号 "/' 开闭对称不入闭合类——会挂到下一句前缀，cleanForSpeech 反正剥引号，音频无差 */
const SENT_RE = /[^。！？…；.!?]*[。！？…；.!?]+[」”』）)]*|[^。！？…；.!?]+/g;
/** 纯标点句（孤立省略号/句号堆）丢弃——TTS 念不了，白烧一次渲染 */
const PUNCT_ONLY = /^[。！？…；.!?，、,；;：:（）()「」『』""''“”‘’—·\s\-]+$/;

/** 逗号兜底切：贪心凑到软上限；标点留在前段（TTS 自然停顿），无标点的超长尾巴整段保留 */
function softSplit(s: string): string[] {
    const out: string[] = [];
    let start = 0, cut = -1;
    for (let i = 0; i < s.length; i++) {
        if (BREAKS.includes(s[i])) cut = i + 1;
        if (i + 1 - start >= SOFT_LIMIT && cut > start) {
            out.push(s.slice(start, cut));
            start = cut;
        }
    }
    if (start < s.length) out.push(s.slice(start));
    return out;
}

/** 段内切句：归属（who）由调用方继承所在段；返回非空句数组 */
export function splitSentences(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(SENT_RE)) {
        const s = m[0].trim();
        if (!s || PUNCT_ONLY.test(s)) continue;
        if (s.length <= SOFT_LIMIT) out.push(s);
        else out.push(...softSplit(s));
    }
    return out;
}
