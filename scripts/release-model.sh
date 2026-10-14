#!/usr/bin/env bash
# 打包并发布 SetFit 三态分类小模型（guardrail_model_v3）。
#
# 正式产物：test/bert_training/guardrail_model/（多语 MiniLM，留出集 15/15，
# 域外回归全过——见 docs/superpowers/plans/2026-10-09-freeinput-guardrail-model-training.md；
# guardrail_model_bge/ 是 87% 的对照组，不发布）。
#
# 用法：
#   scripts/release-model.sh pack             # 仅本地打包 + SHA-256（dist/ 下产出）
#   scripts/release-model.sh ship user@host   # 打包并 rsync 到部署机（缺省读 DEPLOY_TARGET）
#
# 部署机侧约定（infra/docker-compose.yml 已对齐）：
#   模型解压到 <repo>/infra/data/models/guardrail/（容器内 /models/guardrail，只读挂卷）
#
# 环境变量：DEPLOY_TARGET（user@host）、DEPLOY_MODEL_DIR（缺省 infra/data/models/guardrail，
#           相对部署机上的仓库根；compose 的相对卷以 infra/ 为工作目录）
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=test/bert_training/guardrail_model
NAME=guardrail_model_v3
OUT=dist

mkdir -p "$OUT"
echo "==> 打包 $SRC → $OUT/$NAME.tar.gz"
tar -czf "$OUT/$NAME.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")"
shasum -a 256 "$OUT/$NAME.tar.gz" > "$OUT/$NAME.tar.gz.sha256"
echo "==> SHA-256"
cat "$OUT/$NAME.tar.gz.sha256"
du -h "$OUT/$NAME.tar.gz"

if [ "${1:-pack}" = "pack" ]; then
    echo "==> 仅打包完成（不发布）"
    exit 0
fi

# 只认 "ship"：目标取第 2 参（`ship user@host`）；兼容直接传目标（`user@host`）；
# 两者都缺时读 DEPLOY_TARGET。旧写法把 "ship" 当成主机名（2026-10-13 修复）。
MODE="${1:-pack}"
if [ "$MODE" = "ship" ]; then
    TARGET="${2:-${DEPLOY_TARGET:-}}"
else
    TARGET="${1:-${DEPLOY_TARGET:-}}"
fi
if [ -z "$TARGET" ]; then
    echo "✗ 缺部署目标：用法 scripts/release-model.sh ship user@host（或 export DEPLOY_TARGET）" >&2
    exit 1
fi
MODEL_DIR="${DEPLOY_MODEL_DIR:-infra/data/models/guardrail}"

echo "==> 确保远端目录存在：$TARGET:$MODEL_DIR/"
# rsync 不创建多级父目录（openrsync/老 rsync 无 --mkpath），必须先建；否则新机上 ship 直接失败（2026-10-14 踩）
ssh "$TARGET" "mkdir -p $MODEL_DIR"
echo "==> rsync → $TARGET:$MODEL_DIR/"
rsync -avz --checksum "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256" "$TARGET:$MODEL_DIR/"
echo "==> 远端校验 + 解包 + 落位"
# SHA 校验只比哈希列：本地 .sha256 记的是 dist/ 相对路径，远端解包路径不同，
# 整行 cmp 会因文件名不同必然误报（2026-10-13 修复）。
ssh "$TARGET" "set -euo pipefail
    cd \$(git rev-parse --show-toplevel 2>/dev/null || echo \$HOME)
    mkdir -p $MODEL_DIR
    want=\$(awk '{print \$1}' $MODEL_DIR/$NAME.tar.gz.sha256)
    got=\$(shasum -a 256 $MODEL_DIR/$NAME.tar.gz | awk '{print \$1}')
    if [ -z \"\$want\" ] || [ \"\$want\" != \"\$got\" ]; then
        echo '✗ SHA-256 不匹配' >&2
        exit 1
    fi
    tar -xzf $MODEL_DIR/$NAME.tar.gz -C $MODEL_DIR --strip-components=1
    echo '✓ 模型就位。重启 api 生效：docker compose -f infra/docker-compose.yml up -d api'
"
