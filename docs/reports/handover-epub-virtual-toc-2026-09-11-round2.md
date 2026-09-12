# 交接文档：EPUB 虚拟目录（第二轮 · Task 5–12）

- 日期：2026-09-11（同日第二轮交接）
- 分支：`readest-local`（fork：`https://github.com/bfzds/readest-local.git`）
- 计划文件：`docs/superpowers/plans/2026-09-11-epub-virtual-toc.md`（Task 1–8 + 执行期新增的 Task 6.5）
- SDD 工作区（ledger / 简报 / 报告 / 审查包，git-ignored）：`.superpowers/sdd/2026-09-11-epub-virtual-toc/`
- **本文件取代**第一轮交接 `docs/reports/handover-epub-virtual-toc-2026-09-11.md`（那份写于 Task 4 之后，其"剩余任务"已全部完成或改写）

## 一句话现状

功能全链路（正则扫描 → 生成 → 持久化 config → 侧栏显示 → 点击跳转 → 当前章节高亮）**已可用**，并经过用户真机验证驱动的**四轮修复 + 一次渲染层（子模块）改动**。

从计划基线 `9dfd12d43` 起共 **27 个提交**，其中 **5 个未推送**；子模块另有 **2 个本地-only 提交**（详见"必须知道的坑"第 1 条）。当前 `HEAD = e7f2b1dcb`，子模块 `HEAD = 9d17e74`。

**还剩 4 件事**（2026-09-12 接手收尾：**四项全部完成**——① 推送 `f7bff79ca..fbb9af320` 共 10 个提交（钩子两度全绿）、② `f84dc9ea0`、③ `750916a8c`、④ 终审 `fbb9af320`（三路审查 + 52 条 triage + 修复轮 + 复审，全量 5960 passed + 1 绊线如期），详见 ledger 第三、四轮）：遗留非阻塞项——子模块 fork 化（R37）、triage 待定 2 条（L128/L242）、scan 短章书兜底正解（R48，独立任务）、docs 产物是否入库。

## 一、功能是什么

让「目录元数据缺失或退化（例如 NCX 只有『信息 / 目录 / 全文』这种文件级条目）、但正文里有章节文本行」的 EPUB，能通过 **正则预选 + 命中预览** 的引导弹窗生成一份**虚拟目录**，存进这本书的 `config.json`（**用户数据**，不重写 EPUB 文件），侧栏目录与点击跳转立即可用，重开书不丢失。

三层结构：

1. **共享章节正则引擎**（`src/utils/chapterRules.ts`）——从 TXT 转换逻辑抽出，TXT/EPUB 共用，含 LRU 源缓存与 ReDoS 守门。
2. **扫描/合成服务**（`src/services/virtualToc/`）——`scan.ts`（块元素匹配规则 → 元素级 CFI）、`synthesis.ts`（按 section 边界合成）、`apply.ts`（合并进 `bookDoc.toc` / 剥离 / 识别虚拟条目）。
3. **阅读端接线**——`store/readerStore.ts` 打开路径合并 + `sidebar/Content.tsx` 空态/退化态入口 + `VirtualTocDialog.tsx` 弹窗 + `TOCView/TOCItem` 高亮。

## 二、提交与分支

| 主题 | 提交 | 状态 |
|---|---|---|
| Task 1–4：正则引擎 / 元素 CFI / 条目类型与 apply / 扫描器 | `9c8026485` `d2412dd19` `f945eb498` `bca30a795` `7ea6b9050` `38d26c41b` | 已推送 |
| Task 5：section 合成 | `9be35954e` `4542cde68` | 已推送 |
| Task 6：打开时应用 + 侧栏入口 | `c2ae140ff` `0108d9ead` | 已推送 |
| Task 6.5：退化判据 slab 化 + 入口条件 + 退化非空态 | `f8bbc0c1f` | 已推送 |
| Task 7：完整弹窗（含语言码归一化、取消世代守卫） | `5855e1f8f` `2f198c5d1` `491916a9b` | 已推送 |
| 启动脚本 | `f7bff79ca` | 已推送（**远端最新**） |
| Task 9：四项真机修复（噪声 / 簇 / 空三角 / 页码） | `08fbca8a6` `8633f175b` `8491fb4a2` `cf177b145` | 已推送 |
| Task 10：切书崩溃修复（浅拷贝丢原型 + 打开路径自愈） | `4f6b49bbd` `a772b7689` `e3501cbd7` | 已推送 |
| Task 11：nav.json 自愈 + 当前章节高亮 | `a02e52fb1` `1bc827877` `68f2bfe03` | **未推送** |
| Task 12：元素级跳转顶部让距（方案 A，改子模块） | 父 `4f7fd2c9f` `e7f2b1dcb`；子模块 `9aac102` `9d17e74` | **未推送**（子模块提交本地-only） |

