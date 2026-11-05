// Explicit speech units: variable names affect text, never speaker identity or cue order.
export type SpeechCue =
    | { id: string; kind: "static"; file: string; who: string; text: string }
    | { id: string; kind: "tts"; who: string; template: string; atomic: true };
export type ResolvedSpeechCue =
    | Extract<SpeechCue, { kind: "static" }>
    | { id: string; kind: "tts"; who: string; displayText: string; spokenText: string };

export function cleanSpeechText(text: string, language: "zh" | "en" = "zh"): string {
    let out = text.replace(/（[^）]*）/g, "");
    if (language === "en") out = out.replace(/\([^)]*\)/g, "");
    return out.replace(/["“”「」『』]/g, "").trim();
}

export function resolveSpeechCues(cues: readonly SpeechCue[], variables: Readonly<Record<string, string>>,
                                  language: "zh" | "en" = "zh"): ResolvedSpeechCue[] {
    const ids = new Set<string>();
    return cues.map(cue => {
        if (ids.has(cue.id)) throw new Error(`重复的音频标记：${cue.id}`);
        ids.add(cue.id);
        if (cue.kind === "static") return { ...cue };
        const displayText = cue.template.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
            const value = Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : undefined;
            if (typeof value !== "string" || !value.trim()) throw new Error(`未填写名字变量：${key}`);
            if (/[{}]/.test(value)) throw new Error("名字不能包含模板变量");
            return value;
        });
        if (/[{}]/.test(displayText)) throw new Error("未解析的音频变量");
        const spokenText = cleanSpeechText(displayText, language);
        if (!spokenText) throw new Error(`朗读文本为空：${cue.id}`);
        return { id: cue.id, kind: "tts", who: cue.who, displayText, spokenText };
    });
}
