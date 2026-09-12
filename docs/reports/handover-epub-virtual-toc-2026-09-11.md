# 交接文档：EPUB 虚拟目录（正文生成目录）

- 日期：2026-09-11
- 分支：`readest-local`（全部为本地提交，**尚未推送**）
- 计划文件：`docs/superpowers/plans/2026-09-11-epub-virtual-toc.md`
- SDD 工作区（进度 ledger、任务简报、报告、审查包）：`.superpowers/sdd/2026-09-11-epub-virtual-toc/`（git-ignored）

## 一句话现状

计划共 8 个任务：**Task 1–4 已完成并逐个过审**（重构抽取 + 类型/持久化 + 扫描器，共 6 个本地提交），**Task 5–8 与最终全分支审查待做**。功能对用户尚不可见（阅读端接线在 Task 6/7）。

## 已完成的提交（本地，未推送）

| 提交 | 内容 | 审查 |
|---|---|---|
| `9c8026485` | Task 1：抽取共享章节正则引擎 `utils/chapterRules.ts`（TXT/EPUB 共用，含 LRU 源缓存与 ReDoS 守门） | ✅ 过审 |
| `d2412dd19` | Task 2：抽取元素 CFI 工具 `services/nav/elementCfi.ts` | ✅ 过审 |
| `f945eb498` | Task 2 修正（R3）：夹具改真实 section CFI、恢复与 `buildFragmentCfi` 逐字一致 | ✅ 过审 |
| `bca30a795` | Task 3：`VirtualTocEntry` 类型 + `BookConfig.virtualToc` + `apply` 纯函数（含 R2 重新生成语义） | ✅ 过审 |
| `7ea6b9050` | Task 4：扫描器 `services/virtualToc/scan.ts`（块元素匹配 + 元素 CFI + 命中计数） | — |
| `38d26c41b` | Task 4 修正（R4）：回归已发布接口（叠加语义、单一签名、真实夹具） | ✅ 过审 |

新增/改动文件：

- 新增：`src/utils/chapterRules.ts`、`src/services/nav/elementCfi.ts`、`src/services/virtualToc/apply.ts`、`src/services/virtualToc/scan.ts`
- 新增测试：`src/__tests__/utils/chapter-rules.test.ts`、`src/__tests__/services/nav/element-cfi.test.ts`、`src/__tests__/services/virtual-toc-apply.test.ts`、`src/__tests__/services/virtual-toc-scan.test.ts`
- 改动：`src/utils/txt.ts`（改 import，对外导出不变）、`src/services/nav/fragments.ts`（改 import/调用）、`src/types/book.ts`（`VirtualTocEntry` + `BookConfig.virtualToc`）、3 个既有 TXT 测试文件的调用点机械替换

## 剩余任务（按计划执行即可）

| 任务 | 内容 | 关键点 |
|---|---|---|
| Task 5 | `services/virtualToc/synthesis.ts`：section 级自动合成（退化目录、按文件分章，cfi 直接用 `section.cfi`） | `shouldOfferSynthesis` / `synthesizeSectionToc` |
| Task 6 | `store/readerStore.ts` 打开路径合并 `config.virtualToc`（在 `updateToc` 之前）+ 侧栏目录空态生成入口（`sidebar/Content.tsx`） | `applyVirtualToc` 赋新数组引用触发 TOCView 重渲染；先建 `VirtualTocDialog` 空骨架 |
| Task 7 | `app/reader/components/VirtualTocDialog.tsx` 完整弹窗（内置规则预览 + 自定义正则 + 命中数 + 按文件分章 + 持久化刷新）+ 三份 locale i18n | 持久化用 `useBookDataStore.getState().saveConfig`；刷新用 `setState` 换新 `bookDoc` 引用 |
| Task 8 | 端到端验证 + 全量门禁 | 见下"验证方法" |

继续方式（子代理驱动流程的现场都在 ledger 里）：

```bash
# 计划工作区（幂等，会打印路径）
bash "C:\Users\30575\.agents\skills\subagent-driven-development\scripts\sdd-workspace" docs/superpowers/plans/2026-09-11-epub-virtual-toc.md
# 提取某个任务简报
bash "C:\Users\30575\.agents\skills\subagent-driven-development\scripts\task-brief" docs/superpowers/plans/2026-09-11-epub-virtual-toc.md 5
# 生成审查包（BASE 用该任务派发前的 HEAD）
bash "C:\Users\30575\.agents\skills\subagent-driven-development\scripts\review-package" docs/superpowers/plans/2026-09-11-epub-virtual-toc.md <BASE> <HEAD>
```

