# 交接文档：搜索栏性能开销（书内搜索常用字卡顿）

- 日期：2026-09-12
- 分支：`readest-local`（fork：`https://github.com/bfzds/readest-local.git`）
- 状态：**根因诊断完成（数据实锤），修复未动手**。测量设施已就位，性能基准补全进行中。
- 关联文档：`docs/reports/handover-epub-virtual-toc-2026-09-11-round2.md`（功能侧交接，与本主题无代码交集）

## 一句话现状

「搜索栏搜常用字（的/地/我/你）不及预期」的根因已用计时 harness 数据实锤：**不在搜索匹配本身，而在「CFI 生成」与「高亮回放」两段**——真实样本（Pixiv 导出扁平 DOM）上主线程冻结 ≈ CFI 生成 ~5.5s + 回放 ~11.3s。历史优化全部打在绘制层，这两段从未被优化过。

## 一、问题与测量方法

- 用户报告：书内搜索常用字性能依旧不及预期（「依旧」= 此前优化过仍不满意）。
- 方法（diagnosing-bugs 流程）：链路探查 → 计时 harness（真实 Chromium browser 段 + node/jsdom 对照段）→ 真实用户样本接入。
- 测量书：①合成书（8 万字中文、「的」密度 4%、单节 321 文本节点，任何人可复现）；②用户真实样本 `371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub`（8.96 万字**单节 7083 文本节点**的扁平 DOM，Pixiv 导出；**git-ignored 私人文件，绝不提交、内容绝不打印**）。

## 二、链路事实（先纠正直觉，这决定优化方向）

书内搜索**不走 foliate-js/search.js 的匹配器**（那条路在本应用是死路径）。实际流程（`SearchBar.tsx:196-337`）：

1. **匹配**：`searchLibraryBooks`（与书库页共享，`librarySearchService.ts`）——contains 模式**主线程**逐节匹配（`containsSearch.ts` 的 foldText + indexOf；8ms 让步一次）。`maxResultsPerBook: Infinity`（上限被 `a6f118aa4` 解除，移植上游 #5728）。
2. **CFI 生成**：每节结果 `resolveSearchResultCfis`（`librarySearchService.ts:1097-1146`）——`createDocument` + textWalker + **batchedCfi**（按 (startNode,endNode) 节点对缓存 CFI 模板，`batchedCfi.ts`）。
3. **高亮回放**：`view.search({ results })`（`SearchBar.tsx:307` → foliate `view.js:633-691`）——对每条 CFI 调 `addAnnotation`（`resolveNavigation` → `CFI.toRange` → `overlayer.add` → getClientRects → SVG）。**生成器无任何让步，addAnnotation 未 await**。

历史三个优化提交（子模块 `01919e9` 矩形合并单 path、`e239650` 高亮改填充遮罩、`33d450d` 滚动 rAF 合并）**全部在绘制层**——单条高亮怎么画；瓶颈却是「几千条怎么调度、每条定位多贵」。

## 三、根因 1：回放微任务风暴（合成书实锤）

8 万字合成书搜「的」3200 命中，真实 Chromium 分段计时：

| 段 | 耗时 | 占比 |
|---|---|---|
| contains 匹配（提取+fold+3200 次 indexOf） | 2–5ms | <1% |
| CFI.fromRange 逐条（未优化对照） | 1123ms | —（生产走 batchedCfi = 104ms，已优化） |
| **view.search 回放 3200 条** | **1706ms = 单个 longtask** | **主导** |
| clearSearch（清旧注解） | 61.5ms | 次级 |
| 二次回放（近似翻页/resize 重放） | 1608ms = 单 longtask | 同量级 |

冻结直接证据：longtask 检测仅 **1 个 >50ms 块、长 1705ms**（零宏任务让步）；`setTimeout(0)` 饥饿 1711ms；每条 addAnnotation 的 await 兑现延迟 ≈ 整场风暴时长（全部排同一场微任务洪流）。

回放内部构成：**`CFI.toRange` 63%**（每条从 DOM 根重新定位，无缓存）+ SVG 构建 25% + resolveNavigation 4% + getClientRects 2%（优化过的部分确实已经不是问题）。

## 四、根因 2：扁平大 DOM 上 batchedCfi 模板失效 + toRange 单价暴涨（真实样本实锤）

用户样本搜「的」1933 命中：

