#!/usr/bin/env bash
# =============================================================================
# 项目 Git 设定脚本（当前项目专用）
#
# 本脚本固化本项目的一条重要 Git 约定：
#   「推送/提交时忽略 packages/tauri 与 packages/simplecc-wasm 这两个子模块
#    的工作区改动，不让它们被 add / commit / push 带进主仓库。」
#
# 背景
#   - packages/tauri       : 子模块仓库 readest/tauri 的 fork。在 Windows 上因
#                            core.autocrlf=true 且子模块无 .gitattributes，
#                            checkout 会把 LF 换成 CRLF，导致 git 误以为 140+
#                            个文件被"改动"（实际只是行尾翻转，忽略 CR 后为零差异）。
#   - packages/simplecc-wasm: 子模块仓库 readest/simplecc-wasm 的 fork，工作区
#                            的 dist/web 是编译产物，删除/变化属构建副作用。
#
# 这两者都不属于主仓库 readest-local 的功能代码，不应被提交或推送到主仓库。
# 由于 .gitignore 无法忽略"已跟踪"的子模块 gitlink，因此用
# `git update-index --skip-worktree` 把两个子模块标记为"假定不变"，
# 这样 git status / add / commit / push 都会忽略它们。
#
# 使用
#   bash scripts/git-setup.sh          # 应用设定（幂等，可重复运行）
#   bash scripts/git-setup.sh --undo   # 撤销设定，恢复追踪两个子模块
# =============================================================================

set -euo pipefail

TAURI="packages/tauri"
SIMPLE="packages/simplecc-wasm"

apply() {
  echo "[git-setup] 标记子模块为 skip-worktree（提交/推送将忽略其改动）："
  git update-index --skip-worktree "$TAURI" "$SIMPLE"
  echo "  ok: $TAURI"
  echo "  ok: $SIMPLE"
  echo
  echo "[git-setup] 当前子模块追踪状态（S 表示已忽略）："
  git ls-files -v | grep -E "packages/(tauri|simplecc-wasm)$" || true
  echo
  echo "[git-setup] 完成。现在 git status/add/commit/push 都不会带上这两个子模块。"
}

undo() {
  echo "[git-setup] 撤销 skip-worktree，恢复追踪两个子模块："
  git update-index --no-skip-worktree "$TAURI" "$SIMPLE"
  echo "  ok: $TAURI"
  echo "  ok: $SIMPLE"
  echo "[git-setup] 完成。"
}

case "${1:-}" in
  --undo) undo ;;
  *)      apply ;;
esac
