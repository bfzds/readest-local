# UX 遗留问题可执行修复计划（2026-09-05）

> 依据：`ux-debug-report-2026-09-05.md` 第二节"证实但未修"6 项 + 页脚跳页入口方案（对话定稿）。
> 性质：自主路线，不套用项目 debug 规范；但保持"一任务一提交、可独立回滚"。
> 分支：`readest-local`（当前工作区有未提交修复，见报告；本计划任务基于其上继续）。

## Global Constraints

- **测试一律由 test-runner 子代理执行**（`pnpm test -- --run` / `pnpm lint` / Rust 套件），主代理不亲自跑测试；子代理不可用时暂停并如实报告。
- 每个任务独立提交，失败回滚该任务提交，不影响其他任务。
- 新增 i18n key 必须同步 `zh-CN` + `zh-TW`（`locale-key-diff.test.ts` 强制）；en 为源语言缺省回退。
- 新弹层必须支持 Esc 关闭 + 焦点返还；交互控件补齐 aria-label。
- 交互/状态逻辑先写测试再实现；纯文案与视觉打磨可后补测试。

## 任务总览

| # | 任务 | 优先级 | 工作量 | 风险 |
| --- | --- | --- | --- | --- |
| T1 | 页脚进度条拖动刮擦（跳页主入口） | 高 | 中 | 中（与 #5293 点击语义共存） |
| T2 | Ctrl+G + 命令面板精确跳页（副入口） | 高 | 小-中 | 低 |
| T3 | TTS 打磨（浮动按钮停止态文案 + 桌面播放器不自动隐藏） | 高 | 小 | 低 |
| T4 | 重复导入区分"新增 / 已在书库" | 中 | 小-中 | 低（改 ingestFile 返回结构） |
| T5 | 书库毒锁修复（心跳 + 陈旧回收 + async acquire） | 高 | 中 | 中（Rust 并发语义） |
| T6 | resize 断点错型 / 并发导入 overlay | 低 | — | 暂缓（见 §7） |

---

## T1 页脚进度条拖动刮擦

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/ProgressBar.tsx`
- Test: `apps/readest-app/src/__tests__/reader/`（扩展现有 ProgressBar 测试；无则新建 `progress-bar-scrub.test.tsx`）

**设计定稿（对话确认）：**
- 仅横向模式启用（`isVertical` 排除——竖排页脚是侧栏）；`progressValid` 为 false 或 view 无 `goToFraction` 时禁用。
- **悬停不弹任何东西**，仅 `cursor: ew-resize` 提示可拖；气泡只在真实拖动中出现。
- 拖动阈值 8px（与书架拖拽同款判定）；未过阈值的抬起不产生动作。
- 拖动中：药丸气泡（`role='status'`，pointer-events-none）显示目标位置，锚在指针 x 上方、水平夹取在窗口内；同时页脚行内数字实时刷新。
- 跳转调用：节流 ~150ms trailing 调 `view.goToFraction(fraction)`，松手立即终跳；**Escape 取消**：回到拖前位置（dragstart 时记录原 fraction）。
- fraction = clamp((x − stripRect.left) / stripRect.width, 0, 1)；页码显示复用组件内 `pageInfo`（fixed-layout 用 section，否则 pageinfo）。

**Steps:**
- [ ] Step 0 现状确认：跑一遍现有 ProgressBar/reader 测试基线（test-runner）；确认桌面分页模式点击页脚条下方区域的现有行为（是否参与点击翻页），记录之。
- [ ] Step 1 抽纯函数：`xToFraction(x, rect)`、`fractionToDisplay(pageInfo, fraction)` 放 `../utils/`（或就近导出），先写单测（clamp、边界、fixed-layout 分母）。
- [ ] Step 2 交互测试先行：mock store/view，用 pointer 事件序列断言——①未过阈值不调 `goToFraction`；②过阈值按预期 fraction 调用（含节流合并）；③Escape 恢复原 fraction；④竖排不绑定拖拽。
- [ ] Step 3 实现：strip 上挂 pointerdown（button 0），window 级 pointermove/up/cancel + Escape 监听（拖动期间才挂，参照 Bookshelf 拖拽的挂载模式）；实现气泡与行内数字刷新。
- [ ] Step 4 共存验证：竖排/滚动模式（`stripTappable`）点击仍触发 #5293 显隐切换（阈值前的 pointerup 不 preventDefault，让原 onClick 走完）。
- [ ] Step 5 test-runner 跑 reader 相关套件 + 全量。
- [ ] Step 6 提交：`feat: drag the reader footer strip to scrub position`。

**验收：** 拖动出现气泡、松手落位、Esc 回原位；#5293 不回归；点目录按钮路径无任何气泡（几何上 64–112px 按钮区 vs 0–40px 页脚带不重叠，热区右端留出按钮列空隙）。

---

## T2 Ctrl+G + 命令面板精确跳页

**Files:**
- Modify: `apps/readest-app/src/helpers/shortcuts.ts`（新 action，如 `onJumpToPage`，label 复用现有 key `Jump to Location`）
- Modify: `apps/readest-app/src/app/reader/hooks/useBookShortcuts.ts`（绑定 `Mod+G` → 派发 `toggle-page-jump` 事件）
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx`（挂载跳页弹层，监听事件）
- Modify: `apps/readest-app/src/app/reader/components/footerbar/PageJumpInput.tsx`（新增可选 `autoEdit?: boolean`：挂载即进入编辑态并聚焦；现有点击编辑行为不变）
- Modify（可选子步）: `apps/readest-app/src/components/command-palette/CommandPaletteProvider.tsx`（新命令派发同一事件；活动 bookKey 从 readerStore 取，若取键链路复杂则此子步砍掉，只留 Ctrl+G）
- Test: `src/__tests__/`（useBookShortcuts 现有测试扩展 + 弹层开关/焦点测试）

