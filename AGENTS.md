# 项目设定：推送范围与脱敏（readest-local）

本文件是**仓库级**约定，收窄用户级默认规则（`~/.zcode/AGENTS.md`），适用于本仓库的一切 `git push`。
机制细节（钩子、skip-worktree、行尾）见 `docs/git-setup.md`；构建与清理约定见 `CLAUDE.md`。

## 1. 文档默认不推送

默认**不入库、不推送**：

| 路径 | 是什么 |
|---|---|
| `docs/plans/**` | 执行计划 |
| `docs/reports/**` | 实施 / 审查 / 调试报告 |
| `docs/superpowers/**` | 规划材料 |
| `新版导入测试/**` | 手工验收样本（自造的 epub / pdf / txt） |
| `apps/readest-app/src/__tests__/**/zz-*.test.ts` | 临时探针（按前缀命名，跑完即删） |
| `.claude/skills/**`（仓库根） | 会话技能，本地调试用 |

这些路径写在 `.gitignore` 里：`git status` 不再显示、`git add -A`／`git add .` 抓不走。
**已在仓库中的历史文档**（`docs/README.md`、`docs/git-setup.md`、早期 `docs/reports/*.md`）保持跟踪状态，不受本条影响。

`/.claude/skills/perf-debug/SKILL.md` 在 2026-09-17 之前是被跟踪的（随一次 docs 提交入库），现已用
`git rm --cached` 移出跟踪：文件仍在工作区、仍然可用，只是不再随推送出去。**但它仍留在远端历史里**
（提交 `976cff632`）——"从当前树移除"不等于"从历史抹掉"，后者要重写已推送历史。

某份报告确实要给外人看（必须推送）时：`git add -f <路径>`——`-f` 是有意为之的动作，之后按下一节脱敏。

## 2. 任何进入推送范围的内容都要先脱敏

包括代码、注释、`CHANGELOG.md`，**以及提交信息**（它随分支一起公开）。不得包含：

- **本机绝对路径里的用户名**：`C:\Users\<你>`、`/Users/<你>/…`、`/home/<你>/…`
  → 换成 `<用户目录>` / `%USERPROFILE%` / `$HOME` / 仓库内相对路径。
- **个人信息**：邮箱、真名、设备名、账号 ID。
- **真实书名与文件名**：本项目书库是个人内容，样本一律用代称（「样本 A」「某本书」「01-原始版」），
  **不要**写真实书名或它在磁盘上的路径。
- **凭据**：token、私钥、`.env` 内容、`library.lock` 里的 token。

测试确实需要真实路径时：用 `std::env::temp_dir()` / `os.tmpdir()` / `process.cwd()` 现算，或在测试里现造 fixture——
**不要**把本机路径写死进代码。教训：曾经有一条临时探针把 `C:\Users\<你>\…\手工验收样本\epub`
写进了 `epub_parser.rs` 的函数体，靠人眼 review 是看不见的。

## 3. 执行方式（不靠记性）

- **`.husky/pre-push` 的第一步就是检查器**：`bash scripts/desensitize-check.sh`。
  它扫描本次推送的**新增行**，命中即拦下 push，并打印文件、行号与处理办法。
- **本机词表** `.desensitize-terms`（一行一个词、字面匹配、**不入库**）：账号名、真名、设备名、
  真实书名这类写不成通用规则的东西放这里。该文件若被 git 跟踪，检查器直接报错——
  那等于把词表连同它要保护的内容一起推出去。
- **随时手工预检**：`bash scripts/desensitize-check.sh`（不必真的 push；干净时输出「通过」）。
- 与既有钩子同等约束：**不得用 `--no-verify` 绕过**（`docs/git-setup.md` 明令）。

检查器只扫**新增行**，不扫全树：历史里已经存在的泄漏改不动，拿它拦住今天的新推送没有意义。因此：

## 4. 已知的历史泄漏（已推送到远端，暂不处理）

`docs/reports/handover-epub-virtual-toc-2026-09-11.md`（4 处）、
`docs/reports/handover-epub-virtual-toc-2026-09-11-round2.md`、
`docs/superpowers/plans/2026-09-11-epub-virtual-toc.md` 里出现过真实的用户目录路径。
清理它们需要重写已推送的历史，收益（一个目录名）不抵风险，故保留；**新内容不要再重复它们**。

## 5. 语言支持范围（只维护中英）

界面语言只有三种：**`zh-CN`（基准全集）、`zh-TW`（必须与简体键集对齐）、`en`（只存复数形态与专名）**。

- **新增 UI 字符串只写 `zh-CN` + `zh-TW`**（`en` 仅在需要正确单复数时补）。两条硬护栏在
  `apps/readest-app/src/__tests__/i18n/locale-key-diff.test.ts`：`zh-TW ⊇ zh-CN`，以及
  `zh-CN` 覆盖源码里所有 `_()` 字面量。
- `i18n-langs.json` 里**其余 31 个语言是上游遗产**：保持原样，不新增、不维护、不删除
  （删除会在每次上游同步时产生大批 modify/delete 冲突）。它们不含本分支新增的字符串，回落英文。
- **不要运行 `pnpm i18n:extract`**（会删在用词条并写占位符）。细节见 `apps/readest-app/docs/i18n.md` 的
  「本分支的语言支持范围」。
