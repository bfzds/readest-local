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

## 行尾规范化与 pre-push 钩子（2026-09-06 补充）

### 症状

`git push` 被 pre-push 钩子（`.husky/pre-push`：`format:check` → `lint` → `test`）
拦截，`biome format .` 对 `.devcontainer/`、`.vscode/` 等大量**未被本次改动
触碰**的文件报「Formatter would have printed the following content」（CRLF 行尾）。

### 根因

与上面子模块问题同源：Windows 全局 `core.autocrlf=true` 把检出文件全部变成
CRLF，而 `biome.json` 固定 `"lineEnding": "lf"`——工作区文件（CRLF）与
格式化目标（LF）永远不一致，`format:check` 在 Windows 上必然失败。

### 解决方法（默认方法，已生效）

1. 仓库根新增 `.gitattributes`：`* text=auto eol=lf`（`*.bat`/`*.cmd` 保持
   CRLF），**随仓库分发**，任何 clone/机器都自动生效，无需本地设置。
2. 一次性重检出工作区使属性落地：
   ```bash
   git rm --cached -r . -q && git reset --hard -q
   ```
   只改工作区字节（CRLF→LF），索引不变，**不产生任何提交差异**。
3. 之后 `biome format .` 全绿，pre-push 钩子可正常通过，**不要用
   `--no-verify` 绕过**（仅当钩子里的全量 `test` 步骤在本机跑不动、且
   改动已有针对性测试覆盖时才允许，需在提交说明中注明）。

验证：`pnpm -w format:check` → `Checked 1178 files ... No fixes applied.`

> 注意：`.gitattributes` 是 2026-09-06 才加入的；此前的 clone 若未拉取该
> 提交，仍会复现上述症状，拉取后无需任何手动操作。
