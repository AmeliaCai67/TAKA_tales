#!/bin/bash
# 公开发布：把 main 上「允许公开」的路径同步到 opensource 分支并推送 public 库。
#
# 模型：
#   origin (TAKA_tales_deploy, 私有)  ← git push origin main      日常开发全量推这里
#   public (TAKA_tales, 开源)         ← 仅经本脚本发布 opensource 分支
#
# 私有边界（永远不在下方允许清单里）：
#   content/stories/ch02-* 及以后的故事包（核心内容资产）
#   packages/prompts/（生成约束、红线词库——M4 起在此沉淀）
#   任何内测数据 / 密钥（本来也不入库）
#
# 用法：scripts/release-public.sh "发布说明"
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-Release: sync from main}"

# 允许公开的路径白名单（新增公开内容时在此登记）
# 注意：apps/api 与 apps/parent 均整体私有（2026-08-09 决策）——
# 生成控制逻辑与家长数据面板都是核心资产
ALLOWED=(
    "apps/player"
    "packages/story-schema"
    "content/stories/ch01-wind"
    "demo"
    "hackathon"
    "scripts"
    "index.html"
    "README.md"
    ".gitignore"
    ".nojekyll"
)

# 构造白名单正则（用于漂移检查）
PATTERN="^($(printf '%s|' "${ALLOWED[@]}" | sed 's/|$//' | sed 's/\./\\./g'))"

CURRENT=$(git branch --show-current)
[ "$CURRENT" = "main" ] || { echo "请先在 main 分支上运行"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "main 有未提交改动，先提交"; exit 1; }

git checkout -q opensource
trap 'git checkout -q -f main' EXIT   # 任何退出路径都强制切回 main

# 路径级同步：只把白名单路径从 main 取过来
git checkout main -- "${ALLOWED[@]}"

# 母带/源文件不入公开库（与 sync-content.mjs 同规则：「_」开头不发布，如 ch01-wind/_src/风声母带）
UNDERSCORE=$(git -c core.quotepath=false ls-files | grep -E '(^|/)_[^/]+' || true)
if [ -n "$UNDERSCORE" ]; then
    echo "$UNDERSCORE" | while read -r f; do git rm -qf -- "$f"; done  # -f：checkout main -- 刚暂存的文件需要强制
fi

# 反向清理：opensource 上已不在白名单内的历史文件（如后来下架的路径）一律移除
# ——白名单是双向强制的，公开库 = 白名单的精确镜像
# core.quotepath=false：ls-files 默认把中文名转义成八进制，既破坏白名单匹配也让 git rm 找不到文件
# 注意 set -e + pipefail 下 grep 无匹配会返回 1 杀死脚本，必须兜 `|| true`
OUT=$(git -c core.quotepath=false ls-files | grep -vE "$PATTERN" || true)
if [ -n "$OUT" ]; then
    echo "$OUT" | while read -r f; do git rm -q -- "$f"; done
fi

# 漂移检查：新增/修改不得落在白名单之外（删除不管——反向清理产生的删除是合法的）
# core.quotepath=false：否则中文路径被转义成 "\351\243\216..." 带引号格式，^ 锚点匹配不上会误杀
DRIFT=$(git -c core.quotepath=false status --porcelain | awk '$1 !~ /D/ {print $2}' | grep -vE "$PATTERN" || true)
if [ -n "$DRIFT" ]; then
    echo "✗ 检测到白名单外的改动，中止发布："
    echo "$DRIFT"
    git reset -q --hard && git clean -fdq
    exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
    echo "✓ 白名单路径与 main 无差异，无需发布"
    exit 0
fi

echo "=== 将公开发布的改动 ==="
git status --short
read -r -p "确认推送到公开库？[y/N] " ok
[ "$ok" = "y" ] || { git reset -q --hard && git clean -fdq; echo "已取消"; exit 0; }

git commit -q -m "$MSG"
git push public opensource:main
echo "✓ 已发布到公开库 public/main"