## 三、四个真机问题与修法（这段是最有价值的上下文）

### 问题 1：目录重复，且每次打开多一轮 → 已修（Task 11 A+B）

**根因**：`computeBookNav` 读的是**当前内存里的 `bookDoc.toc`**（`services/nav/index.ts` 的 `cloneTocItems(bookDoc.toc ?? [])`），而它已含上次合并进去的虚拟条目 → 结果被 `saveBookNav` 写进 **`nav.json`**（**违反了「nav.json 不承载虚拟条目」的设计约束**）→ 导航管线在那里把这些条目 **id 重新编号成非负**（`services/nav/locations.ts` 的 `id ??= index++` 配合上游丢 id 的对象）→ 而"剥离虚拟条目"的判据是 `id < 0` → **再也认不出来** → 每次打开残留一批 + 追加 7 条。

**修法**：
- **A**：虚拟条目的识别判据换成 `CFI.isCFI.test(item.href)`（href 是不是 CFI 串）`|| id < 0`；
- **B**：在 nav 计算**之前**调 `stripVirtualTocItems(bookDoc)`（只改内存，不写 config/不碰 nav.json）。

**实测效果**：用户的 `nav.json` 从 17 条（3 真实 + 14 幽灵）**自愈回 3 条**。

**⚠️ 未完成的一半**：生产环境命中 nav 缓存时（`isBookNavCacheCurrent && NODE_ENV === 'production'`）走 `hydrateBookNav`，**不会重写 nav.json** → 那份污染**永远不会被清干净**；只要 `applyVirtualToc` 因任何原因返回 false（目录不再算退化 / config 里虚拟目录被清空 / 固定版式），幽灵立刻变成可见的重复。补强方案见"待办 ②"。

### 问题 2：当前章节没有书本图标 → 已修（Task 11 C，含一轮修复）

**根因**：高亮判定是字符串相等（`activeHref === item.href`），`activeHref` 来自 `progress.sectionHref`（section 的**文件路径**），而虚拟条目的 `href` 是 **CFI 串** → 永不相等。

**修法**：虚拟条目改用**位置区间**判定——`Math.round(progress.fraction * location.total)` 落在 `[location.current, location.next)` 即视为当前章节；真实条目保持 href 相等。

**一轮修复（R35）**：第一版区间匹配跑在**全部条目**上，而真实条目会被导航管线写入覆盖**整本书**的 location（样本书那条书名条目是 `1..179`）→ `find` 先命中真实条目返回它的 key → 虚拟条目永远匹配不上。已改为**只对虚拟条目做区间匹配**。

### 问题 3：跳转后章节标题被页眉遮住 → 已修（Task 12 · 方案 A，改子模块）

**根因（已逐行核实）**：
- 虚拟条目 href 是 CFI → `packages/foliate-js/view.js` 的 `resolveNavigation` 判为 CFI → `resolveCFI` → 锚点是 **Range** → `paginator.js` 的 `#scrollToAnchor` 走 **rect 分支** → `#scrollToRect` 在 scrolled 模式下把**元素盒精确对齐到滚动区顶部**；
- 真实条目 href 是路径 → `book.resolveHref` → 锚点是**数字** → 走 **fraction 分支**（section 起点），落点略低；
- 用户设置实测（`%APPDATA%\com.local.readest\settings.json`）：`scrolled = true`、**`showHeader = false`**、`compactMarginTopPx = 16`；
- 而 `FoliateViewer.tsx` 里 `scrollMargins.top = headerVisible ? topMargin : 0`，`showHeader=false` → **0**（完全不预留）；但顶部有一个**悬停浮现**的 `HeaderBar`（**与 `showHeader` 无关**），高 **44px**（`h-11`）、浮现时不透明 → 一浮现就盖住标题上半截。

**为什么没走方案 B**：B 是把 `scrollMargins.top` 在页眉关闭时也设成 ≥44 → 滚动区**日常恒留 44px 空白**（用户关页眉正是为了要空间）；改成"浮现时动态加"则阅读时内容**跳动**。两者都是日常体验退化。