Task 5 的 BASE = `38d26c41b`。任务简报文件已预生成在 `.superpowers/sdd/2026-09-11-epub-virtual-toc/task-{5,6,7,8}-brief.md`。

## 我做过的裁决（Rulings）

按时间顺序，每条附"若判断错误"的代价：

1. **R1：直接在 `readest-local` 实施，不建 worktree。** 依据：这是用户的个人工作分支，此前所有功能（含 TXT 引导）都在同分支直接提交。代价：无额外成本；用户的 WIP 与功能提交会在同一分支交织。
2. **R2：`applyVirtualToc` 先剥离既有虚拟条目（`id < 0`）再判"健康目录"。** 否则"重新生成"会被 health 守卫拒绝、无法替换（Task 8 E2E 步骤 6 必失败）。代价：若将来出现合法的负 id 真实目录项会被误删——当前 foliate 真实 TOC id 均非负。
3. **R3：Task 2 简报夹具 `epubcfi(/6/4!)` 视为缺陷，改夹具而非改实现。** 抽取必须与 `buildFragmentCfi` 逐字一致（无条件 `joinIndir`），不得加 `!)` 特判。代价：若确有生产者输出 `!)` 形态会得到 `!!`——与原实现行为相同，非本次引入。
4. **R4：Task 4 三处偏离（自定义规则独占、`countChapterMatches` 重载判别、`buildEntryCfi` 特判）全部回归已发布接口。** ① 自定义正则**叠加**内置规则（沿用 Task 1 引擎契约）；② 单一签名 `(bookDoc, pattern, language?, onProgress?)`；③ 夹具改 `epubcfi(/6/4)`、直用 `buildElementCfi`。代价：若产品真实意图是"自定义规则独占"（用户写明规则后放弃内置识别），需改回独占并把测试期望从 2 改回 0——但那样用户加一条规则会丢掉已有内置命中，判定为不合理。

## 延后的小问题（Minor，供最终审查 triage）

- chapterRules 缓存键 `${language}${patterns.join('')}` 无分隔符，理论可碰撞（原样搬运；当前单元素数组用法不触发）
- chapterRules 多导出了 `ZH_NUMBER`/`isNumChar` 等无外部消费者的辅助符号
- 缺 chapterRules 缓存契约测试（存源而非 RegExp 实例、每次返回新实例）
- `elementCfi.ts` 的 `CFI as unknown as CFIModule` 断言沿用原文
- `apply.ts` 对非可选 `rendition` 用可选链；`virtualTocToItems` 的 `index: 0` 是占位
- element-cfi 首个断言判别力偏弱（`fromElements` 返回空串也会通过前缀断言）
- scan 的 countOnly 仍为每次命中分配对象；`generatedAt` 取扫描开始时间；空 sections 不触发 `onProgress`

## 验证方法

门禁（工作目录 `apps/readest-app`）：

```bash
npx tsgo --noEmit
npx biome lint .
npx dotenv -e .env -e .env.test.local -- npx vitest run
```

Task 8 端到端（样本书：`C:\Users\30575\Downloads\371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub`——Pixiv 下载器 EPUB：8 万字单 HTML、15 处"第X章"文本行、NCX 仅 3 个结构条目）：

1. 侧栏目录页显示空态 + "从正文生成目录"入口
2. 弹窗内置规则预览命中 15 处
3. 点生成 → 目录出现 15 条；点击可跳转（CFI 生效）
4. 关书重开目录仍在；`Books/{hash}/config.json` 含 `virtualToc`
5. 重新生成 → 条目替换而非叠加（R2 语义）
6. 健康目录的普通 EPUB → 无空态、无生成入口

## 注意事项

- **不要动工作树里用户未提交的 WIP**：`library/page.tsx`、`library/utils/authorGrouping.ts`、`library/utils/libraryUtils.ts`、`reader/components/sidebar/SearchResults.tsx`、`reader/components/sidebar/SideBar.tsx`、`services/librarySearchService.ts`、`utils/cfi.ts` + 未跟踪的 `__tests__/utils/batched-cfi.test.ts`。这些与计划触碰文件零重叠。
- 本次 6 个提交**尚未推送**；计划文件与本交接文档也未提交（上一轮用户明确清理过 docs 产物，是否入库由用户定）。
- 基线：Task 1 之前全量 5850 用例通过、tsgo 干净；每个任务的审查者都独立核对过消费接口签名。
