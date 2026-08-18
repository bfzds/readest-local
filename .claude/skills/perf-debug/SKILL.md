---
name: perf-debug
description: Readest Local 项目专属性能分析与调试技能（项目级，覆盖用户级通用版）。执行前先做锚点自检与任务分级（§A），画像落后于项目进度时按 §B 刷新快照区，保证随项目进度自适应。
---

# Readest Local 性能分析与调试技能（项目专属·自适应版）

本项目为固定技术栈的**已画像项目**。与用户级通用版（`~/.claude/skills/perf-debug/SKILL.md`）不同，本版跳过通用扫描推断流程，但**不假设画像永远正确**：每次执行先跑 §A 锚点自检与任务分级，画像落后于项目进度时按 §B 刷新，再进入主任务。若用户级通用版在本项目内被加载，说明项目级覆盖失效——终止扫描流程，按本文件执行并检查 skill 加载顺序。

## A. 执行前锚点自检与任务分级（必跑，约 30 秒）

**任务分级**（决定后续成本，先做；**类型不明确时先向用户确认，勿自行假设**——把修复误判成分析会漏跑基线，代价不对称）：

- **只读分析 / 复核**（不改代码）→ 跳过 §D.2 的改动前后双基线，仅做本自检；产出复核报告（模板见 §F）
- **修复/改动** → 完整走 §D.2 基线（改动前 + 改动后）

§C 快照区记录画像锚点三元组 `(HEAD, 最新报告, 基线)`。之后校验：

1. **HEAD**：`git rev-parse --short HEAD`，与 §C 锚点 HEAD 比较。
2. **最新报告**：读 `docs/reports/PERF-DEBUG-LATEST.md` 指针（单行文件名）。指针缺失时回退：列出 `docs/reports/` 下日期最新的报告（`perf-debug-report-*`、`debug-plan-*`、`debug-performance-report-*`、`debug-report-*` 全部参与比较，取修改时间最新者），确认 §C 引用的报告仍是它。**指针与报告均未找到时**（如 docs 目录被重组）：读 `docs/README.md` 索引或递归列目录，定位报告实际所在目录，并同步修订本 skill 与 hook 中的所有路径引用（属 §D 允许的修订，须在刷新报告开头声明）。
3. **基线**：最新报告「基线块」（§F 固定格式）数值，与 §C 基线表比较。

- 三项全一致 → 跳过 §B，进入主任务。
- 任一不一致 → 先执行 §B 刷新，再进入主任务。

## B. 快照刷新流程（skill 自更新回路）

锚点过期时，按此流程把 §C 快照区刷新到当前进度（稳定层 §D 一字不动）：

1. 读最新报告（优先指针 `docs/reports/PERF-DEBUG-LATEST.md` 指向者；指针缺失则按 §A 第 2 步回退定位）。
2. 提取变化：**直接复制**报告「基线块」（§F 固定字段，无需翻译）、缺陷状态（已修 / 待修 / 新编号）、热点 `文件:行号` 变更、新踩坑。
3. **回写前重读 §C**：若快照区已被其他会话更新（锚点比自检时更新），先合并再写，**勿覆盖他人更新**。
4. **仅编辑 §C**（`SNAPSHOT-BEGIN/END` 标记之间）：更新锚点三元组、当前优先级与状态表。
5. 只有技术栈变更或稳定层方法失效时才允许改 §D，且必须在刷新报告开头声明理由。
6. **刷新记录（零增量豁免）**：本次刷新若仅有「最新报告」锚点字段变化（无基线/编号/踩坑变化），**不另写报告**——当次分析报告（§F）本身就是刷新记录。有实质变化（基线更新 / 新编号 / 新踩坑）时，才按 §F 落一份增量报告（记录：旧锚点 → 新锚点 + 变更摘要），**并更新指针文件**，不提交 git。

## C. 快照区（由 §B 维护，勿手改）

<!-- SNAPSHOT-BEGIN -->

