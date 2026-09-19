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
| docs/reports/PERF-DEBUG-LATEST.md | 最新性能报告的单行指针，指向的报告本身未入库（`docs/reports/` 已 gitignore）；提交会把指针变成远端悬空引用，故本地压住（2026-09-19 补充） |

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

## 推送范围与脱敏检查（2026-09-17 补充）

**规则本身**（什么不入库、什么必须先脱敏）在仓库根 `AGENTS.md`，本节只记机制。

### 推送前四道关

`.husky/pre-push` 现在是：

```
bash scripts/desensitize-check.sh   # 脱敏（最便宜，也最该先失败）
pnpm -C apps/readest-app format:check
pnpm -C apps/readest-app lint       # tsgo --noEmit + biome lint
pnpm -C apps/readest-app test
```

任何一道非 0 都会拦下推送，不得 `--no-verify` 绕过（与本节开头的既有约定一致）。

### 脱敏检查器

`scripts/desensitize-check.sh` 扫描**本次推送会带出去的新增行**（基线取 `@{upstream}`；
新分支首次推送时取任一远端分支；连远端都没有才扫全部跟踪文件），命中即打印
`文件 + 新增行号 + 命中特征 + 原文片段` 并以 1 退出。

- 通用特征：本机用户目录（Windows / macOS / Linux）、邮箱、常见凭据前缀、私钥头。
- 占位符不算命中：`C:\Users\<用户名>`、`%USERPROFILE%`、`$HOME`、`/Users/<name>` 一律放过。
- 本机专有词表 `.desensitize-terms`（一行一词、字面匹配、**已 gitignore**）；该文件若被跟踪，检查器直接报错。
- 只扫新增行、不扫全树：早期推上去的泄漏（见 `AGENTS.md` §4）改不动，拿它拦今天的推送没有意义。

手工预检（不必真的 push）：

```bash
bash scripts/desensitize-check.sh
```

### .gitignore 新增的本地路径

`docs/plans/`、`docs/reports/`、`docs/superpowers/`、`/新版导入测试/`、
`apps/readest-app/src/__tests__/**/zz-*.test.ts`、`.desensitize-terms`、`.zcode/`。

注意：gitignore 只对**未跟踪**文件生效——已经入库的历史文档（`docs/README.md`、
`docs/git-setup.md`、早期 `docs/reports/*.md`）仍是跟踪状态，它们的改动照常出现在
`git status` 里，也不会被这条设定挡住。

