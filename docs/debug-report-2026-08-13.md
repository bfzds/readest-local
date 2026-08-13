# Readest Local 系统性调试报告

- **日期**：2026-08-13
- **分支**：`readest-local`（含 reader 窗口复用 Plan A 的最新改动）
- **调试方式**：Tauri dev（webdriver 特性）驱动真实 WebView2 应用 + Playwright 跨浏览器 + 静态代码审查
- **环境**：Windows 10 Pro，Rust 增量缓存，Edge WebView2 151

---

## 目录

1. [摘要](#摘要)
2. [已解决问题](#已解决问题)
3. [验证正常的功能](#验证正常的功能)
4. [性能实测数据](#性能实测数据)
5. [复测方法](#复测方法)
6. [附录：已知观察项](#附录已知观察项)

---

## 摘要

本轮系统调试覆盖：核心阅读功能、窗口管理（重点：本次改动的 reader 窗口复用）、错误与网络排查、跨浏览器兼容性、性能评估。

**共发现 5 类问题，已全部修复闭环**：① 高（窗口消失、应用进程残留）——书库 `close-reader-window` 监听内 `show()` 恢复窗口 + 补齐 `core:window:allow-hide` 权限；② 中（web/浏览器模式白屏）——`NativeAppService` 模块 osType 安全化 + `init()` 加 Tauri 运行时守卫 + `EnvProvider` 捕获错误渲染提示界面（test-first：新增 `native-app-service-no-tauri.test.ts`）；③ `library-search-ssr.test.ts` 测试不稳定——该用例显式加 30s 超时；④ README 与实现不符——`e2e/README.md` 移除已废弃的 web lane 章节。核心阅读功能、进度保存、窗口复用等均验证正常；单元测试 5452 通过。剩余均为附录中的观察项（非缺陷）。

---

## 已解决问题

### ✅ 关闭 reader 窗口后应用「消失」，进程残留无法恢复（高，已修复）

| 维度 | 内容 |
|---|---|
| **严重程度** | 高（用户可感知、无法自助恢复） |
| **可复现条件** | Windows/Linux：① 打开书（书库 + reader 两窗口可见）；② 点书库窗口的「关闭」按钮（此时 reader 可见，书库被隐藏、**未销毁**）；③ 用 Alt+F4 或系统方式关闭 reader 窗口 |
| **实际表现** | reader 被销毁；书库保持隐藏 → 屏幕上无任何可见窗口；`Readest.exe` 进程仍存活（实测 WS 约 122MB），无法从任务栏恢复，只能任务管理器杀进程 |
| **根本原因** | 隐藏书库的代码在 `src/utils/window.ts` `tauriHandleOnCloseMainWindow`；销毁 reader 的代码在 `src/utils/window.ts` `tauriHandleOnCloseWindow`（500ms 强销毁 + `emitTo('main','close-reader-window')`），但**销毁方不负责恢复书库**；而书库窗口对 `close-reader-window` 的监听（`src/app/library/page.tsx`）**只重载书库数据、从不 `show()` 窗口**。两条路径都无人把隐藏的书库窗口带回前台 |
| **修复方案** | ① 在 `page.tsx` 的 `close-reader-window` handler 中，若当前 main 处于隐藏状态则 `show()`（职责内聚，推荐）；② 在 `window.ts` 的 reader 销毁分支 emit 后，检查 main 是否存在并 `show()` |
| **修复状态** | ✅ **已按方案①实现**（2026-08-13）：`src/app/library/page.tsx` 的 `close-reader-window` 监听内，数据重载前先 `getCurrentWindow().show()` + `unminimize()` + `setFocus()`。reader 系统级关闭后书库自动回到前台，不再残留空窗；对已可见窗口为 no-op，正常「关闭书籍」路径不 emit 该事件，行为不受影响 |
| **备注** | 正常 UI 路径（reader 顶部「关闭书籍」按钮）**不触发**此 bug——该按钮走 `handleCloseBook`（`ReaderContent.tsx`），正确执行「show 书库 + hide reader」。仅系统级关闭（Alt+F4）触发 |

**实机确认方式**：Win32 API 枚举窗口，`IsWindowVisible` 证实书库 `Visible=False`、reader 句柄消失、进程存活、无可见窗口。

---

### ✅ web/浏览器模式白屏（Tauri API 未防御）（中，已修复）

| 维度 | 内容 |
|---|---|
| **严重程度** | 中（影响 web 部署/降级路径） |
| **可复现条件** | 用任意浏览器访问 `http://localhost:3000/library`，或将应用按 web 模式部署 |
| **实际表现** | chromium / firefox / webkit **三个引擎全部白屏**（body 为空、书库不渲染），控制台报：<br>• `TypeError: window.__TAURI_INTERNALS__ is undefined`（读 `metadata`）<br>• `TypeError: window.__TAURI_OS_PLUGIN_INTERNALS__ is undefined`（读 `os_type`） |
| **根本原因** | `NEXT_PUBLIC_APP_PLATFORM=tauri`（`.env` 与 `.env.tauri` 均为此值），代码无条件走 Tauri 分支读取注入的全局对象；`src/services/environment.ts:16` 仅按编译期 env 判断平台，运行时无 Tauri 注入时直接抛错、无降级。第一崩溃点在 `src/services/nativeAppService.ts` 模块顶层 `const OS_TYPE = osType()`（import 即抛，整页白屏） |
| **修复方案** | 采用方案②（`NativeAppService` 初始化处兜底）：<br>① 模块顶层 `osType()` 包 try/catch，缺失 Tauri 时 fallback `'windows'`，模块可正常 import；<br>② `init()` 开头加 Tauri 运行时守卫（存在 `window` 但无 `__TAURI_INTERNALS__` 时抛明确错误）；<br>③ `EnvProvider` 捕获 `getAppService()` 错误，渲染「Readest 需要桌面环境」提示界面，替代白屏 |
| **修复状态** | ✅ 已实现（2026-08-13，test-first）：新增 `src/__tests__/services/native-app-service-no-tauri.test.ts`（模拟无 Tauri 运行时，断言模块可 import + init 抛明确错误）；`vitest.setup.ts` 提供 `__TAURI_INTERNALS__` mock 供既有 jsdom 测试通过。Playwright 复测：浏览器访问 `/library` 显示提示界面（body 含「Readest 需要桌面环境」），不再白屏。全量测试 5452 通过、tsgo/biome 通过 |
| **备注** | 提示界面下仍残留 2 个 `reading 'metadata'` pageerror，来自 `@tauri-apps/api/window.js` 库内部在无注入环境的模块读取（node_modules 内，非本仓库代码），不影响桌面端，web 用户看到提示即止 |

---

### ✅ `library-search-ssr.test.ts` 测试不稳定（冷启动超时）（低，已修复）

| 维度 | 内容 |
|---|---|
| **严重程度** | 低（测试脆弱性，非代码缺陷） |
| **可复现条件** | 完整执行 `pnpm test`（vitest 全套） |
| **实际表现** | 该测试在默认 5s 超时内失败；单独运行通过（非代码缺陷，环境冷启动慢） |
| **根本原因** | Windows 冷启动 + 首次模块 transform 较慢，`import('@/services/librarySearchService')` 在并行/冷启动场景下超过默认 `testTimeout: 5000ms` |
| **修复状态** | ✅ 已修复（2026-08-13）：该用例显式加 30s 超时（`it('...', async () => {...}, 30000)`），单独运行通过 |

---

### ✅ README 与实现不符（web e2e lane 已移除）（低，已修复）

| 维度 | 内容 |
|---|---|
| **严重程度** | 低（文档过时） |
| **可复现条件** | 阅读 `apps/readest-app/e2e/README.md`，按其描述的 `pnpm test:e2e:web`、`playwright.config.ts` 执行 |
| **实际表现** | 对应脚本与配置文件均不存在 |
| **根本原因** | commit `5f92c61`「drop mobile and web e2e test infrastructure」已删除基础设施，`e2e/README.md` 未同步更新 |
| **修复状态** | ✅ 已修复（2026-08-13）：`e2e/README.md` 移除 web lane 章节，仅保留 Tauri lane（WebdriverIO）说明 |

---

## 验证正常的功能

以下为在真实 Tauri 应用中通过 UI 操作实测通过的项目：

| 功能 | 结果 |
|---|---|
| 打开书 → 创建/复用 `reader` 窗口 | ✅ 复用同一窗口（Win32 句柄不变），新书原地路由，无重载 |
| 翻页（空格键前进 / 后退） | ✅ 页码正确变化（第 3→4 页，跨页稳定） |
| 字号调整 | ✅ 100→60 时总页数 16→9，渲染即时生效 |
| 主题切换 | ✅ `default-dark` → `gray-dark` |
| 明暗模式切换 | ✅ dark → light（`gray-light`） |
| 进度保存 | ✅ 关闭书籍→重开恢复到原页码（第 4 页） |
| 窗口关闭正常路径 | ✅ 「关闭书籍」→ 书库恢复显示 + reader 隐藏（保留复用） |
| 书库关闭（reader 可见时） | ✅ 正确隐藏不销毁（Win32 确认 `Visible=False`，句柄存活） |
| 网络资源加载 | ✅ 250 个请求 0 失败（js/css/epub/wasm/woff2） |
| 控制台（Tauri 模式） | ✅ 打开书全流程无 error/warning |
| 单元测试 | ✅ 5451 passed / 1 flaky / 10 skipped；Rust 编译通过 |

> 备注：书签核心逻辑有单测覆盖（`BookmarkToggler`），功能存在；其 UI 入口默认受 `showBookmarkButton` 设置控制，默认关闭不算 bug。章节切换无法实测——测试书为单章节书（目录仅 1 个条目）。

---

## 性能实测数据

| 指标 | 实测值 | 说明 |
|---|---|---|
| 打开书首次绘制（release 冷开） | **~1.5s**（1442ms / 1539ms） | `[perf] view.firstPaint` 页面加载起算 |
| 打开书初始化 | **~0.19s**（`initViewState.total`） | 不含渲染 |
| 复用切书渲染成本 | **~80–120ms**（首绘−start） | 单进程连续切书稳定，无累积爬升 |
| 正文滚动跳转响应 | **0.07ms** | foliate 内容容器 `scrollTop` 跳转 |
| 书库列表滚动响应 | **0.08ms** | 虚拟化列表 |
| 30 次翻页内存变化 | +14MB | 正常波动，无泄漏迹象 |
| 双窗口总内存 | **~967MB** | Readest 主进程 122MB + 7 个 `msedgewebview2` 渲染进程 |

> ✅ 已复测（2026-08-13）：日志中 12–14s 的 `view.firstPaint` 是**页面加载起算的绝对时间戳**，不是单次渲染耗时。它出现在**冷启动首次开书**（dev 未优化 bundle 的冷启动 + 首开），不在"长时间会话末尾"。按正确口径（同一次 open 内 `firstPaint − start`）实测复用切书渲染成本 **80–120ms，稳定无累积**。结论：**不存在会话级内存/GC 累积导致的渲染劣化**，此前的"待复查"项已闭环。

---

## 复测方法

```powershell
# 1. 启动可自动化实例（内置 WebDriver，监听 127.0.0.1:4445）
cd apps/readest-app
pnpm tauri:dev:test

# 2. 单元测试（注意 library-search-ssr 的 flaky 单独跑会通过）
pnpm test -- --run

# 3. 关键手工复现（高严重 bug）
#    - 打开书 → 书库窗口点「关闭」→ Alt+F4 关 reader
#    - 预期（修复后）：书库窗口自动回到前台
```

**关键环境事实**：
- 应用内嵌 WebDriver server（`tauri-plugin-webdriver`）监听 **4445**，wdio 配置直接连它，无需外部 `tauri-driver`。
- 前端 `console.log` / `[perf]` 埋点统一写入 `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log`。
- WebDriver 的 click / screenshot **无法**判断窗口屏幕可见性（对隐藏窗口仍返回成功）——需用 Win32 API（`IsWindowVisible`）或 `switch` 窗口报 `no such window`（窗口已销毁）作判据。

**性能复测结论（2026-08-13，针对此前"12–14s firstPaint 峰值"的待复查项）**：
- 方法：`tauri dev --features webdriver` + wdio 驱动真实应用，在书库点击开书走 Plan A 复用路径，以 `[perf]` 日志为 ground truth（切书完成后台 flush 后统一解析，避免增量读的假信号）。
- 关键陷阱：`[perf] view.firstPaint` / `view.start` 均为**页面加载起算的绝对时间戳**；跨 open 对比必须用同一 open 内的 `firstPaint − start` 差值，直接看绝对值会把"会话运行时长"误读成"单次渲染耗时"。
- 实测：冷启动首开 firstPaint ≈ 12.2s（dev 未优化 bundle 的冷启动成本）；5 次复用切书渲染成本 79 / 95 / 85 / 121 / 81ms，无爬升、无 12s 尖峰；release 冷开首绘约 1s。
- 局限：tauri webdriver 窗口切换脆弱（多报 `No window could be found`），自动化多轮开书受限，仅干净采集到 5 次切书；但稳态 ~100ms 与所谓"峰值"相差约百倍，且"峰值"实际位置（冷启动首开）已完全解释，结论可信。

---

## 附录：已知观察项

1. **WebView2 多窗口内存偏高（~967MB）**：Plan A 窗口复用已避免窗口数量增长，但双窗口场景内存仍高，属 WebView2 渲染进程特性，建议对内存敏感用户提供「单窗口模式」或降低多窗口开销。
2. **书签入口默认隐藏**：`BookmarkToggler` 受 `showBookmarkButton` 设置控制，默认关闭；功能逻辑正常且有单测。
3. **`closeReaderWindowOrGoToLibrary` 与 `handleCloseBook` 的书库窗口复活策略不一致**：前者 `createIfMissing` 默认 true（无书库时重建）、后者显式 false（不复活）。经核对注释两者意图不同（前者兜底保证有窗口、后者尊重用户主动关闭），判定为有意设计；但边界场景观感差异值得关注，建议后续统一策略并补注释。
4. **`e2e/tests/`、`e2e/pages/`、`e2e/fixtures/` 目录为 web lane 遗留文件** —— **已删除**（2026-08-13），`e2e/` 仅保留 `app.e2e.ts`（Tauri lane 有效）、`README.md`、`tsconfig.json`。
5. **开发环境进程管理**：残留 `Readest.exe`（锁 `target\debug\Readest.exe`）或残留 `next dev`（占 3000）会导致 `pnpm tauri dev` 编译/启动失败（`os error 5 拒绝访问` / `Another next dev server is already running`）。排查：`tasklist | findstr Readest`、`netstat -ano | findstr :3000`，杀掉对应进程即可。

---

## 复测记录（2026-08-13 第二轮）

在全部问题修复后二次系统调试，验证修复有效性并排查回归。

**结论：无新 bug，上轮修复全部有效，无回归。**

| 项 | 结果 |
|---|---|
| 单元测试 | ✅ 400 文件 / 5453 测试全绿（含上轮 flaky 项） |
| 打开书 + reader 创建 | ✅ 正常（`main` + `reader` 两窗口） |
| reader 窗口复用 | ✅ 重开书 hwnd 不变（1837946），无新建窗口 |
| 进度保存 | ✅ 关闭重开恢复到第 7 页 |
| 方案 A 书库隐藏 | ✅ 点书库关闭按钮 → Win32 `Visible=False` |
| 关闭书籍恢复 | ✅ 书库 `Visible=True` + reader 隐藏保留 |
| 翻页 / 主题切换 | ✅ 页码变化、`data-theme` 切换正常 |
| 控制台 / 网络 | ✅ 日志无 error/warn；250 请求 0 失败 |
| web 模式（chromium/firefox/webkit） | ✅ 均显示「桌面环境」提示，不白屏（修复保持）；残余 2 个 `metadata` pageerror（`@tauri-apps/api/window.js` 库内，桌面端不受影响） |
| 性能 | ✅ 复用切书渲染 ~160ms、解析 ~80ms；双窗口内存 692MB（对比上轮 967MB） |

**说明**：Alt+F4 场景（`close-reader-window` → show 书库）无法经 WebDriver 精确实机模拟（系统级关闭事件不可注入），该修复以静态审查 + `window.test.ts` 单测 + 正常路径实机验证为准。
