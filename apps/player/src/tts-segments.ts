// 故事文本 → 逐句归属段（与 packages/tts-pipeline/tts_pipeline/segments.py 严格镜像）。
// 2026-10-12 从 speech.ts 抽出为纯模块（不 import 仓库其他模块，可独立 esbuild 测试），
// 并补齐英文解析：此前客户端只有中文式「名+冒号+紧贴引号」一条正则，LLM 生成的英文
// （TAKA says, "…" / Seagull says, "…" / 弯引号 / 后置归属）全部塌给 narrator——
// 现移植 segments.py 的 parse_scene_en 状态机（后置归属/裸引号交替/提及推断/所有格发声）。
// 引号对在 segments.py 直引号基础上扩弯引号 “”（LLM 动态生成实测弯引号；静态包为直引号，
// 扩展是超集，双边已同步保持镜像）。
// ⚠ 不用 lookbehind——老 Safari/WKWebView 正则编译期崩（仓库规矩）。

export type Seg = { who: string; text: string };

const EN_SPEECH_VERBS = ("says|said|asks|asked|calls|called|shouts|shouted|whispers|whispered|" +
    "replies|replied|tells|told|cries|cried|answers|answered|mutters|muttered");

// 英文引号开/闭字符类（直 + 弯；镜像扩展见文件头）
const EN_Q_OPEN = '["\u201c]';
const EN_Q_CLOSE = '["\u201d]';

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 对话归属正则（segments.py _dialog_re 镜像）：
 *  zh：角色名 + 最多 8 字引导 + 冒号 + 引号定界台词；
 *  en：Name: "…" / Name says, "…" / The Old Machine calls, weak and far. "…"——
 *      大小写不敏感 + 容忍 The 前缀 + 引语前 ≤40 字符必须含发言动词（防纯叙述误配） */
export function dialogRe(speakers: Record<string, string>, lang: "zh" | "en"): RegExp {
    const names = Object.keys(speakers).map(escapeRe).join("|");
    if (lang === "en") {
        return new RegExp(
            "(?:the\\s+)?(" + names + ")(\\s*:\\s*|(?=[^\\u201c\"]{0,40}?\\b(?:" + EN_SPEECH_VERBS + ")\\b)[^\\u201c\"]{0,40}?)\\s*" +
            EN_Q_OPEN + "([^\\u201d\"]+?)" + EN_Q_CLOSE, "i");
    }
    // 冒号后允空格（2026-10-13：LLM 中文生成实测「塔卡说： “…”」，此前全段塌 narrator）
    return new RegExp("(" + names + ")([^：:]{0,8})[：:]\\s*[\"「“『]([^\"」”』]+?)[\"」”』]");
}

// 插话式台词的引号对（zh 四种括号引号 + en 直/弯引号），用于 outro 拆分
const QUOTE_PAIR: Record<"zh" | "en", RegExp> = {
    zh: /["「“『]([^"」”』]+?)["」”』]/g,
    en: new RegExp(EN_Q_OPEN + "([^\\u201d\"]+?)" + EN_Q_CLOSE, "g"),
};

function stripChars(s: string, chars: string): string {
    let a = 0, b = s.length;
    while (a < b && chars.includes(s[a])) a++;
    while (b > a && chars.includes(s[b - 1])) b--;
    return s.slice(a, b);
}

/** 引语后余文的插话式拆分（segments.py _outro_segs 镜像）：
 *  叙述插条归旁白，裸引号台词续归同一说话人 */
function outroSegs(outro: string, who: string, defaultWho: string, lang: "zh" | "en"): Seg[] {
    const segs: Seg[] = [];
    let pos = 0;
    for (const m of outro.matchAll(QUOTE_PAIR[lang])) {
        if (outro.slice(pos, m.index).trim()) segs.push({ who: defaultWho, text: outro.slice(pos, m.index).trim() });
        segs.push({ who, text: m[1] });
        pos = m.index! + m[0].length;
    }
    const tail = outro.slice(pos).trim();
    if (tail) segs.push({ who: defaultWho, text: tail });
    return segs;
}

