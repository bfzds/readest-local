# Readest 审核修复执行报告（2026-08-31 review-findings-remediation）

**修订 v2（2026-09-01）**：v1 经外部复核（评分 6.5/10）指出 6 点证据链问题，本版逐项处理并落地对应补证修改；因此新增 3 个提交（`1565efe`/`f8a6915`/`8fa579f`），终点由 `5ef4b7b` 推进至 `8fa579f`。

- 依据：`docs/superpowers/plans/2026-08-31-readest-review-findings-remediation.md`（Task 0–6）+ 外部复核 6 点
- 分支：`readest-local`；起点 `c928221` → 终点 `8fa579f`（含 `5ef4b7b` 及补证 3 提交）
- **文档入库策略（v2 决定）**：本报告、`PERF-DEBUG-LATEST.md` 指针、`perf-debug/SKILL.md` §C 快照在**同一文档提交**入库，保证检出终点即可复现本文档描述的状态——v1 被人诟病的"报告/指针/快照互相矛盾"由此消除。
- 结果：**5 个代码 Task 独立提交且执行记录显示先红后绿**（红灯输出见各 Task 执行记录，仓库仅含修复后提交）；lint 红线清零；前端 5759/10、Rust 60、browser 无新增失败。未落地、未完全落地及原因如实列出。

---

## 一、已完整落地

| Task | 提交 | 落地内容 | 验证证据 |
|---|---|---|---|
| **Task1 缓存索引搜索硬上限** | `4534491` | indexed 汇总改为内层循环**每节合并前重算 remaining**；worker 共享预算为第一层限制、service 逐 section 重算是最终硬边界 | 先红（300≠500）后绿；新增 300+800+800 多 section 超发测试最终严格 500 且 `completed truncated` |
| **Task1 补证：末节 truncated 边界** | `1565efe` | 缓存聚合循环**消费 `outcome.truncated`**：节内 truncated 仅置最终标志、不 break（预算耗尽才中断循环），与 live 路径（line 940 读取同一字段）对齐。修复真实缺陷：**最后一个缓存 section 恰填满 500 且无下一节触发 `remaining<=0` 时，"可能还有更多"的 truncated 信号丢失** | **先红后绿**：红灯单测"scoped 单缓存 section worker 返回 500+truncated"，修复前 `completed` 得 `truncated:false`、修复后 `truncated:true`（红灯输出见执行记录） |
| **Task2 CommandPalette blur 返焦** | `348ff45` + `f8a6915` | `onBlur` 仅当 activeElement **离开 dialog** 时返焦 input（Tab 到 clear/结果后不被抢回）；Tab/Shift+Tab 循环同步断言保留 | v1 的"提交=负向用例、工作区=正向用例"不一致在 v2 **已消除**：`f8a6915` 同时保留**正向（焦点离开 dialog → rAF 拉回 input）与负向（焦点在 dialog 内 → rAF 不抢回）**两条，rAF 同步化 + `hasFocus` 固定为 true（`stubFocusEnvironment`），不再依赖 jsdom 宏任务时序；负向回归保住原始缺陷保护。browser 失败集合无 CommandPalette 新增失败；真机键盘矩阵仍为补充验收 |
| **Task3 陈旧 lock 恢复** | `e01eeb7` | `library_lock.rs` 抽出可单测 helper + 进程启动时间；**启动前遗留陈旧锁在首次保存时挪开重新拿锁**，进程内新鲜锁绝不抢占（超时返回错误）；release 错误可见 | 先红（helper 未定义编译失败）后绿；3 个新增 Rust 锁测试 + Js barrier；Rust 全 60 通过 |
| **Task4 Annotator section registry** | `9ca2e69` + `8fa579f` | 新建可单测 `SectionListenerRegistry`（index→doc→cleanup）；Annotator onLoad 先 `replace` 登记再 mount，`pagehide` 时 `disposeDocument`，卸载 `disposeAll` | registry 3 单测 + **新增 `disposeDocument` 调用 cleanup 且幂等、index 释放可顶替**（`8fa579f`）；`pagehide` 接线（Annotator.tsx:437-439 注册、disposers 反注册）**经代码审查确认**，无自动化事件测试——jsdom 无真实 iframe 生命周期，报告不把代码审查当测试证据 |
| **Task5 throttle 去 any** | `fa62666` | `ThrottledFunction<TArgs extends unknown[]>` 参数元组泛型，移除两处 noExplicitAny | `pnpm lint` 退出码 1→0；throttle 4 条 fake-timer 测试通过 |
| **Task6 文档证据** | `5ef4b7b` + 本节 | 修正 C-6 措辞；`perf-debug-report` 追加 §8；SKILL 更新 SNAPSHOT | 最终矩阵（见第四节）：本报告 + 指针 + SKILL 快照同批入库，状态自洽 |

