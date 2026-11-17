#!/bin/bash
# 生成腾讯云 SCF Web 函数部署包（唯一标准包）。
# 用法：bash scripts/make-scf-zip.sh [输出路径]
# 默认输出：~/Downloads/ncm-api-scf.zip
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$HOME/Downloads/ncm-api-scf.zip}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[1/4] 从 git HEAD 导出源码（杜绝漏同步）"
git -C "$ROOT" archive HEAD | tar x -C "$TMP"
cd "$TMP"

echo "[2/4] 安装生产依赖（仅 prod，跳过脚本，走国内镜像）"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmmirror.com >/dev/null

echo "[3/4] 剔除无引用的大图片与系统垃圾"
# 这两张 PNG 在仓库内无任何页面引用，纯占体积（合计 ~3.3MB）；
# 有引用的 docs/aigen.png、docs/netease.png、static/eapi_*.png 保留。
rm -f public/static/module_test.png public/static/2170.png
find . -name '.DS_Store' -delete
rm -f bootstrap # 防呆：SCF 要求入口文件名为 scf_bootstrap

echo "[4/4] 打包 → $OUT"
zip -qr "$OUT" .

ls -la "$OUT" | awk '{printf "完成: %.1f MB\n", $5/1048576}'
