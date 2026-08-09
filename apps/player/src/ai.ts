// AI 生成：白名单填空，红线注入（AGENTS.md §3.3 / §5.3）
// 过渡态：M4 之前仍是浏览器直连 LLM（key 在 localStorage）；M4 迁服务端后本模块只剩 fetch 客户端
import type { Scene } from "./story";
import type { AiSettings } from "./settings";

export interface GenCtx {
    prevText?: string;
    choiceText?: string;
    custom?: boolean;      // 选项 C 自由输入
    generated?: string;    // 预生成好的文本（选项 C 提交时已产出）
}

const SYSTEM_PROMPT = `你在为 3-6 岁儿童互动故事《塔卡》撰写场景正文。
塔卡是一个旧铁皮机器人：单眼、暖黄色的灯、话少、诚实、温暖。

【文风要求】
- 海明威式极简：短句，主谓宾，极少形容词
- 每句不超过 15 字；用重复制造节奏（如"呼呼。"）
- 全文不超过 120 字，段与段之间空一行（3-5 段）
- 角色对话用中文引号
- 只输出正文：不要标题、不要解释、不要给全文加引号

【塔卡的身体（重要，不要写错）】
- 方形铁盒身体，没有嘴、没有脸：情绪只用一只暖黄色的灯（眼睛）表达，如“灯闪了三下”“灯光变亮”
- 在海里靠背部的螺旋桨推进，写“游上去、浮起来、往下沉”；腿是陆地用的，收在身体里，水里不要写走路和腿
- 手臂是链条，可以抓握
- 禁止出现：张嘴、吃、笑、走、跑、跳、弯腰、坐下

【价值观红线】
- 塔卡是中性机器人：指代一律用"它"，不用"他"或"她"
- 不评判孩子的选择，不说教
- 不写牺牲自己救别人；写"一起想办法"
- 不出现"听话才是好孩子"
- 不用宗教词汇；用科幻词（能量、信号、记忆库）
- 不恐吓，紧张感用环境描写表达`;

function buildUserPrompt(scene: Scene, ctx?: GenCtx): string {
    const prev = (ctx && ctx.prevText) || "（故事开始）";
    const choice = (ctx && ctx.choiceText) || "（无）";
    const beats = (scene.beats || []).map(b => "- " + b).join("\n");
    let prompt = `【故事前情】\n${prev}\n\n【孩子的选择】\n${choice}${ctx && ctx.custom ? "（孩子自己输入的想法）" : ""}\n\n【本场景剧情要点】\n${beats}\n`;
    if (ctx && ctx.custom) {
        // 自定义选择必须生效：先接住（哪怕整活），再软引导回主线。不评判、不说教
        prompt += `\n【重要】孩子的选择必须生效：\n1. 第一段先回应这个选择：接住它，哪怕它偏离主线（塔卡可以真的开始照做，或说出它的想法）\n2. 再用环境或角色自然过渡，把故事引回剧情要点\n3. 剧情走向和结局不变，不评判孩子的想法\n`;
    }
    prompt += "\n请按剧情要点写出本场景正文。";
    return prompt;
}

export async function generateSceneText(scene: Scene, ctx: GenCtx | undefined, settings: AiSettings): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 15s 超时
    // 推理模型（deepseek-v4）先烧 reasoning 额度，极端输入下会无限反刍烧光预算→空正文。
    // 压低推理强度（仅 DeepSeek 端点加此参数，避免其他提供商报未知参数）
    const body: Record<string, unknown> = {
        model: settings.model,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(scene, ctx) }
        ],
        temperature: 0.8,
        max_tokens: 1200
    };
    if (/deepseek/i.test(settings.baseUrl)) body.reasoning_effort = "low";
    let res: Response;
    try {
        res = await fetch(settings.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + settings.apiKey
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        // 带上服务端报错信息（如 “Model Not Exist”），否则排查只能靠猜
        let msg = "HTTP " + res.status;
        try {
            const err = await res.json();
            if (err && err.error && err.error.message) msg += "：" + err.error.message;
        } catch {}
        throw new Error(msg.slice(0, 80));
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) throw new Error("empty response");
    return text.trim();
}