单测净增：前端 5756→**5759**（+3：Task1 界 1、Task2 净 +1、Task4 disposeDocument 1）、Rust 60；lint 红线 2→0。

---

## 二、外部复核 6 点处理结果（v2 核心）

| 复查点 | 处理结果 |
|---|---|
| **1. Task1 末节 truncated 缺口**（缓存路径不读 `outcome.truncated`，恰填满 500 且无下一节时标志丢失） | **属实，已修**（`1565efe`，红灯先行）。severity 认同为中等正确性问题（500 硬上限本身仍不越界，损失的是 truncated 状态） |
| **2. 报告未被终点提交固化** + 指针/快照互相矛盾 | 采用"报告入库"策略：本报告入库并**与指针、SKILL §C 快照同一文档提交**，检出 `8fa579f` 后三者自洽（v1 的 5ef4b7b 内 SKILL 指 08-31、指针却指 08-19 的矛盾已消除） |
| **3. Task2 报告≠提交≠工作区**（提交是负向、工作区改成正向未提交） | 已定正：`f8a6915` 同时保留正/负两条且可控 RAF，报告与提交一致；不做"提交更弱测试换表面一致" |
| **4. Task4 pagehide 证据不足**（registry 3 测不含 disposeDocument/pagehide 派发） | 补 `disposeDocument` 单测（`8fa579f`）；pagehide 接线降低为"代码审查确认"，不再与测试证据并列 |
| **5. bench 无数据不构成"无退化"** | 报告改为给出**具体前后数值、机器信息、差值**（见第四节），并注明单次采样噪声带 |
| **6. 先红后绿不可独立审计** | 措辞统一改为"**执行记录显示**先红后绿，红灯输出见任务执行记录"；仓库仅含修复后提交是客观事实，不再写成独立验证 |

---

## 三、未完全落地、未落地（及原因）

### 未完全落地

| Task/项 | 已做 | 未完成部分 | 原因 |
|---|---|---|---|
| **Task3 前端 barrier** | 锁顺序证明（barrier）已落地 | 计划要求"释放 gate 前断言 writes==1"先落成 0（写前 gate 语义） | 断言把"写前 gate"误解为 0，实际 gate 在 `writes++` 之后 → 修正为 1 并加双宏任务等待；属实现细节修正而非遗漏 |
| **Task0 worktree 隔离** | 基线记录（HEAD==`c928221`、工作区干净）为计划固定点 | 独立 worktree 未创建 | `pnpm worktree:new` 退出 128：脚本硬编码 `origin/main`，本项目远端默认分支是 `readest-local`；子模块含未推送本地提交不可拉取。改在干净当前工作区执行，各 Task 独立提交可回滚 |
| **Task6 的 Luna 双模型** | 验证由主模型直接执行并记录；**复核方（下文第四节）已做独立只读复跑** | 计划要求的 luna agent 独立子任务未启用 | 本机无该模型；以主模型实测 + 复核方独立复跑两条来源互补 |

### 未落地

| 项 | 计划归属 | 未落地原因 |
|---|---|---|
| **browser 11 失败的系统性根因诊断**（四组） | 计划明确独立任务、不在本计划执行 | 计划明文声明"不猜测性修复当前 11 个 browser 失败"，须每组建成红绿灯复现反馈环后另生成修复计划；本计划保持 browser 与既有集合一致 |
| **iframe origin 隔离**（真拆 `allow-same-origin`） | 计划 Global Constraints 明确不改变、另立架构验证 | 实测移除该属性令 `contentDocument` 变 null 破坏 foliate DOM 分页；交单独架构任务 |
| **P-8 搜索结果完整虚拟化** | 范围外 | 需兼容 sticky header、多本展开、键盘导航、ARIA，且需真实性能数据与可访问性原型后才重排期 |
| **真机手工验收清单** | 计划 Task6 Step5 + 完成定义 | 均为无法自动化的桌面交互验收（恶意 EPUB、双窗口并发、重复 prune、Open With 失败、长会话 listener、palette/Dialog 键盘矩阵与返焦）；每项需可见桌面窗口人工执行，未标完成 |

