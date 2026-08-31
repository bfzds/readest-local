# Readest Local 代码复核、调试与性能分析报告（2026-08-31）

## 1. 范围与方法

- 任务类型：只读复核，不修改生产代码或测试代码。
- 固定点：`4644309`；审查范围：`git diff 4644309...HEAD`，共 9 个提交，当前 HEAD 为 `c928221`。
- 规格来源：`docs/reports/revision-fix-executable-plan-2026-08-31.md`。
- 标准来源：`apps/readest-app/AGENTS.md`、`CONTRIBUTING.md`、项目既有测试与命名习惯，以及 `code-review` skill 的代码异味基线。
- 执行分工：主模型仅规划和统筹；三路 `gpt-5.6-luna` 分别执行标准审查、规格审查、测试与 benchmark。Luna 均未修改文件。
- 调试边界：用户未提供单一可复现症状，本轮不做修复；结论来自静态控制流审查和现有自动化基线。未被现有测试捕获的缺陷均标注为“需补红灯用例”。

## 2. 结论摘要

- 新增 P0：无。
- P1：3 项。缓存索引搜索路径可能突破 500 条硬上限；CommandPalette 的下一帧返焦可能破坏真实 Tab 循环；跨窗口保存锁缺少进程崩溃后的陈旧锁恢复。
- P2：3 项。Annotator 未达到逐文档 cleanup；跨窗口锁测试未覆盖计划要求的并发与超时分支；Task9 报告证据格式和“已完成”状态偏乐观。
- 当前基线不是全绿：前端单测、Rust、格式检查和 benchmark 通过；Biome 有 2 个错误；browser 有 11 个失败用例。

## Standards

未发现可证实的项目文档标准硬违规。以下为审查中发现的判断型正确性/维护性风险：

### P1-S1 缓存索引路径复用旧额度，单书结果可突破硬上限

- 位置：`apps/readest-app/src/services/librarySearchService.ts:769-797`。
- 现象：批次开始时计算的 `remaining` 被批内多个 section 复用；若首节返回 300、次节异常返回 800，累计可达到 800，而不是 500。live 路径会逐节重算额度，缓存路径行为不一致。
- 性能影响：最坏情况下单书可接收 999 条结果，增加结果排序、跨线程传递、内存和 UI 渲染负担。
- 测试缺口：`library-search-service.test.ts:585-614` 只覆盖首节单次超发，没有覆盖多 section 累计超发。

建议：
1. 每次合并 section 结果前重新计算当前 `remaining`，归零后立即退出。
2. 增加“首节不足、后节超发”的缓存索引红灯用例，并断言总数不超过 500。
3. 增加原始返回数、接收数和截断数埋点，便于确认 worker 异常超发是否在真实书库发生。

### P1-S2 陈旧 `library.lock` 可能永久阻断保存

- 位置：`apps/readest-app/src-tauri/src/library_lock.rs:48-74`、`apps/readest-app/src/services/nativeAppService.ts:786`。
- 现象：进程崩溃、强杀或释放失败后，锁文件没有租约、进程存活校验或陈旧锁恢复路径；后续保存只轮询到超时。前端释放路径还吞掉释放错误。
- 影响：一次异常退出可能让之后所有书库保存持续失败，直到人工清理锁文件。
- 测试缺口：Rust 测试只覆盖 token，不覆盖遗留锁恢复。

### P1-S3 CommandPalette 的 RAF 返焦可能覆盖 Tab 目标

- 位置：`apps/readest-app/src/components/command-palette/CommandPalette.tsx:104-131,188-197`。
- 现象：Tab handler 将焦点移到清除按钮或结果项后，输入框 `onBlur` 安排的 `requestAnimationFrame` 可能在下一帧把焦点抢回输入框。
- 测试缺口：现有测试没有等待 RAF，可能形成假绿。

## Spec

### P1 Task5 未完整满足硬截断要求

计划 `325-327` 要求每次加入前按当前余额截断；缓存索引路径仍复用批开始额度。Task1-3、Task8 未发现明确行为偏差。

### P1 Task7 未证明真实 DOM 焦点循环完成

计划 `416-422` 要求真实 Tab/Shift+Tab 循环。当前实现存在下一帧返焦竞争，现有 jsdom 测试没有覆盖该时序。

### P2 Task6 未达到逐文档 cleanup

- 位置：`apps/readest-app/src/app/reader/components/annotator/Annotator.tsx:346-347,431-435,589-597`。
- 计划 `371-377` 要求 `WeakMap` 保存逐文档 cleanup；实现仍使用 `WeakSet`，cleanup 主要在组件卸载时执行。iframe 替换或异常 load 后，旧文档回调仍可能保留。

### P2 Task4 测试深度不足

- 位置：`apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts:59-80`、`apps/readest-app/src-tauri/src/library_lock.rs:92-100`。
- 计划 `275-285` 要求 A/B barrier、等待、错误 token 和超时等验证。当前前端测试主要验证单实例内存链，Rust 侧主要验证 token 唯一性。

### P2 Task9 验收记录不完整

- `revision-fix-report-2026-08-31.md:67,83` 把 C-6 写成已完成，但真机/手工验证仍在待办。
- 报告没有完整记录计划 `505-507` 要求的命令、工作目录、退出码和首个关键堆栈。本报告补录了本轮 Luna 的命令与退出码，但不能替代缺失的真实交互验收。