| 项 | 值 |
|---|---|
| 锚点 HEAD | `8218a6f` |
| 最新报告 | `perf-debug-report-2026-08-19.md` |
| 基线 | vitest 421 文件 / 5630 通过（1 skipped 文件 / 10 skipped 用例）；tsgo 0 错；biome 2 warnings（ingest-service.test.ts noUselessEscapeInString，他人未提交的 txt-worker 会话代码）；clippy 0 警告；Rust 单测 53 通过（@8218a6f 实测，8-19 报告） |
| 当前优先级 | SF12 已修 → SF10（MDict trackedUrls）、新5（AdwaitaSelect a11y）、RF6 → 暂缓 HF2、macOS 实机项（RF1/RF9/RF10） |
| 本报告已修 | SF12 page_stat_data 无界增长：StatisticsDb.MAX_PAGE_EVENTS_PER_BOOK=10000 + prunePageEvents（rowid 保留最近 N 条），飘页 flush 路径调用（ReadingStatsTracker.persist），test-first（新失败测试转绿）+ 34 测试文件 271 用例回归通过 |
| 已分析未修 | SF10 MDict trackedUrls 无界累积：resolveImageResources 每次 lookup 为每 img 新建 blob URL push 进 provider 级数组，dispose 前不回收（同图反复新建、旧卡片移除不 revoke）；建议：参考 sound 锚点的 data-mdd-resolved 缓存 + 卡片级 URL 生命周期。新5 AdwaitaSelect 键盘导航已有完整实现+测试，剩余为 aria-activedescendant/焦点环 a11y 细节 |
| 明确暂缓 | HF2 getVisibleRange 整章遍历（改动风险高）；RF6；macOS 实机项（RF1/RF9/RF10） |

<!-- SNAPSHOT-END -->

> 快照区数值的权威来源是 docs/reports/ 最新报告（指针文件指向者），不是本表；两者冲突以报告为准，并触发 §B 刷新。

## D. 稳定层（方法论与踩坑，随项目慢变）

### D.0 固化项目画像（结构事实，仅技术栈变更时更新）

- **项目**：Readest Local — `readest/readest` v0.12.1 的纯本地离线分支（分支 `readest-local`）
- **架构**：Tauri 2 桌面应用 + Next.js 16 (App Router) 前端 + Rust 原生层。pnpm monorepo（`pnpm@11.1.1`）
- **主战场**：Tauri 桌面端。**web 端优化一律不采纳**——发现 web-only 问题时只记录不立项。该边界以 `apps/readest-app/AGENTS.md` 当期声明为准，若上游修改了该原则，本 skill 跟随调整
- **目录**：
  ```
  阅读器/
  ├── apps/readest-app/          # 主应用：Next.js (src/) + Tauri (src-tauri/)
  │   ├── src/                   # TS/React 前端（app/ components/ services/ hooks/ ...）
  │   ├── src-tauri/src/         # Rust：dir_scanner epub_parser mobi_parser range_file ...
  │   └── e2e/                   # wdio e2e
  ├── packages/                  # 内嵌依赖：foliate-js(阅读核心) tauri tao swift-rs
  │                              #   qcms simplecc-wasm js-mdict tauri-plugins
  ├── docs/                      # 索引 + 分类子目录；reports/ 存报告与指针（§A 自检的事实源，先查重！）
  └── target/                    # Rust 构建产物（排除）
  ```
- **性能热点区**（历史确认，行号与当前状态以 §C 最新报告为准）：`packages/foliate-js/paginator.js`（长章节布局遍历）、`src/services/librarySearchIndex.ts`（搜索逐节 IPC）、书库封面加载、启动链（`view.firstPaint` / `initViewState.total` 埋点）、双窗口内存（历史实测 ~967MB，WebView2 主导）

### D.1 量化与防编造原则（硬性）

1. **真实优先**：结论只基于实际读取的代码与配置。静态指标直接测量给真实值；运行时指标给出测量命令与判定阈值；预期收益标注「估算」+ 依据。
2. **可执行**：命令、代码、配置片段必须可直接复制执行，禁止模糊表述。
3. **量化**：所有指标带明确数值和单位。
4. **引用定位**：涉及具体代码一律标注 `文件:行号`。

### D.2 执行前必查（防止重复劳动）