**Steps:**
- [ ] Step 1 `PageJumpInput` 加 `autoEdit`（默认 false），测试：true 时渲染即 editing 且聚焦。
- [ ] Step 2 BooksGrid 挂弹层：`eventDispatcher.on('toggle-page-jump')`，弹层底部居中、含 `PageJumpInput autoEdit`；Esc/点外关闭并返焦；快捷键测试先行。
- [ ] Step 3 shortcuts 注册 + useBookShortcuts 绑定（参照现有 action 模式）；确认 Ctrl+G 与现有快捷键无冲突（grep `Mod+G`/`KeyG`）。
- [ ] Step 4（可选）命令面板命令，同事件派发。
- [ ] Step 5 test-runner 跑相关套件 + 全量。
- [ ] Step 6 提交：`feat: precise page jump via ctrl+g and command palette`。

**验收：** Ctrl+G 弹输入框→Enter 跳页→Esc 关闭返焦；移动端不受影响（快捷键桌面语义）。

---

## T3 TTS 打磨两件

### T3a 浮动朗读按钮的停止态文案

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/FloatingSpeakButton.tsx`（组件已读 `viewState?.ttsEnabled` 切换图标；同步切 `aria-label`/`title`：ttsEnabled → `_('Stop')`，否则 `_('Speak')`）
- Modify: `public/locales/zh-CN/translation.json` + `zh-TW`（新增 `Stop`；`Speak` 已有）
- Test: `src/__tests__/components/floating-speak-button.test.tsx`（补 aria-label 断言）

- [ ] 实现 + i18n + 测试 → test-runner 验证 → 提交 `fix: label floating speak button as stop during playback`。

### T3b 桌面迷你播放器不自动隐藏

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/tts/useMiniPlayerAutoHide.ts`（`LINGER_MS=5000` 的自动隐藏仅在移动/窄窗生效：`window.innerWidth<640 || window.innerHeight<640` 时不武装定时器；判定值从 `TTSMiniPlayer.tsx` 的 `usesMobileBar` 传入或 hook 内自查，取实现时更简者）
- Test: fake timers——桌面：5s 后仍可见；移动：5s 后隐藏（保现有行为）。

- [ ] 测试先行 → 实现 → test-runner 验证 → 提交 `fix: keep tts mini player visible on desktop`。

### T3c（可选，顺手）：`TTSMiniPlayer.tsx` 渲染期 `window.innerWidth` 换成 resize 感知（matchMedia/现有 hook）。若超出半页改动量则放弃，留待 T6。

---

## T4 重复导入区分"新增 / 已在书库"

**Files:**
- Modify: `apps/readest-app/src/services/ingestService.ts`（返回结构 `Book | null` → `{ book: Book; existed: boolean } | null`；byFilePath 原位命中与 byHash 复活两臂标 `existed: true`，其余 `false`）
- Modify: `apps/readest-app/src/app/library/page.tsx`（`processFile` 与 `processOpenWithFiles` 两处调用点适配；统计 `newImports`/`existingImports`）
- Modify: i18n ×2 key（`Already in library`；`Successfully imported {{count}} book(s), {{existing}} already in library`）× zh-CN/zh-TW
- Test: ingest 去重单测（两臂 existed 标记）+ 导入 toast 逻辑测试（全重复→"已在书库"；混合→合并文案；全新增→原文案）