## 3. 基线块

| 日期 | HEAD | 前端文件数 | 用例数(通过) | tsgo | biome | clippy | Rust 单测 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-08-31 | c928221 | 432 通过 / 1 跳过 | 5750 / 10 跳过 | 0 错 | 2 错 / 1 warning | 0 | 57 | browser 242 通过 / 11 失败；benchmark 3 组完成 |

## 4. Luna 测试记录

工作目录均为 `apps/readest-app`。

| 命令 | 耗时 | 退出码 | 结果 |
|---|---:|---:|---|
| `pnpm test -- run` | 106.054s | 0 | 432 文件通过、1 跳过；5750 用例通过、10 跳过 |
| `pnpm lint` | 2.870s | 1 | tsgo 通过；Biome 2 错误、1 warning |
| `pnpm fmt:check` | 1.009s | 0 | 通过 |
| `pnpm clippy:check` | 3.459s | 0 | 通过，0 warning |
| `pnpm test:rust` | 3.268s | 0 | 57/57 通过 |
| `pnpm test:browser` | 57.076s | 1 | 242 通过、11 失败 |
| `pnpm bench --list` | 0.753s | 0 | 3 个 benchmark |
| `pnpm bench --no-record` | 122.225s | 0 | 3 组全部完成，未写结果文件 |

Biome 错误：

- `src/utils/throttle.ts:5`：`noExplicitAny`。
- `src/utils/throttle.ts:14`：`noExplicitAny`。
- 既有 warning：`src/__tests__/services/dictionaries/mdictProvider.test.ts:1007` 无效字符串转义。

Browser 失败分布：

- `annotation-popup-layout.browser.test.tsx`：3 项，核心错误为缺少 `EnvProvider`。
- `paginator-turn-styles.browser.test.ts:838`：1 项，push 动画回退断言失败。
- `EditorView.browser.test.tsx:65`：1 项，确认后 `cancel` mock 未调用。
- `iframe-keyboard-selection.browser.test.ts`：3 项，键盘选词未包含预期单词。
- `tts-auto-advance.browser.test.tsx`：3 项，核心错误为缺少 `EnvProvider`。

## 5. 性能结论

- `library-search`、`library-search-turso`、`vector-retrieval` 三组 benchmark 均成功完成，runner 总耗时分别约 10.6s、103.9s、7.0s。
- 本轮使用 `--no-record`，未写入 `bench/results.jsonl`；现有回传只包含 runner 耗时，不能据此声称相对历史基线变快或变慢。
- 当前最明确的新性能风险是 P1-S1：缓存索引路径的累计截断缺口会放大结果集，且现有 benchmark/单测没有覆盖异常 worker 多 section 超发场景。
- browser 运行中反复出现 `ResizeObserver loop completed with undelivered notifications`，本轮没有证据证明它是 11 个失败用例的根因，暂不单独立项。

## 6. 下一步调试顺序

1. 先为 P1-S1 增加缓存索引多 section 超发红灯用例，建立最快、最确定的反馈环。
2. 用真实 browser test 等待 RAF，验证 P1-S3 的焦点最终落点；不要只依赖同步 jsdom 断言。
3. 为 `library.lock` 建立可控陈旧锁夹具，验证崩溃恢复策略后再决定租约或进程校验方案。
4. 将 11 个 browser 失败按 EnvProvider、选词、动画、编辑器四组独立诊断，避免混成一个问题。

## 7. Code Review 汇总

- Standards：0 个文档标准硬违规；3 个判断型正确性/维护性风险，最严重为缓存索引硬上限失效和陈旧锁永久阻断保存。
- Spec：5 个偏差或证据缺口，最严重为 Task5 硬截断和 Task7 真实焦点循环未完整落地。


## 8. 2026-08-31 修复落地状态（review-findings-remediation 执行后）

- 缓存索引批内多 section 超发：indexed 汇总改为每节合并前重算 remaining，budget 是 worker 第一层、service 逐节为最终硬边界；单书/全库上限不被突破（新增 300+800+800 → 严格 500 测试）。
- CommandPalette blur：onBlur 仅在 activeElement 离开 dialog 时返焦 input；jsdom 下以"外部返焦"正例验证，Tab/Shift+Tab 真实落点保留、真机键盘矩阵覆盖负向。
- library.lock：抽出可单测 helper + 进程启动时间；启动前遗留陈旧锁自动恢复、进程内新鲜锁不抢占；release 失败可见；barrier 证明 read-merge-write 顺序。
- Annotator section 监听器：SectionListenerRegistry（index→doc→cleanup），替换即清理旧 doc、pagehide 主动 disposeDocument、卸载 disposeAll。
- throttle：移除 noExplicitAny（参数元组泛型 TArgs）。
- 最终矩阵（主模型实测，无 Luna 环境）：前端 5756/10；Rust 60；biome 0 错 1 warning；browser 242/11（与既有集合一致）；bench 同机数值与基线一致。
- 未含：browser 11 失败根因诊断（四组红灯反馈环待做）；真正 iframe origin 隔离；P-8 完整虚拟化；真机手工验收清单（恶意 EPUB、双窗口并发、重复 prune、Open With 失败、反复开章节 listener 基数、palette 键盘）。
