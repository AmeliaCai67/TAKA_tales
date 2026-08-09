// 构建/开发前把仓库级故事包同步进 public/（public/stories 不入库，单一事实源在 content/）
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../../content/stories/", import.meta.url));
const dst = fileURLToPath(new URL("../public/stories/", import.meta.url));

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("✓ content/stories → apps/player/public/stories");