**方案 A（已落地）**：
- 子模块 `paginator.js`：新增 `overlay-top-inset` 设置（默认 **0**，未设置时行为与改动前**逐字一致**），只在 `#scrollToRect` 的 **scrolled 分支**从最终 offset 里减掉；**paginated 分支未动**；
- readest 侧：`utils/insets.ts` 导出 `HEADER_BAR_HEIGHT_PX = 44`（`HeaderBar` 的 `h-11`，也被 `getHeaderTriggerHeight` 复用），`FoliateViewer.tsx` 只在 **`scrolled && !showHeader && !isVertical`** 时传 44px（`isVertical` 含 `writingMode.includes('vertical')`）。

**一轮修复（R39）**：第一版漏了竖排判断 → 「竖排 + 滚动」也会传 44px，而该模式**滚动轴是水平的**（`paginator.js` 在 `#vertical` 时用 rect 的 left/right 当主轴、`scrollProp = scrollLeft`、还有 `offset = -offset`）→ 会变成**横向 44px 偏移**且完全没解决纵向遮挡。已加竖排判断 + 补守门测试。

**证据**：浏览器测试（真实 Chromium）3/3，数值级——横排 `unset` 与 `0px` 落点完全相同（1968）、`44px` 精确偏 44（1924）；竖排 `unset/0px` 完全相同（-4580）。

### 问题 4：书自带的"书名条目"永久高亮 → **未做**

样本书 NCX 第 3 条 label 就是书名、指向整本正文文件（`OEBPS/page-0.html`），其实测 `location = 1..179`（覆盖整本书）。因为整本正文只有**一个 section**，而真实条目的高亮是 `当前 sectionHref === item.href` → **只要在读书它就恒亮**；用户也觉得"书名出现在章节列表里"很怪。

**推荐方案 B**（外部建议 + 我认同）：按**可导航跨度占比**判定「这条目录没有章节粒度」，让它**不参与当前章节高亮**：

```
条目无 fragment，且 (location.next - location.current) / location.total ≥ 约 80–90%
```

样本区分度：书名条 99.4%、"信息" 0.6%、"目录" 0% → 不会误伤前两条。建议**复用 `isTocDegraded` 里 slab 的语义/常量**，别养第二个魔法阈值。

（不要用 `current === 0 && next === total` 的等值判据——实测那条是 `1..179`，两头都会漏。）

## 四、必须知道的坑（接手前先读）

1. **子模块指针本地-only（R37）**：`.gitmodules` 里 `packages/foliate-js` 的 remote 是上游 `https://github.com/readest/foliate-js.git`（**没有推送权限**）。子模块当前**领先 `origin/main` 10 个提交**（既有实践，全是中文本地提交），其中 `9aac102` / `9d17e74` 是本轮新增。后果：父仓库指针指向远端不存在的 commit，**换机器 / 别人 clone 时 `git submodule update` 拿不到**。要真正共享，需要先有可推送的 fork 远端并改 `.gitmodules`（本轮**刻意没改**）。
2. **`nav.json` 是本功能的历史雷区**：虚拟目录**绝不能**写进它（那是缓存文件，随 `BOOK_NAV_VERSION` 整体失效重建）。目前只做到"识别 + 剥离"，"不写入"的结构性保证还没做（见待办 ②）。
3. **`stash@{0}` 是用户的数据**：lint-staged 于 2026-09-06 留下的自动备份（SHA `c2fdf3d1b`，含 `package.json`、`TOCFloatingButton.tsx`、`pnpm-lock.yaml` 等 6 个文件）。**不要 drop / pop / apply**。本轮多次核实它始终在 `stash@{0}`。
4. **用户的工作树 WIP 不要碰**（与本次功能零重叠）：`apps/readest-app/src/app/library/page.tsx`、`app/library/utils/authorGrouping.ts`、`app/library/utils/libraryUtils.ts`、`reader/components/sidebar/SearchResults.tsx`、`sidebar/SideBar.tsx`、`services/librarySearchService.ts`、`utils/cfi.ts`、未跟踪的 `__tests__/utils/batched-cfi.test.ts`。另外根目录 `dev-desktop.ps1` / `启动桌面开发.bat` 是本轮新建**已入库**的工具；`_dsh_log_tmp/` 是 **DSH harness 自身产物**，非项目文件。
5. **全量门禁有一个既有的 flake**：`src/__tests__/services/native-app-service-share.test.ts` 在并行全量下偶发超时（5s 阈值）→ 连带 mock 计数断言失败。已核实与本功能无关（该测试只 mock Tauri 插件、`nativeAppService.ts` 不 import 我们改的模块；单跑 3/3 绿；同 HEAD 重跑有绿有红）。
6. **阅读设置会影响本功能的表现**：用户的实测设置是 `scrolled = true`、`showHeader = false`、`marginTopPx = 44` / `compactMarginTopPx = 16`、`vertical = false`。验问题时先看这几个值（`%APPDATA%\com.local.readest\settings.json`，注意该文件有重复键，PowerShell 的 `ConvertFrom-Json` 会报错，用 Node 读）。
7. **`bash` 在本机不可用**（WSL 无发行版、无 Git Bash）→ subagent-driven-development skill 的三个脚本（`sdd-workspace` / `task-brief` / `review-package`）**跑不了**，控制方一直用**手工命令**生成审查包：把 `git log --oneline BASE..HEAD`、`git diff --stat`、`git diff -U10` 追加写进一个 `.diff` 文件（跨子模块时还要追加 `git -C packages/foliate-js diff`）。
8. **文件策略与命令**：本机 DSH 会话为 `danger-full-access`；全量单测约 **100 秒**、browser 套件更久，建议后台跑。