| 指标 | 合成书 | 真实样本 | 恶化 |
|---|---|---|---|
| 回放总耗时（单 longtask） | 1365–1432ms | **10868–11289ms** | **8 倍** |
| `CFI.toRange` 单条 | 0.28ms | **5.25–5.46ms** | 19 倍 |
| batchedCfi 生成单条（Chromium） | 0.03ms | **~2.8–3.0ms** | ~100 倍 |
| overlayer.add 单条 | 0.12ms | 0.33ms | 2.7 倍（SVG 量级） |
| resolveNavigation 单条 | 0.02ms | 0.03ms | 持平 |

机理：Pixiv 导出把近 9 万字塞进**一个 section 的 7083 个文本节点**（扁平 DOM）。两个恶化条件叠加——① DOM 越大，每条 CFI 从根定位路径越长（toRange 19 倍单价）；② 命中散落在七千个不同 (startNode,endNode) 节点对上，**batchedCfi 的节点对模板缓存命中率归零**，退化为逐条完整 `CFI.fromRange` 且单价更高。

**真实书搜高频字的总主线程开销 ≈ CFI 生成 ~5.5s + 回放 ~11.3s ≈ 17s 冻结。**

## 五、排除项（别在错误方向上花时间）

- contains 匹配/foldText：极便宜（<5%），主线程路径无需 worker 化；
- getClientRects：已便宜（2%）；
- resolveNavigation：已便宜（4%）；
- 结果数上限：`a6f118aa4` 解除上限是产品决策，量级放大是它的自然结果，不该回退——该优化的是每条成本与调度。

## 六、测量设施（已就位）

- **`src/__tests__/diagnostics/search-perf.browser.test.ts`**（真实 Chromium）：合成书 + 真实样本双用例，回放段分段计时（monkey-patch 仅文件内）+ longtask + 宏任务饥饿探测。跑法：`npx dotenv -e .env -- npx vitest run --config vitest.browser.config.mts src/__tests__/diagnostics/search-perf.browser.test.ts`。
- **`src/__tests__/diagnostics/search-perf-node.test.ts`**（node/jsdom）：contains 全链路 + resolveSearchResultCfis 对照。注意 jsdom 绝对数字比真实 Chromium 慢 ~3 倍，只做同机 before/after。
- 两者：夹具缺失自动 skip（他人 clone 不挂）；输出**只有数值**（节数/节点数/命中数/耗时），书内文本零打印——这是用户隐私约束，违反即事故。
- 已随 `8cbf6de61` 提交。⚠️ 该提交因网络 TLS 错误**尚未推送**（重试 3 次失败，本地安全，网络恢复后 `git push origin readest-local`）。

## 七、性能测试体系空白（补全中）

仓库有三层性能设施：`pnpm bench` 框架（手动、刻意不进 CI——README 载明 CI 方差 2–10×，门禁靠生产遥测 `reedy_metrics`）、`search-highlight-perf.test.ts`（评估型无阈值）、本轮 diagnostics（诊断型无阈值）。**空白：唯一搜索基准 `library-search.bench.ts` 只测书库搜索，书内搜索链路三层全不覆盖**——这是历次优化方向跑偏未被数据挡住的制度性原因。

**进行中**：按 bench 框架约定补 `bench/inbook-search.bench.ts`——S1 contains-match（合成书纯文本）+ S2 cfi-resolve-synthetic（jsdom，同机 before/after 口径）+ S3 cfi-resolve-real-fixture（存在才跑，private）。回放段留在 browser harness（bench 的 node 环境无布局引擎）。

## 八、修复方向（未动手，按收益排序，待用户指示）

1. **CFI 定位批量化/缓存**（治总耗时，真实样本上收益最大）：按 (startNode,endNode) 对缓存 toRange 定位路径（batchedCfi 思路下沉到回放段），或搜索阶段把 Range 直接带给回放（避免 CFI→Range 往返）；
2. **回放分片让步**（治卡死感，改动最小）：addHighlights 循环每 N 条 `setTimeout(0)`/`requestAnimationFrame` 让一帧，把 11s 单块切成小片；
3. **跟随改善**：clearSearch O(N)、翻页/resize 的 overlay 全量重放，在前两项落地后重测再议；
4. 修复轮必须用第六节 harness + 新 bench 做 before/after——合成书与真实样本（若在机）双口径。

## 九、注意事项（接手前先读）

