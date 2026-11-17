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

echo "[3/4] 剔除大图片与系统垃圾（方案 A：函数仅当 API，public 图片无人经浏览器访问）"
# 删除 public 下所有 >1MB 的 PNG：既含无引用孤儿(module_test/2170)，
# 也含文档站示意图(aigen/netease/eapi_params/eapi_response)。
# 代价：docsify 文档站与 api_decrypt 页的示意图变破图——但默认测试域名
# 对 HTML 强制下载，这些页面本就走不到浏览器渲染，影响为零。
find public -type f -iname "*.png" -size +1M -delete
find public -type f -iname "*.jpg" -size +1M -delete 2>/dev/null || true
find . -name '.DS_Store' -delete
rm -f bootstrap # 防呆：SCF 要求入口文件名为 scf_bootstrap

echo "[4/4] 打包 → $OUT"
# 必须先删旧包：zip 对已存在的归档是"增量更新"，不会移除已删文件的旧条目
rm -f "$OUT"
zip -qr "$OUT" .

ls -la "$OUT" | awk '{printf "完成: %.1f MB\n", $5/1048576}'