---

## 四、最终验收矩阵（@8fa579f 实测）

| 命令 | 结果 |
|---|---|
| `pnpm test -- --run` | **5759 通过 / 10 跳过（434 文件，433 过 1 跳）/ 退出码 0**（v1 为 5756，+3 为本轮补证） |
| `pnpm lint` | 退出码 0（tsgo 0 错、biome 0 错误 + 1 既有 mdict warning） |
| `pnpm fmt:check` / `clippy:check` / `test:rust` | 全 0；Rust **60**（library lock 陈旧恢复/新鲜不抢/token 校验全在） |
| `pnpm test:browser` | 242 通过 / **11 失败（5 文件，与既有集合一致）**：annotation-popup-layout 3、tts-auto-advance EnvProvider 3、iframe-keyboard-selection 3、paginator-turn-styles 1、EditorView cancel 1；无 CommandPalette/Annotator 新增失败 |
| `pnpm bench library-search` | 退出码 0；前后数值如下 |

**bench 前后对照**（同机 win32/x64、AMD Ryzen 7 3700X 16 线程、16 GiB、Node v24.14.0；`@8fa579f` vs 基线 `@060bb32` 同机记录）：

| 场景 | @8fa579f | @060bb32 | 差值 |
|---|---|---|---|
| 10-book absent contains | 29.44 ms | 30.95 ms | −4.9% |
| 10-book zh absent contains | 108.78 ms | 111.60 ms | −2.5% |
| 100-book mixed absent | 681.93 ms | 707.08 ms | −3.6% |
| 1000-book mixed absent | 6756.36 ms | 6845.19 ms | −1.3% |
| first streamed result | 0.262 ms | 0.261 ms | +0.4% |
| common en word capped 500 | 0.790 ms | 0.657 ms | +20.3% ※ |
| common zh term capped 500 | 5.391 ms | 5.483 ms | −1.7% |
| 10-book fuzzy | 98.54 ms | 90.97 ms | +8.3% |
| 10-book zh fuzzy | 126.18 ms | 120.82 ms | +4.4% |
| 100k chars capped fuzzy | 73.25 ms | 73.07 ms | +0.2% |
| cold nearby | 12.49 ms | 11.81 ms | +5.8% |
| pre-segmented nearby | 4.37 ms | 4.24 ms | +3.1% |
| zh cold nearby | 68.97 ms | 60.30 ms | +14.4% ※ |

※ 两项超 ±10% 的历史噪声带：同机同日基线本身两次运行（@060bb32 02:44 与 03:17）10-book absent 即差 43.35 vs 30.95（+40%），单次采样噪声偏大。本轮 13 场景整体随基线走、无系统退化模式；Task1 改动仅为每节一个布尔判定，无性能作用面。

**独立复核（复核方只读复跑）**：前端 5756 通过/10 跳过/exit 0、lint exit 0（1 既有 warning）、Rust 60（fmt/clippy 过）、browser 242 通过/11 失败（失败集合无新增 CommandPalette/Annotator）、bench exit 0——与本节实测互相印证。

判定对照完成定义：5 个代码 Task 独立提交、执行记录先红后绿 ✓；缓存索引超发严格 500 + 末节 truncated 边界 ✓；palette 正/负双测 + 真机矩阵（待手工项）✓；锁陈旧恢复/新鲜不抢 ✓；registry 替换/pagehide/disposeAll + disposeDocument ✓；lint 0、前端/Rust 无新增失败 ✓；报告含命令/退出码/失败归因/bench 真值 ✓；不把待手工验收项或代码审查项写成已自动化验证 ✓。

## 五、回滚边界（计划 Rollback Rules 保留）

搜索 Task 只回滚 service+测试（含 `1565efe`）；焦点 Task 只回滚当次提交（含 `f8a6915`）；锁 Task 若在任一平台误抢新鲜锁立即整体回滚 Task3；Annotator Task 若影响选中/长按/右键回滚 registry 接入提交（含 `8fa579f`）；文档状态在代码回滚后同步撤销。