1. **对照 §C 状态**：已修复项不重复立项；标「已修需回归」的只做验证；优先级按 §C「当前优先级」，不由本文件 D.5 的条目顺序暗示。
2. **基线检查**（仅修复型任务，改动前后跑，必须全绿）。命令以 `apps/readest-app/package.json` scripts 当期定义为准（下表为 2026-08 快照示例，scripts 演进时以 package.json 为准），基准参考值见 §C 基线：

   | 检查 | 命令（快照示例） | 说明 |
   |---|---|---|
   | 前端单测 | `pnpm test -- run` | **代理/非交互模式必须带 `run`**，否则 vitest 进 watch 挂住；交互模式可 `pnpm test` |
   | 类型+lint | `npx tsgo --noEmit && npx biome lint .` | 0 错误 |
   | Rust lint | `cargo clippy -p Readest --no-deps -- -D warnings` | 0 警告 |
   | Rust 单测 | `cargo test -p Readest --lib` | 参考 §C 基线 |
   | 基准 | `pnpm bench` | 对比 `bench/results.jsonl` 历史；`--list` 列用例 |
   | e2e | `cd apps/readest-app && pnpm test:e2e` | wdio；**需 GUI 窗口 + WebDriver 4445 端口**，无头/远程环境跳过并在报告注明 |

   - **基线本身不绿时**：先记录现状数值（哪些失败），修复不得新增失败项；与本改动无关的失败在报告中声明，不作前置阻塞。
   - 与 `apps/readest-app/.claude/rules/verification.md` 互补：该规则另有 koplugin Lua 检查（若 `apps/readest.koplugin` 存在才适用）。
3. **测试先行规则**：`apps/readest-app/.claude/rules/test-first.md` — 修复必须先写失败单测再改代码。**例外（性能类修复）**：翻页帧耗时、内存、IPC 往返次数等无单测载体的修复，以 §D.5 采样方法 + `[perf]` 埋点做前后对比作为验证基线，并在报告中声明「无法单测的原因」。
4. 文档类 `.md` **不自动提交 git**。

### D.3 本机调试基建（直接用，勿另建）

#### 启动可自动化实例
```bash
cd apps/readest-app && pnpm tauri:dev:test
# = tauri dev --features webdriver；应用内嵌 WebDriver server 监听 127.0.0.1:4445
# Rust 增量缓存下重启 ~15s；杀 Readest.exe 后残留 next dev 会占 3000 端口，需清理（见平台表）
```

#### 平台适配表（Windows 为实测值；macOS/Linux 按防编造原则保留「待实测」，附实测入口提示，首次使用后回填）

| 项 | Windows | macOS | Linux |
|---|---|---|---|
| WebView 调试端口 | 启动前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，连 `http://localhost:9222` 的 Chrome DevTools 打断点/Performance 采样 | WebKit Inspector（待实测；入口：Safari → 开发菜单 → 显示 Web 检查器，或 Xcode 附连） | `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9222`（待实测） |
| 应用日志路径 | `$env:LOCALAPPDATA\com.local.readest\logs\Readest Local.log` | `~/Library/Logs/com.local.readest/`（待实测） | `~/.local/share/com.local.readest/`（待实测） |
| 清理残留进程 | `taskkill /F /IM Readest.exe` + 清理 3000 端口占用 | `pkill Readest`（待实测） | `pkill Readest`（待实测） |

#### 日志与埋点
```powershell
# 交互模式：实时跟踪（阻塞，供人工观察）
Get-Content "$env:LOCALAPPDATA\com.local.readest\logs\Readest Local.log" -Wait -Tail 50
# 代理/非交互模式：单次读尾部，避免阻塞
Get-Content "$env:LOCALAPPDATA\com.local.readest\logs\Readest Local.log" -Tail 100
```
webview console 全量转发，含 `[perf]` 埋点（统一实现在 `src/utils/perf.ts`；历史埋点 `view.firstPaint`、`initViewState.total`、`importBook.total` 等，行号以 §C 最新报告为准）。新增埋点沿用 `[perf]` 前缀 + 点分层级命名（如 `[perf] reader.tocRender`）。