1. **隐私红线**：真实样本 EPUB 在 `src/__tests__/fixtures/data/`（目录本身被 git 跟踪），该文件已单独加 `.gitignore` 条目（`git check-ignore` 验证过）；**任何输出（测试日志/报告/PR）出现书内文本即事故**，只允许数值。
2. `librarySearchService.ts`、`SearchResults.tsx`、`SideBar.tsx`、`utils/cfi.ts`、`library/page.tsx` 等有**用户未提交 WIP**（书库搜索/分组相关工作），做修复轮前先 `git status` 核对，触碰面要与用户确认。
3. view.js/overlayer.js 改动会落在 `packages/foliate-js` 子模块——**现在有可推送 fork**（`bfzds/foliate-js`，`.gitmodules` 已指过去），子模块提交可直接推，不再有本地-only 问题。
4. 诊断期间的量级结论基于 2026-09-12 的 HEAD（`8cbf6de61` 附近）与本机硬件（Windows x64），换硬件后绝对值会漂，相对占比稳定。
5. `bench/results.jsonl` 是 gitignored 的本机历史，bench 跑完记得它只代表本机。

---

## 附录（2026-09-12 同日）：修复轮完成

接手后按第八节方向 1+2 落地，**未触碰任何 WIP 文件**（7 个未提交改动文件保持原样）。

### 改动面

- `packages/foliate-js/epubcfi.js`：`indexChildNodes` 计算结果参数化注入；新增 `createIndexCache(filter)`——批次作用域 WeakMap 记忆化。
- `packages/foliate-js/view.js`：新增 `#cfiIndexCache`；`search()` 回放激活批次缓存 + 每 ~30ms `setTimeout(0)` 让帧（跨帧重置缓存）；`#createOverlayer` 的翻页/resize 重放同步循环内激活缓存；`resolveCFI` 两条分支（book.resolveCFI / fallback）按「创建时快照」注入缓存。
- `packages/foliate-js/epub.js`：`Resources.resolveCFI`/`EPUB.resolveCFI` 接受可选 `getIndexCache(doc)` 参数——**关键接线点：EPUB 一律走 book.resolveCFI，view.resolveCFI 的 fallback 分支对 EPUB 是死路径**，第一版漏掉它导致真实样本 toRange 无改善。
- `apps/readest-app/src/utils/batchedCfi.ts`：节点对模板失效退化出的逐条 `CFI.fromRange` 走批次缓存。

### 正确性设计

- 缓存按「批次」作用域：单个同步批次内 DOM 不可能变（微任务风暴不跨宏任务）；回放分片让帧后跨帧一律重置缓存——分页器 resize 重构 DOM 不会吃到失效列表。
- anchor 在创建时快照所属批次缓存（`resolveCFI` 在 `addAnnotation` 同步前缀内执行），微任务晚执行不影响归属。
- 让帧点在 `addHighlights` 内按 `performance.now()` 计时（30ms），与硬件/单价解耦。

### 实测（本机 Windows x64，browser harness 双用例 before/after）

| 指标 | before | after |
|---|---|---|
| 真实样本 batchedCfi 生成（1933 条） | 6299ms | **102ms** |
| 真实样本 回放#1 总耗时 | 12237ms | **448ms** |
| 真实样本 `CFI.toRange` 单条 | 5.85ms | **0.03ms** |
| 真实样本 回放#2（翻页/resize 重放） | 12382ms | **482ms** |
| 宏任务饥饿（真实样本） | 12240ms | **31.3ms** |
| longtask 最长块（真实样本） | 12236ms×1 | **无（#2 一个 63ms小块）** |
| 合成书 回放#1 / 饥饿 | 1730ms / 1734ms | 795ms / **32.4ms** |
| 合成书 toRange 单条 | 0.34ms | 0.01ms |

合成书回放总耗时 1730→795ms；真实样本用户可感口径：**搜「的」整书从 ~17s 冻结变为 ~0.55s 分片流畅渲染，无 >50ms 冻结**。

### 回归

- foliate-js 侧：app 内 86 个 CFI 相关单测（epubcfi-skip/inert/ruby、cfi、batched-cfi）全过；上游 `tests/epubcfi-tests.js` 需浏览器 DOM（tests.html），未跑。
- app 全量：`456 文件 / 5963 tests` 全过（含两段 diagnostics harness）。

### 遗留

- 第八节方向 3（clearSearch O(N)、跟随改善）：回放段已到 0.45s 量级，clearSearch 61ms不再是主要矛盾，暂缓。
- 第七节 bench/inbook-search.bench.ts：未补（`bench/_probe.ts` 仍是从前会话的半成品）；diagnostics harness 双口径已能覆盖 before/after 门禁诉求。
- SVG 构建成本（overlayer.add ~0.12ms/条，占优化后回放一半以上）是下一个可选优化点，量级已不构成冻结。
