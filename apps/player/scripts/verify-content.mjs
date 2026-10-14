// 构建收尾核验：原始故事包、public 和 dist 的台词音频必须逐字节一致。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const source = fileURLToPath(new URL("../../../content/stories/", import.meta.url));
const targets = ["public", "dist"].map(p => fileURLToPath(new URL(`../${p}/stories/`, import.meta.url)));
const digest = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const errors = [];
let checked = 0, english = 0;
function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("_") || / [23](?:\.|$)/.test(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        const rel = relative(source, path);
        if (!/(?:^|\/)story(?:\.en)?\.json$/.test(rel) &&
            !/(?:^|\/)audio(?:-en)?\/.*(?:\.mp3|manifest\.json)$/.test(rel)) continue;
        const hash = digest(path);
        for (const target of targets) {
            const copy = join(target, rel);
            if (!existsSync(copy) || digest(copy) !== hash) errors.push(copy);
        }
        checked++;
        if (rel.includes("/audio-en/") && rel.endsWith(".mp3")) english++;
    }
}
walk(source);

// ── 生产包污染防护（2026-10-14）──
// apps/player/.env.local 被 vite 全模式加载，裸跑 `npm run build` 会把
// VITE_API_BASE=http://localhost:8000 内联进 dist → 线上浏览器把 /api/* 打到自己本机，
// 自由输入/TTS 全挂（表现为「网络开小差」且 nginx 无记录，2026-10-14 冒烟事故）。
// 这里在 postbuild 硬拦：dist 的 js/css/html 出现开发机地址即构建失败。
// 生产构建须先移开 .env.local（或 shell 覆盖 VITE_* 为空），见 infra/README §2。
const DEV_URL = /(?:localhost|127\.0\.0\.1):\d+/;
const root = fileURLToPath(new URL("../", import.meta.url));
const contaminated = [];
function scanBundle(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { scanBundle(path); continue; }
        if (!/\.(?:js|mjs|css|html)$/.test(entry.name)) continue;
        const m = readFileSync(path, "utf8").match(DEV_URL);
        if (m) contaminated.push(`${relative(root, path)} 内联开发机地址 ${m[0]}`);
    }
}
scanBundle(join(root, "dist"));

if (errors.length || contaminated.length) {
    if (errors.length) console.error("✗ 构建资产缺失或与 content 不一致：\n" + errors.join("\n"));
    if (contaminated.length) console.error("✗ 生产包含开发机地址（.env.local 污染？）——禁止发布：\n" + contaminated.join("\n") + "\n  修复：构建前移开 apps/player/.env.local（或 shell 覆盖 VITE_API_BASE= 等为空），见 infra/README §2。");
    process.exitCode = 1;
} else {
    console.log(`✓ 构建资产核验：${checked} 个源文件，英文 ${english} 段；public/dist 全部 SHA-256 一致；无开发机地址内联`);
}