#### 窗口可见性/驱动陷阱（历史踩坑，必守）
- WebDriver click/screenshot 对**隐藏窗口**也成功（只看 CSS 可见性）——判断窗口真实可见必须用 Win32 `IsWindowVisible(EnumWindows)` 按标题 `Readest`/`Readest - <书名>` 过滤
- 窗口销毁判据：WebDriver `switch` 报 `no such window` 404
- `execute/sync` 的 script 需 `return` 前缀；JS `window.close()` 是 no-op，不触发 Tauri `onCloseRequested`；真实关闭走 UI 关闭按钮或 `DELETE /session/{id}/window`
- 阅读正文在 `foliate-view` **嵌套 shadow DOM** 内，`document.body.innerText` 不含正文；滚动容器需递归遍历 shadowRoot 查找

#### 历史窗口问题（状态以最新报告为准；如复现先对照报告修复证据，勿重复立项）
- Alt+F4 无可见窗口 → 已修：`library/page.tsx` 的 `close-reader-window` handler 现有 `show()` 兜底（复核证据见最新报告 §3.1）
- 看门狗死角 / viewStates 泄漏 → 相关修复与复核见最新报告；若分析中复现，先重验再立项

### D.4 分层调试指南（按本项目技术栈定制）

#### 前端（Next.js + React，`apps/readest-app/src/`）
- **工具**：VS Code JavaScript Debugger + Chrome DevTools（WebView2 远程调试端口，见 D.3 平台表）
- **单测内调试**：`dotenv -e .env -e .env.test.local -- vitest run path/to/test --inspect-brk`，连 `about:inspect` 或 VS Code
- **典型排查**：React 重渲染（DevTools Profiler 按 commit 看；重点查 `bookDataStore` 订阅粒度——历史 NF3 级联重渲已修，回归时验证 per-field selector）、Zustand store 状态、shadow DOM 内事件

#### Rust 层（`apps/readest-app/src-tauri/` + `packages/tauri*`）
- **工具**：CodeLLDB（VS Code）或 `rust-gdb`；`cargo clippy -D warnings` 是免费的第一道
- **命令**：
  ```bash
  cargo clippy -p Readest --no-deps -- -D warnings
  cargo test -p Readest --lib
  RUST_LOG=debug pnpm tauri:dev:test   # Tauri 侧日志
  ```
- **典型排查**：IPC 命令耗时（前端 `invoke` 调用处加 `[perf]` 埋点计时）、文件扫描（`dir_scanner.rs`）、解析器（`epub_parser.rs` / `mobi_parser.rs`）
- **注意**：`packages/tauri` 是本仓库维护的 fork 子模块，有未提交改动属正常；改动它需同步验证主应用

#### 阅读核心（`packages/foliate-js/`，独立 npm 包）
- **纯 JS 无框架**，调试走 WebView2 DevTools 断点；该包有独立 git 历史（fork 上游）
- **性能主战场**：`paginator.js`、overlayer、TOC
- 改动需考虑 Android WebView 兼容（项目 `check:lookbehind-regex` / `check:optional-chaining` 脚本就是为此存在——输出产物禁用 lookbehind 与 optional chaining）

### D.5 性能分析方向与采样方法（方法稳定；优先级以 §C「当前优先级」为准，条目顺序不代表优先级）

1. **翻页/滚动热路径**：`paginator.js getVisibleRange`（历史 HF2）；采样方法：构造数千节点章节，翻页时 Chrome DevTools Performance 录制主线程，或 WebView 埋点计时
2. **搜索索引 live path**：`librarySearchIndex.ts`（SF2 逐节 IPC，历史 500 节书 ≈1500 次往返）
3. **启动链**：`[perf] view.firstPaint` / `initViewState.total` 日志判读；阈值以最新报告为准
4. **书库封面/大列表**：BGL worker 化已修部分，MDict/StarDict 剩余
5. **内存**：双窗口历史基线 ~967MB；用任务管理器/`Get-Process Readest` 对比；WebView2 渲染进程主导
6. **稳态容量**：SF12/SF14/SF4/SF5、RF6/RF9/RF10、TF3（具体状态见最新报告 §3）

## E. 事实源清单（现场获取，不内嵌过期值）

