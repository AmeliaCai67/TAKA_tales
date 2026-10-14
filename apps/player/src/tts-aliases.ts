/** 合成专用别名；ASCII 单词/名称只匹配完整 token，显示文字不变。
 *  不用 lookbehind——老 Safari/WKWebView/ArkWeb 正则编译期崩（同 tts-sentence.ts 的纪律）；
 *  前边界改为捕获组回吐（lookahead 自古支持，保留）。k 已被上面的 /^[A-Za-z0-9]+$/ 约束，无需转义。 */
export function applyTtsAliases(text: string, aliases: Record<string, string>): string {
    let out = text;
    for (const k of Object.keys(aliases)) {
        if (/^[A-Za-z0-9]+$/.test(k)) {
            out = out.replace(new RegExp("(^|[^A-Za-z0-9_])" + k + "(?![A-Za-z0-9_])", "g"),
                (_m, pre: string) => pre + aliases[k]);
        } else {
            out = out.split(k).join(aliases[k]);
        }
    }
    return out;
}
