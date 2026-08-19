#!/bin/bash
# TAKA 本地开发一键起服：API(8000) + 播放器(8017) + 家长后台(5173)
# 用法：scripts/dev-up.sh [rebuild]   —— rebuild 会先重新构建 player dist
# ⚠️ 内测专属脚本：依赖 apps/api（FastAPI 后端）与 apps/parent（家长后台），
#    这两个是私有目录，**release-public.sh 发布的公开版不含**。公开版请直接用
#    demo/taka.html 体验，或 clone 私有库并自行配置后端。
set -e
cd "$(dirname "$0")/.."

# 公开版存在性检查：apps/api 与 apps/parent 缺失时明确提示，而不是在中途莫名失败
[ -d apps/api ] && [ -d apps/parent ] || {
    echo "✗ 这是内测脚本：apps/api 与 apps/parent 为私有目录，公开版不含。"
    echo "  公开版请直接打开 demo/taka.html 体验，或部署自己的后端。"
    exit 1
}

VENV="$PWD/packages/tts-pipeline/.venv/bin/python"

# 已起则直接报告
if lsof -ti :8000 >/dev/null 2>&1 && lsof -ti :8017 >/dev/null 2>&1 && lsof -ti :5173 >/dev/null 2>&1; then
    echo "✓ 已在运行：API http://localhost:8000 | 播放器 http://localhost:8017 | 家长后台 http://localhost:5173/parent/"
    exit 0
fi

if [ "${1:-}" = "rebuild" ]; then
    # player 走静态 dist（http.server 托管），改动需重建；parent 是 vite dev 实时编译，无需构建
    (cd apps/player && VITE_API_BASE=http://localhost:8000 VITE_TTS_ENDPOINT=http://localhost:8000/api/tts VITE_PARENT_URL=http://localhost:5173/parent/ npm run build)
fi

lsof -ti :8000 >/dev/null 2>&1 || {
    # LLM_API_KEY 等在根 .env（gitignored）；source 后传给 uvicorn 子进程
    (set -a; [ -f .env ] && . ./.env; set +a; cd apps/api && PYTHONPATH=../../packages/tts-pipeline nohup $VENV -m uvicorn app.main:app --port 8000 > /tmp/taka_api.log 2>&1 &)
}
lsof -ti :8017 >/dev/null 2>&1 || {
    (cd apps/player/dist && nohup python3 -m http.server 8017 > /tmp/taka_player.log 2>&1 &)
}
lsof -ti :5173 >/dev/null 2>&1 || {
    # 家长后台：vite dev（源码实时编译；/api 已由 vite.config.ts 代理到 8000，与生产 nginx 反代一致）
    (cd apps/parent && nohup npm run dev > /tmp/taka_parent.log 2>&1 &)
}
sleep 3
curl -s http://localhost:8000/health >/dev/null && echo "✓ API       http://localhost:8000  (日志 /tmp/taka_api.log)" || { echo "✗ API 启动失败，看 /tmp/taka_api.log"; exit 1; }
curl -s -o /dev/null http://localhost:8017/ && echo "✓ 播放器    http://localhost:8017  (日志 /tmp/taka_player.log)"
curl -s -o /dev/null http://localhost:5173/parent/ && echo "✓ 家长后台  http://localhost:5173/parent/  (日志 /tmp/taka_parent.log)"
echo
echo "停止：lsof -ti :8000,:8017,:5173 | xargs kill"