## 五、待办（4 项，建议顺序）

### ① 推送（✅ 2026-09-12 已完成：`f7bff79ca..74ebcffbf` 共 8 个提交，pre-push 钩子全绿；曾因 `_dsh_log_tmp/` 未被 git 忽略卡住 format:check，已加 .gitignore 修复。子模块 2 提交仍本地-only，fork 取舍按用户裁定留待将来）

```bash
git push origin readest-local     # 会推 a02e52fb1..e7f2b1dcb 共 5 个
```

推送前须知悉"坑 1"：**子模块那 2 个提交只在本机**，父指针在远端不可达。若要真正共享，需先决定：给 foliate-js 建可推送的 fork 并改 `.gitmodules`（影响所有协作者），或者接受"仅本机可用"。

### ② `nav.json` 污染的结构性补强（✅ 2026-09-12 已完成，commit `f84dc9ea0`）

外部评审建议 + 我核实后认同的三步：

1. **把 nav 的输入显式化**：`computeBookNav(bookDoc, realToc)`，或解析时把原始 TOC 存成 `bookDoc.parsedToc`（nav 只读它、apply 永不写它）→ 这样 `strip` 的调用顺序不再是正确性的前提；测试可直接断言「nav 忽略显示层 TOC」。
2. **在缓存边界立不变量**：`isBookNavCacheCurrent`（`services/nav/index.ts`，目前只判 `version`）增加「toc 含 CFI-href 条目即判失效」（触发重算 + 回写干净缓存），并在 `saveBookNav` 侧过滤虚拟条目。
3. 守门测试两条：污染缓存（version 正确 + 含 CFI-href）被判失效并重写干净；`saveBookNav` 丢弃 CFI-href 条目。

（A 的 CFI 判据保留——那是正确的身份判定。）

### ③ 问题 4 的方案 B（书名条目高亮）（✅ 2026-09-12 已完成，commit `750916a8c`：`WHOLE_BOOK_SPAN_RATIO = 0.9` + `isWholeBookTocItem`，href 相等分支排除，条目仍显示）

按"四、问题 4"里的**可导航跨度占比**判据实现：这类条目**不参与当前章节高亮**（真实条目仍走原 href 相等判定）。要补守门测试：跨度占比 ≥ 阈值的真实条目不参与高亮、且不与虚拟条目的区间匹配抢 key。**不要**现在做"从列表里隐藏条目"那种启发式删除（太重，且对某些用户它是"回全文开头"的锚点）。

### ④ 全分支终审 + 积压小问题 triage（✅ 2026-09-12 已完成：三路并行终审（A 引擎/B 接线/C 子模块）+ 52 条 triage 全量核实 + 修复轮 `fbb9af320`（终审 findings F-1/M1/M2/B-m1 等七处缺陷修复 + triage 建议修 4 项）+ 独立复审（B1 i18n、M1' 预检挪位由控制方亲手修）；R48 裁定短章书兜底暂不做（纯位置守卫经算术证明不可行），留 it.fails 绊线；triage 待定 2 条留用户）