**Toast 规则：** new>0 且 existed=0 → 现成功文案；new>0 且 existed>0 → 合并文案；new=0 且 existed>0 → `Already in library`（info）。Open With 路径全重复时照常导航到既有书（数据面不变）。

- [ ] Step 1 测试先行（ingest 两臂 + toast 分派）→ Step 2 改返回结构与调用点 → Step 3 i18n → Step 4 test-runner 全量 → Step 5 提交 `fix: distinguish already-in-library imports in toast`。

---

## T5 书库毒锁修复（Rust 批次，单独立项执行）

**Files:**
- Modify: `apps/readest-app/src/src-tauri/src/library_lock.rs`
- Modify: `apps/readest-app/src-tauri/src/lib.rs`（仅当命令签名需调整注册时）

**设计：**
- **心跳**：持锁方 spawn 线程每 3s touch 锁文件 mtime；释放（token 校验通过）时停线程再删文件。
- **陈旧回收**：现有规则"mtime 早于进程启动"保留（重启恢复）；新增"mtime 年龄 > 10s 且无心跳 → 视为陈旧可抢占"。新鲜锁绝不抢占（保既有语义）。10s > 5s 等待上限，正常保存不会误判。
- **async acquire**：`acquire_library_lock` 改 `async fn`，轮询 sleep 换 `tokio::time::sleep`，避免同步命令在主线程 sleep 冻结两个窗口最多 5s。JS 侧 invoke 无感。
- 释放/超时语义不变：错误 token 不得释放；超时返回可识别错误（沿用现字符串，调用方 toast 已由上一批修复覆盖）。

**Steps:**
- [ ] Step 1 抽纯函数 `is_stale(mtime, now_ms)` + 单测（新鲜/陈旧边界）。
- [ ] Step 2 测试先行（`#[cfg(test)]`，用 `std::fs::File::set_modified` 造陈旧锁）：①新鲜锁第二获取者超时报错；②陈旧锁被抢占成功；③错误 token 释放被拒；④心跳刷新期间不被判陈旧；⑤释放后第二获取者成功。
- [ ] Step 3 实现心跳线程（token→JoinHandle 映射，释放时 join/停）+ 陈旧判定 + async 化。
- [ ] Step 4 test-runner 执行：`pnpm fmt:check`、`pnpm clippy:check`、`pnpm test:rust`；JS 全量 `pnpm test -- --run` 收尾确认无回归。
- [ ] Step 5 提交：`fix: heartbeat and reclaim stale library save locks`。

**验收：** 手工放置一个 mtime 陈旧的锁文件后，任一窗口保存可成功（锁被回收）；双窗口正常并发保存不互相抢占；无锁时行为不变。

---

## T6 暂缓项（记录重开条件）

| 项 | 重开触发 |
| --- | --- |
| resize 跨 640px 断点底栏错型（FooterBar/TTSMiniPlayer/HeaderBar 渲染期读 window 尺寸） | 用户实际抱怨，或 T3c 未顺手覆盖时随下一轮布局任务 |
| 并发导入 overlay 闪烁（导入状态布尔改引用计数） | 用户反馈"拖第二批文件时进度消失" |

---

## 执行顺序与提交边界

**T3a → T3b → T1 → T2 → T4 → T5**（先小后大、前端先行、Rust 锁批次压轴独立）。每任务一提交；T1/T2 若实现中发现弹层与刮擦耦合，可合为一提交但须在提交说明注明。

## 完成定义

- 各任务测试全绿，最终由 test-runner 执行全量 `pnpm test -- --run`（0 失败）、`pnpm lint`（tsgo 干净、biome 无新增告警）；T5 另过 fmt/clippy/test:rust。
- 手工验收清单逐项走查：刮擦手感/Esc 回原位/#5293 不回归/Ctrl+G 循环/目录按钮无气泡干扰/朗读按钮停止态文案/桌面播放器常驻/重复导入文案/陈旧锁回收。
- 完成后更新 `ux-debug-report-2026-09-05.md` 第二节状态，并出实施报告（含每任务测试证据）。