/* ===== zh 三段式（segments.py parse_paragraph 镜像） ===== */

function parseParagraphZh(p: string, re: RegExp, speakers: Record<string, string>,
                          overrides?: Record<string, string>): Seg[] {
    const m = re.exec(p);
    if (!m) return [{ who: "narrator", text: p }];
    let intro = (p.slice(0, m.index) + m[1] + m[2]).trim();
    if (intro === m[1]) intro = m[1] + "说";
    const outro = p.slice(m.index! + m[0].length).trim();
    const segs: Seg[] = [];
    if (intro) segs.push({ who: "narrator", text: intro });
    const who = (overrides && overrides[m[1]]) || speakers[m[1]] || "narrator";
    segs.push({ who, text: m[3] });
    if (outro) {
        if (re.test(outro)) segs.push(...parseParagraphZh(outro, re, speakers, overrides));
        else segs.push(...outroSegs(outro, who, "narrator", "zh"));
    }
    return segs;
}

/* ===== en 状态机（segments.py parse_scene_en 全量移植） ===== */

// 后置归属："To what?" asks the seagull.（引号在前，名字在后；引号后可带逗号）
const EN_POSTPOSED_RE = new RegExp(
    EN_Q_OPEN + "([^\\u201d\"]+?)" + EN_Q_CLOSE + "\\s*[,:]?\\s*(?:" + EN_SPEECH_VERBS + ")\\s+" +
    "((?:the\\s+)?[A-Za-z][A-Za-z0-9 ]{0,20}?)[.!]?\\s*$", "i");
// 旁白块归属锚：动词+角色名句尾
const EN_ATTR_RE = new RegExp(
    "(?:" + EN_SPEECH_VERBS + ")\\s+((?:the\\s+)?[A-Za-z][A-Za-z0-9 ]{0,20}?)[.!]?\\s*$", "i");

function commonPrefixLen(a: string, b: string): number {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) break;
        n++;
    }
    return n;
}

function enSpeakerOf(name: string, speakers: Record<string, string>): string | null {
    const n = name.trim().replace(/^the\s+/i, "").toLowerCase();
    for (const [k, v] of Object.entries(speakers)) {
        if (k.toLowerCase() === n) return v;
    }
    return null;
}

function enMentions(para: string, speakers: Record<string, string>): Array<[number, string]> {
    const low = para.toLowerCase();
    const out: Array<[number, string]> = [];
    for (const [k, v] of Object.entries(speakers)) {
        const i = low.indexOf(k.toLowerCase());
        if (i >= 0) out.push([i, v]);
    }
    for (const [k, v] of Object.entries(speakers)) {
        const kl = k.toLowerCase();
        if (kl.includes(" ") || out.some(([, w]) => w === v)) continue;
        for (const m of low.matchAll(/[a-z]+/g)) {
            if (m[0] !== kl && commonPrefixLen(m[0], kl) >= 5) {
                out.push([m.index!, v]);
                break;
            }
        }
    }
    return out.sort((a, b) => a[0] - b[0]);
}

/** 连续旁白块的归属（segments.py _en_block_speaker 镜像）：
 *  从最近一段往前找提及——第一个被提及角色非塔卡就用它；是塔卡则取块内离引号最近的非塔卡
 *  （塔卡主角出场率最高，不能当信号）。块内无非塔卡才回退塔卡。 */
function enBlockSpeaker(block: string[], speakers: Record<string, string>): string | null {
    for (const para of [...block].reverse()) {
        const mentions = enMentions(para, speakers);
        if (!mentions.length) continue;
        if (mentions[0][1] !== "taka") return mentions[0][1];
        for (const p2 of [...block].reverse()) {
            for (const [, w] of enMentions(p2, speakers)) {
                if (w !== "taka") return w;
            }
        }
        return "taka";
    }
    return null;
}

