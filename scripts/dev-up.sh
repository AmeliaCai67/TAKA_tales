#!/bin/bash
# TAKA 本地开发一键起服：API(8000) + 播放器(8017)
# 用法：scripts/dev-up.sh [rebuild]   —— rebuild 会先重新构建 player
set -e
cd "$(dirname "$0")/.."
VENV=packages/tts-pipeline/.venv/bin/python

# 已起则直接报告
if lsof -ti :8000 >/dev/null 2>&1 && lsof -ti :8017 >/dev/null 2>&1; then
    echo "✓ 已在运行：API http://localhost:8000 | 播放器 http://localhost:8017"
    exit 0
fi

if [ "${1:-}" = "rebuild" ]; then
    (cd apps/player && VITE_API_BASE=http://localhost:8000 VITE_TTS_ENDPOINT=http://localhost:8000/api/tts npm run build)
fi

lsof -ti :8000 >/dev/null 2>&1 || {
    (cd apps/api && PYTHONPATH=../../packages/tts-pipeline nohup $VENV -m uvicorn app.main:app --port 8000 > /tmp/taka_api.log 2>&1 &)
}
lsof -ti :8017 >/dev/null 2>&1 || {
    (cd apps/player/dist && nohup python3 -m http.server 8017 > /tmp/taka_player.log 2>&1 &)
}
sleep 3
curl -s http://localhost:8000/health >/dev/null && echo "✓ API      http://localhost:8000  (日志 /tmp/taka_api.log)" || { echo "✗ API 启动失败，看 /tmp/taka_api.log"; exit 1; }
curl -s -o /dev/null http://localhost:8017/ && echo "✓ 播放器   http://localhost:8017  (日志 /tmp/taka_player.log)"
echo
echo "停止：lsof -ti :8000,:8017 | xargs kill"