用最强模型跑 `MERGE_BASE..HEAD` 的整体审查（MERGE_BASE = 计划基线 `9dfd12d43`），把 ledger 里约 **40 条 `deferred minor`** 逐条 triage。终审要特别盯：

- 坑 1（子模块指针）与坑 2（nav.json 只修了一半）；
- `apply.ts` 的 `isTocDegraded` 存在量词偏宽松（"无锚点 slab 或 多章各 1 锚点"都判退化，代价仅为多一个入口）；
- `scan.ts` 内嵌目录簇判据的固有代价：**短章书**（每章"标题 + 1 段"，候选间隔 ≤3）可能被整簇误杀、目录变空（样本未暴露、无测试）；
- Task 12 的 Minor：clamp 无测试、测试把"竖排仍会沿横轴推 44px"钉成期望、`Math.abs(gap)` 放宽；
- Task 5/9/10/11 的零散 Minor（ledger 有全量清单）。

## 六、关键设计约束（不要违反）

- 虚拟目录是**用户数据** → 存 `Books/{hash}/config.json`，**不写入 `nav.json`**、**不 bump `BOOK_NAV_VERSION`**、不在 `computeBookNav` 内合并。
- 只在 **EPUB**（`book.format === 'EPUB'`）且非 **fixed-layout**（`rendition.layout === 'pre-paginated'`）时提供入口与合并，与 nav 管线门禁一致。
- **手写正则是主权行为**：`pattern` 非空时**不做**噪声过滤、**不做**内嵌目录簇丢弃（只有内置规则路径才过滤）。同时注意 `buildChapterRegexps` 是**叠加**语义（用户规则在前、内置规则兜底）——这是既有设计。
- 合并顺序：`strip` → nav 块（`computeBookNav` / `hydrateBookNav`）→ `applyVirtualToc` → `updateToc`。
- 提交信息用**中文** conventional commits（仓库惯例）。

## 七、验证方法

```bash
# 工作目录 apps/readest-app
npx tsgo --noEmit
npx biome lint .
npx dotenv -e .env -e .env.test.local -- npx vitest run                 # 全量单测（约 100s；当前 5936 passed / 10 skipped）
npx dotenv -e .env -e .env.test.local -- npx vitest run --config vitest.browser.config.mts   # 浏览器测试（含 paginator 套件）
```

**样本书**：`C:\Users\30575\Downloads\371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub`
（Pixiv 导出：单 HTML `page-0.html` 267KB、`dc:language = zh-cn`、NCX 仅 3 条结构条目「信息 / 目录 / 书名」；正文开头还有一段**内嵌目录列表**，与真实标题形状相同——属**预期数据怪癖**，不是缺陷。）

**四条真机验收**（需重启 dev server，因为改过子模块渲染代码）：

1. 打开样本书 → 侧栏显示 **2 条结构条目 + 7 条虚拟章节目录**（不是三轮重复，也不是空态）
2. 滚动到某一章 → 该章条目左边出现**书本图标**
3. 点一条虚拟目录条目 → **章节标题完整可见**（不被页眉切掉上半截）
4. 点标注 / 搜索结果跳转 → 落点同样避开页眉

**其它验收**：生成后 `config.json` 含 `virtualToc`（7 条、CFI 跳跃、带 `location`）；`nav.json` 只含真实条目（打开一次后）；关书重开目录仍在；重新生成是**替换**不是叠加。

## 八、如何继续（流程）

- **ledger 是唯一的恢复地图**：`.superpowers/sdd/2026-09-11-epub-virtual-toc/progress.md`，里面有全部裁定（R1–R39，含每条的成本/代价）、每个任务的状态行、以及约 40 条 `deferred minor`。**先读它**，再读本文件。
- 任务简报（`task-N-brief.md`）、实现者报告（`task-N-report.md`）、审查包（`review-*.diff`）都在同一目录，可按主题翻阅。
- 本轮一直用 **subagent-driven-development** 流程（每任务：简报 → 派实现者 → 控制方独立复跑 → 生成审查包 → 派审查者 → 必要时一轮 fix + 定向复审 → ledger 记 complete）。该 skill 的三个脚本因无 bash 跑不了（见坑 7），审查包是手工生成的。
- 当前状态：`HEAD = e7f2b1dcb`、子模块 `HEAD = 9d17e74`、远端 `origin/readest-local = f7bff79ca`、27 个提交（5 个未推送）。
