// 构建/开发前把仓库级故事包同步进 public/（public/stories 不入库，单一事实源在 content/）
// 并生成书架索引 index.json（书架页列出全部故事；加新故事 = content/stories 下加目录）
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../../content/stories/", import.meta.url));
const dst = fileURLToPath(new URL("../public/stories/", import.meta.url));

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

const stories = [];
for (const dir of readdirSync(dst)) {
    try {
        const j = JSON.parse(readFileSync(dst + dir + "/story.json", "utf-8"));
        stories.push({
            id: j.id,
            title: j.title,
            summary: j.summary || "",
            cover: j.cover ? `stories/${dir}/${j.cover}` : "",
            achIds: (j.achievements || []).map(a => a.id),
            // 成就墙用：内联成就定义（id/图标/名称/描述），避免整包拉取
            achievements: (j.achievements || []).map(a => ({ id: a.id, name: a.name, icon: a.icon, desc: a.desc }))
        });
    } catch { /* 非故事目录，跳过 */ }
}
writeFileSync(dst + "index.json", JSON.stringify({ stories }, null, 1));
console.log(`✓ content/stories → apps/player/public/stories（index.json：${stories.length} 个故事）`);
