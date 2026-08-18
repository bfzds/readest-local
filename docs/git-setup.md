# Git 设定：推送/提交忽略两个子模块

> 当前项目约定。通过 git update-index --skip-worktree 让主仓库在
> **提交与推送时忽略** packages/tauri 与 packages/simplecc-wasm 这两个
> 子模块的工作区改动，避免它们被 git add -A / git commit / git push
> 误带进主仓库（readest-local）。

## 为什么忽略

| 子模块 | 原因 |
|---|---|
| packages/tauri | Windows 下 core.autocrlf=true 且子模块无 .gitattributes，checkout 把 LF 换成 CRLF，会让 git 误报 140+ 个文件"被改动"；忽略 CR 后**实质差异为零**（纯行尾假象，非功能） |
| packages/simplecc-wasm | 仓库 dist/web 是编译产物，删除/变化是构建副作用，不属于主仓库功能代码 |

## 生效范围与局限

- 用 skip-worktree 标记的是 git 索引（index）状态，存在本地 .git 中，
  对**当前这个工作目录持久生效**；不会随 clone 自动带入（重新 clone 后需重跑一次脚本）。
- .gitignore 无法忽略"已跟踪"的子模块 gitlink，故采用 update-index --skip-worktree。

## 命令

```bash
# 应用设定（幂等）
bash scripts/git-setup.sh

# 撤销设定
bash scripts/git-setup.sh --undo
```

手动等价命令：

```bash
# 应用
git update-index --skip-worktree packages/tauri packages/simplecc-wasm
# 撤销
git update-index --no-skip-worktree packages/tauri packages/simplecc-wasm
```

验证：

```bash
git ls-files -v | grep -E "packages/(tauri|simplecc-wasm)$"
# 输出 S 开头即表示已忽略（skip-worktree）
```

## 撤销后的注意事项

若执行 --undo 恢复追踪，两个子模块的工作区差异会重新出现在
git status 中。tauri 重新出现的是 CRLF 行尾假差，**不应提交**；如需让
tauri 工作区再次变"干净"，可用 git -C packages/tauri checkout -- . 还原。