/** 引号开头段落拆 quote/text 交替段（segments.py _en_quote_spans 镜像） */
function enQuoteSpans(p: string): Array<["quote" | "text", string]> {
    const spans: Array<["quote" | "text", string]> = [];
    let pos = 0;
    const re = new RegExp(EN_Q_OPEN + "([^\\u201c\\u201d]*?)" + EN_Q_CLOSE, "g");
    for (const m of p.matchAll(re)) {
        if (m.index! > pos) spans.push(["text", p.slice(pos, m.index)]);
        spans.push(["quote", m[1]]);
        pos = m.index! + m[0].length;
    }
    if (pos < p.length) spans.push(["text", p.slice(pos)]);
    return spans;
}

export function parseTextSegsEn(text: string, speakers: Record<string, string>,
                                overrides?: Record<string, string>): Seg[] {
    const re = dialogRe(speakers, "en");
    const segs: Seg[] = [];
    const participants: string[] = [];
    let lastSpeaker: string | null = null;
    let prevBareWho: string | null = null;
    let prevBareQuestion = false;
    let narrationBlock: string[] = [];

    const note = (who: string): void => {
        if (who !== "narrator" && !participants.includes(who)) participants.push(who);
    };
    const applyOverrideByWho = (who: string): string => {
        if (!overrides) return who;
        const disp = Object.keys(speakers).find(k => speakers[k] === who);
        return (disp && overrides[disp]) || who;
    };
    const stateMachineWho = (currentIsQuestion: boolean): string | null => {
        if (prevBareWho) {
            if ((prevBareQuestion || currentIsQuestion) && participants.length >= 2 && lastSpeaker) {
                return [...participants].reverse().find(w => w !== lastSpeaker) || prevBareWho;
            }
            return prevBareWho;
        }
        const w = enBlockSpeaker(narrationBlock, speakers);
        if (w) return w;
        if (participants.length >= 2 && lastSpeaker) {
            return [...participants].reverse().find(w => w !== lastSpeaker) ?? null;
        }
        return null;
    };

    for (const raw of text.split("\n")) {
        const p = raw.trim();
        if (!p) continue;
        if (p.startsWith('"') || p.startsWith("\u201c")) {
            // 规则 1：引号开头（裸引号 / 后置归属 / 同行多引号）
            const spans = enQuoteSpans(p);
            const contents = spans.filter(([k]) => k === "quote").map(([, s]) => s);
            const words = contents.join(" ").toLowerCase().match(/[a-z]+/g) || [];
            let who: string | null;
            if (contents.length && words.length && words.every(w => w.length <= 3)) {
                who = "narrator"; // 拟声词（Ooo... ooo...）：音效归旁白
            } else {
                who = null;
                for (const [kind, s] of spans) {
                    if (kind === "text") {
                        const mm = EN_ATTR_RE.exec(s.trim());
                        if (mm) who = enSpeakerOf(mm[1], speakers);
                    }
                }
                who = who || stateMachineWho(contents.some(s => s.trim().endsWith("?")));
            }
            const resolved = applyOverrideByWho(who || "narrator");
            let lastQ = "";
            for (const [kind, s] of spans) {
                if (kind === "quote") {
                    segs.push({ who: resolved, text: s });
                    lastQ = s;
                } else {
                    const tx = stripChars(s.trim(), ",").trim();
                    if (tx) segs.push({ who: "narrator", text: tx }); // 归属短语（says the Old Machine）旁白读
                }
            }
            note(resolved);
            if (resolved !== "narrator") lastSpeaker = resolved;
            prevBareWho = resolved !== "narrator" ? resolved : null;
            prevBareQuestion = lastQ.trim().endsWith("?");
            narrationBlock = [];
            continue;
        }
        const m = re.exec(p);
        if (m) {
            // 规则 2：名前引号后（Name: / Name says,）——intro 取匹配内引号前的全部（含 The 前缀）。
            // 同行多组对话逐组循环归属（2026-10-13：`TAKA says, "…" Seagull says, "…"` 此前第二组塌给第一人）；
            // 循环走完后仍剩裸引号尾才交给插话式续引。
            let rest = p;
            let mm: RegExpExecArray | null = m;
            let who = "narrator";
            while (mm) {
                const name = mm[1];
                const matched = mm[0];
                const qIdx = matched.search(new RegExp(EN_Q_OPEN));
                const intro = (rest.slice(0, mm.index) + matched.slice(0, qIdx)).trim().replace(/\s+/g, " ");
                who = "narrator";
                for (const [k, v] of Object.entries(speakers)) {
                    if (k.toLowerCase() === name.toLowerCase()) { who = v; break; }
                }
                if (overrides && overrides[name]) who = overrides[name];
                let introText = intro;
                if (stripChars(introText, ":").trim() === name) introText = name + " says";
                if (introText) segs.push({ who: "narrator", text: introText });
                segs.push({ who, text: mm[3] });
                note(who); lastSpeaker = who;
                rest = rest.slice(mm.index! + matched.length).trim();
                mm = re.exec(rest);
            }
            if (rest) segs.push(...outroSegs(rest, who, "narrator", "en"));
            prevBareWho = null; prevBareQuestion = false; narrationBlock = [];
            continue;
        }
        const mp = EN_POSTPOSED_RE.exec(p);
        if (mp) {
            // 规则 2b：后置归属（引号不在段首的残例）
            const who = applyOverrideByWho(enSpeakerOf(mp[2], speakers) || "narrator");
            const intro = p.slice(0, mp.index).trim();
            if (intro) segs.push({ who: "narrator", text: intro });
            segs.push({ who, text: mp[1] });
            const outro = p.slice(mp.index! + mp[0].length).trim();
            if (outro) segs.push(...outroSegs(outro, who, "narrator", "en"));
            note(who); lastSpeaker = who;
            prevBareWho = null; prevBareQuestion = false; narrationBlock = [];
            continue;
        }
        if (p.includes('"') || p.includes("\u201c")) {
            // 规则 2c：旁白同行 + 所有格发声（the communicator sends out the Old Machine's voice, "..."）
            const qpos = Math.min(...[p.indexOf('"'), p.indexOf("\u201c")].filter(i => i >= 0));
            const pre = p.slice(0, qpos);
            const mv = new RegExp("(?:the\\s+)?(" + Object.keys(speakers).map(escapeRe).join("|") + ")'s\\s+voice", "i").exec(pre);
            if (mv) {
                const name = mv[1];
                let who = "narrator";
                for (const [k, v] of Object.entries(speakers)) {
                    if (k.toLowerCase() === name.toLowerCase()) { who = v; break; }
                }
                if (overrides && overrides[name]) who = overrides[name];
                const rest = p.slice(qpos);
                const qm = new RegExp(EN_Q_OPEN + "([^\\u201d\"]+?)" + EN_Q_CLOSE).exec(rest);
                if (qm) {
                    if (pre.trim()) segs.push({ who: "narrator", text: stripChars(pre.trim(), ",") });
                    segs.push({ who, text: qm[1] });
                    const outro = rest.slice(qm.index! + qm[0].length).trim();
                    if (outro) segs.push({ who: "narrator", text: outro });
                    note(who); lastSpeaker = who;
                    prevBareWho = null; prevBareQuestion = false; narrationBlock = [];
                    continue;
                }
            }
        }
        // 旁白
        segs.push({ who: "narrator", text: p });
        prevBareWho = null;
        prevBareQuestion = false;
        narrationBlock.push(p);
    }
    return segs;
}

/** 入口（speech.ts 调用；签名与旧 parseTextSegs 兼容，多收 speakers/lang） */
export function parseTextSegs(text: string, speakers: Record<string, string>,
                              overrides: Record<string, string> | undefined,
                              lang: "zh" | "en"): Seg[] {
    if (lang === "en") return parseTextSegsEn(text, speakers, overrides);
    const re = dialogRe(speakers, "zh");
    return text.split(/\n+/).flatMap(p => parseParagraphZh(p, re, speakers, overrides));
}