| 事实 | 现场获取方式 | 用途 |
|---|---|---|
| HEAD / 近期提交 | `git rev-parse --short HEAD`；`git log --oneline -20` | 锚点自检、热点模块定位 |
| 最新报告指针 | `docs/reports/PERF-DEBUG-LATEST.md`（单行文件名；缺失时回退 glob） | §A 第 2 步、hook 检查 |
| 缺陷状态与编号 | 指针指向的报告（或 `docs/reports/` 下修改时间最新的 `perf-debug-report-*` / `debug-plan-*` / `debug-performance-report-*`） | 防重复立项 |
| 基线数值 | 最新报告「基线块」；**必须核对基线采集时间 ≥ 锚点 HEAD 提交时间，旧验证数据不得当新基线**（2026-08-16 曾误用 8-11 数据，已纠正） | §D.2 基线对比 |
| 热点 文件:行号 | 报告引用 + `grep` 现场复核（如 `getVisibleRange`）；**grep 模式用报告引用的具体语句/属性（如 `visibility: hidden`），勿用类名/函数名**——会命中多处造成行号误判 | 定位（报告日期之后的提交可能已改动） |
| 脚本命令 | 现场读 `apps/readest-app/package.json` scripts | 所有命令 |
| 平台/交互模式 | `$env:OS`（Windows）或 `uname`；`[Console]::IsOutputRedirected` 判非交互 | 选 §D.3 平台表与命令变体 |

## F. 输出规范

- 报告写入 `docs/reports/perf-debug-report-<YYYY-MM-DD>.md`（当天日期；不自动提交 git）。**写前检查同名文件是否已存在，存在则加 `-2`、`-3` 后缀**。**今后统一此前缀**（旧前缀文件保留，§A 定位时全前缀参与比较）
- 报告**必含「基线块」**（固定字段，供 §B 刷新时直接复制，禁止散文改写）。**分析型/复核型任务未跑基线时，字段填「未执行」并注明以上一次实测报告值为准，不得编造**：

  ```
  | 日期 | HEAD | 前端文件数 | 用例数(通过) | tsgo | biome | clippy | Rust 单测 | 备注 |
  |---|---|---|---|---|---|---|---|---|
  | 2026-08-15 | d836901 | 413 | 5555 | 0 | 0 | 0 | 53 | 示例 |
  ```

- 报告定稿后**更新 `docs/reports/PERF-DEBUG-LATEST.md`**（单行：报告文件名，如 `perf-debug-report-2026-08-15.md`），供 §A 与 hook O(1) 定位
- **复核型报告模板**（只读复核/演练，无新缺陷时）：复核项表格（`报告引用 | 现场核实 | 结论`）+ 备注；无新发现时不加新编号
- **编号沿用现有体系**（HF/SF/NF/RF/TF/P/B + 序号），跨报告可追溯；新发现用「新N」编号并在报告开头声明
- 每个瓶颈必须带：`文件:行号`、量化影响（静态实测 / 测量命令+阈值 / 标注「估算」+依据）、≥3 条优化建议（步骤/收益/难度）、优先级 P0-P2
- P0 项附完整可执行代码示例 + 验证步骤（用 §D.2 基线命令 + §D.3 埋点）
- 修复类工作遵循 test-first（性能类例外见 §D.2.3）；**无法单测的性能修复须在报告声明原因 + 附采样前后对比**
- **回写（本 skill 的自更新回路）**：报告定稿后，若 §C 快照区锚点落后于报告，按 §B 刷新快照区并更新指针（仅报告指针变化时，只更新快照区「最新报告」字段，见 §B 零增量豁免）
- 完成后会话内输出：报告路径 + P0 清单摘要

## G. 自检清单

- [ ] §A 已跑：任务已分级（类型不明确时已向用户确认；只读分析未跑冗余基线）；锚点过期时已按 §B 刷新快照区
- [ ] 已读最新报告（指针文件指向者），无重复立项（对照编号）
- [ ] web-only 问题未立项（只记录）
- [ ] 命令按 §D.3 平台表选分支；代理/非交互模式用了 run/单次读取变体
- [ ] 数值带单位；运行时数据附测量命令，未编造（§D.1）
- [ ] `文件:行号` 引用已对照当前代码核实
- [ ] 代码改动走 test-first；无法单测的性能修复已附采样前后对比并声明原因（§D.2.3）
- [ ] 基线全绿后才收尾；基线本就不绿时已声明无关失败且未新增失败（§D.2.2）
- [ ] 报告未提交 git；报告定稿后已更新 `docs/reports/PERF-DEBUG-LATEST.md` 指针；§C 快照区与最新报告一致
