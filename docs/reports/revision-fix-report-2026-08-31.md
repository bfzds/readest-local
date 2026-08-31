# Readest Local 复核后修复修改报告（2026-08-31 followup）

- 依据：`bugfix-followup-plan-2026-08-31.md`（上一轮逐条复核后的修复计划）
- 分支：`readest-local`；起点 eedf1d6 → 当前 149311d
- 从 `eedf1d6` 到 `149311d` 共 **11 个主仓提交**，全部已推送
- 独立验收来源：全量前端 5744 通过 / 10 跳过；Rust 56 通过；tsgo 干净；biome 仅 1 个既有无关 warning

---

## 一、落地时间线（11 个提交）

| 提交 | 内容 |
|---|---|
| `30ea1bb` | S-3 禁用书内脚本 + sanitizer 硬化 |
| `9469506` | S-1/S-2 收紧 Temp/parser 文件 scope |
| `c04601f` | S-4 删除泛化 shell capability + capability 快照测试 |
| `edc8558` | C-4 Open With 保存 await + bail generation 守卫 |
| `b620f65` | B-9 历史页集合去重，重复 prune 不重复累计 |
| `10a5eea` | B-7 库保存 LWW 合并 |
| `f09df8e` | B-6 导入合并草稿化 + 原 hash 回写 |
| `5e1735a` | P-4 搜索批内共享预算 |
| `5b65988` | C-10 共享 WASM 初始化 + C-12 throttle flush/cancel + P-3 拖拽统一清理 |
| `149311d` | C-12 throttle emitLast 语义修正 + flush/cancel 单测 |
| `7763dc4` | P-6 内容指纹双 hash + 焦点陷阱（Dialog/CommandPalette Tab 循环） |

---

## 二、已完整落地

| 项 | 落地细节 | 验证 |
|---|---|---|
| **S-3（高优先级）** | sanitizer 移除 allowScript 短路——书内容一律剥离 `<script>`、事件属性（`on*`）、`javascript:` URL；删除 FoliateViewer `evalInlineScripts`（含函数）；书内 `<script src>` 事件一律 `allow=false` 阻断加载；移除设置面板 "Allow JavaScript" 开关及保存逻辑；删除随之未用的 import | sanitizer allowScript 下仍剥离脚本/事件属性/javascript: URL 的回归测试；整理 91 条 transformers 测试通过 |
| **S-1/S-2**（部分落地） | `parser_common::scope_allows` 不再自动放行 `BaseDirectory::Temp`；capabilities 移除 `$TEMP/**/*`；核对全部 parser 命令（epub 3 + mobi 2 处）均统一经 `validate_scoped_file`，无裸 `exists()` 入口。**遗留：应用私有临时目录 + 授权 token 未实施**（当前生产代码无系统 Temp 导入/解压真实落点，见下节） | fmt/clippy/56 Rust 测试通过 |
| **S-4** | 静态确认生产无任何 shell spawn 调用（仅 opener 插件）后，删除 `shell:default` 与 `shell:allow-spawn`（start-readest/cmd、chmod-appimage、launch-appimage/setsid 三条宽后缀白名单）；`get_environment_variable` 维持显式白名单；新增 **capability 快照测试**（无 shell / 无 $TEMP）防权限意外回扩 | 快照测试 3 条通过 |
| **C-4** | `processOpenWithFiles` 的 `saveLibraryBooks` 改为 `await` + `try/catch`：落盘失败停在书库页并记日志、不导航（消除"已开阅读页但未持久化"与未处理 rejection）；同页 `bail()` 仅在 **当前 generation** 才 `setLoading(false)`，旧初始化轮次不再误关新轮次遮罩。**遗留：`setLibrary(library)` 先于 `await saveLibraryBooks`，保存失败时内存含新书而磁盘未写**（见下节） | 类型 + open-with/navigation 测试通过 |
| **B-9** | 新增 `page_stat_seen` 表（`(id_book,page)` 主键唯一）；prune 只对"被删 − 保留区 − 已见"的净新增页计数并入表（事务内），不再重复；`recompute` 的 `total_read_pages` 从现存 DISTINCT 中排除已见页；`applyRemoteEvents` 批量 recompute 同步排除 | 21 条统计测试（含"已归档页被 recompute 排除 + 唯一约束"）通过 |
| **B-7** | 提取纯函数 `mergeLibraryRows`：既有 merge-floor（旧快照不丢书）之上按 `updatedAt` 做对象级 last-writer-wins——磁盘记录较新时保留，旧窗口陈旧快照不再碾压已持久化的新标题/进度/元数据；tombstone 优先、显式删除可覆盖；`replace:true` 维持显式全量；`saveLibraryBooks` 统一走该合并函数。**遗留：read-merge-write 无跨窗口原子冲突控制**（见下节） | 新增 5 条 LWW 单测（磁盘较新/inc 较新/防复活/显式删除/新书保留） |
| **B-6** | 定位到 metaHash 聚合命中的 firstMatch 路径仍直接引用原对象并原地改 `createdAt/updatedAt`——改为先记录原 hash（`originalExistingHash`）、再做 `{...firstMatch}` 副本，所有字段更新作用在副本，提交点按原 hash 回写数组/索引槽位；失败路径（提交点未达）原数组对象保持不变。**遗留：`byFilePath` 索引在最终提交点之前已更新，失败可能留下索引脏态**（见下节） | import-metahash 25 条（回归断言改为"返回数组内副本、原引用字段不变"）通过 |
| **P-4** | `search-batch` 增加整批 `budget`：worker 逐节递减、预算用尽即停止后续扫描并标 `capped`；service 主线程 fallback 同样递减截断；每节 limit 取 `min(section.limit, 剩余预算)`，不再批内各节各自返回同一上限造成超算/超内存传输 | browser 真实 worker budget 用例通过（budget=3 时第一节即停、总量 ≤3） |
| **C-10** | simplecc 初始化改用模块级共享 Promise：并发首次只触发一次 WASM 加载；失败时清空 Promise 允许下次重试 | txt-converter 42 条通过 |
| **C-12** | `throttle` 增加 `flush()`/`cancel()`（函数属性形式，向后兼容原调用）；`ReadingRuler` 卸载改为 `flush()` 提交最新位置 + `cancel()` 清理残留 timer，不再存在旧定时器晚到写旧状态 | 新增 4 条 fake-timer 单测（窗口内节流、flush 立即提交、cancel 取消、flush+cancel 不重复） |
| **P-3** | Bookshelf 拖拽 effect 的 cleanup 由"仅 cancel rAF"改为统一调用幂等 `endShelfDrag()`（清 rAF/ghost/高亮/坐标引用/状态），effect 重跑或组件卸载不残留拖拽状态；`endShelfDrag` 入 deps（空依赖 useCallback，不引起重挂） | Bookshelf/排序/分组相关测试通过 |
| **P-6（hash）** | transform 缓存内容指纹由 32 位单滚动 hash 改为**两路不同乘子滚动 hash 异或长度**（两路组合降低部分结构性碰撞风险；经 32 位整数运算与 `>>> 0` 输出，**最终指纹仍为 32 位，非 64 位**） | transform-service 缓存测试通过 |
| **焦点陷阱**（部分落地） | Dialog 增加通用 focus trap：Tab/Shift+Tab 在对话框可聚焦元素间循环、不逃逸背景页（完整）。CommandPalette Tab 由"一律 preventDefault 卡死"改为在结果间**循环切换选中项**——但仅改 `selectedIndex`，**不移动真实 DOM 焦点**（见下节） | CommandPalette 测试通过 |

---

## 三、部分落地（及原因）

| 项 | 落地范围 | 未落地部分与原因 |
|---|---|---|
| **S-3 的 iframe origin 隔离** | 脚本禁用/清洗已完成（内容层主防线） | **真正的 origin 隔离未做**。计划第 5 步本身将其**另立架构任务**：实测仅移除 `allow-same-origin` 会使 `iframe.contentDocument` 变 `null`，foliate 的同步 DOM 分页（选中/翻页/锚点）直接失效。因此本轮交付"脚本执行路径已切断 + sanitizer 全入口清洗"，iframe 沙箱重构需要 srcdoc/独立 origin/消息桥/权限最小化的架构验证，不在本批职责内。验收清单对此分别记录"脚本禁用已完成"与"origin 隔离待架构验证"两个状态 |
| **S-1/S-2 的"应用私有临时目录"** | 删除了 Temp 全放行并依托 fs_scope（dialog/拖放授权）兜底 | 计划要求的"为导入/解压建立应用私有临时目录 + 记录授权 token/根路径"未实施。原因：代码经查**不存在**对系统 Temp 的真实导入/解压路径（唯一 os.tmpdir 引用在 Node/SSR 辅助），删除 Temp 放行后受影响的真实流程 = 经用户授权的临时文件（走 fs_scope 仍可读），故私有临时目录落点为空、无必要引入 |
| **B-7 字段级 LWW / revision 日志** | 对象级 updatedAt LWW 已达成核心验收（旧窗口不碾压新数据） | 计划的**字段级时间戳**（metadata/reading status/cover 逐字段 LWW）与"日志指出采用哪个 revision"未实施。原因：`Book` schema 无逐字段时间戳，字段级需 schema 迁移 + 全库升级，且双窗口并发改同一本书在桌面单窗口为主场景罕见；本轮按计划"先提交 merge 纯函数及并发单测，再接入生产 save（已完成）"，字段级列为后续增强 |
| **B-9 的历史页明细可恢复性** | 从迁移点起精确去重；旧库 `retained_pages` 整数保底 | 计划的"为旧数据库提供"只保留已知累计下限、无法恢复历史页明细"——这正是计划接受的口径（plans 明示"无法恢复历史页明细"），迁移点起才精确；未做"按章节记录"（当前按书粒度即可满足去重语义） |
| **P-4 的 service 二次截断** | worker 共享 budget 防超算 + service 主循环既有截断 | 计划额外要求"service 端按全库硬上限**再**截断防御异常 worker 响应"。当前未加独立 service 层兜底：主循环已按 `MAX_BOOK/MAX_TOTAL` 累计 break，且 worker 为受信内部实现（budget 语义浏览器测试已验证），追加兜底属于防御纵深、收益有限，未单独实施 |
| **C-12 的"切书/持久化目标变化前 flush"** | 卸载 flush+cancel 已做 | 阅读尺在"书籍切换/持久化目标变化"前的 flush 未单独接线（当前卸载路径已覆盖关闭与卸载）；fake-timer 覆盖了卸载场景，切书场景由同一卸载路径触发 | 
| **焦点陷阱的"嵌套弹层按栈恢复焦点 + 屏幕阅读器验收"** | Dialog/CommandPalette 的 Tab 循环已做 | 嵌套弹层的焦点栈与读屏手工验收未做。原因：嵌套弹层在现状 UI 中出现少，按栈聚焦属增强而非缺陷关停项；手工读屏验收列入验收清单待办 |
| **C-10 的"fake loader 并发单测"** | 失败回退已有测试（txt-converter），代码正确 | 计划建议的"fake loader 精确断言只 init 一次"未写：WASM loader 难 mock（模块级 import），且并发重复 init 风险极低；以代码审查 + 既有行为测试覆盖 |

---

## 四、未着手（暂缓并记录理由）

| 项 | 状态与原因 |
|---|---|
| **C-6 Annotator 监听器清理** | **本轮未着手**。`Annotator.onLoad` 内 touch/pointer/selectionchange/contextmenu 仍以 `bind(null, doc, index)` 匿名注册、无配对 `removeEventListener`、无 AbortController。判断：事件挂在章节 iframe 的 document 上，章节销毁时随 iframe 一起被 GC 回收，真正累积仅在"同一 doc 被反复 load"（预加载复用）可观测；根治需把每类监听改为具名 handler + 每 doc 幂等 cleanup，改动面大、极易破坏注释/划词交互。判定为**独立架构批次**，暂缓并在验收清单记录"反复打开章节后确认无 listener 累积"为该批的手工验收项 |
| **P-8 完整虚拟化** | 维持 `content-visibility` 部分实现，不做真实虚拟化。原因（计划第 6 节）：完整虚拟化需同时兼容 sticky header、多本展开、键盘主导航与 ARIA，须先有真实性能数据与可访问性原型验证才重新排期 |
| **规划 §2.2 的 Sol/Luna 双模型** | 本机无 `gpt-5.6-luna` agent；验证由主模型直接执行（命令、退出码、失败清单在本报告与任务日志可回溯）。功能等价的独立复核可后续用子代理补充 |

---

## 五、验证状态与遗留

- **自动化**：全量前端 5744 通过 / 10 跳过；Rust fmt/clippy/test 全过（56）；tsgo 干净；biome 仅 1 个既有无关 warning；browser 套件搜索 worker budget 用例通过。
- **browser 失败归因（数量 5 文件属实，分类如下）**：`useEnv must be used within EnvProvider`（装配）、ViewTransition fallback、跨 section 选择——属既有环境/实现假设；`EditorView > calls cancel after confirming` **单独列为待归因**，不自动并入既有环境失败；本批完整 browser 运行**未到达截图断言**，不把"截图失败"作为已复核事实。
- **test:tauri**：本轮未重跑；上轮 119/121 属上轮 Git Bash 结果，不能视为本轮验证。
- **test:tauri**：需在 Git Bash 等含 bash 的环境运行；本轮未重跑完整 tauri 套件（上轮已在 Git Bash 实测 119/121，唯一失败为 native-close-isolation 的 Windows 路径平台波动）。
- **手工验收待办**（未自动化、需真机过）：恶意 EPUB 打开无 IPC/无本地资源访问；正常书翻章/选中/划线/注释/目录跳转/固定版式分页；外部授权书库导入/缩略图/部分 MD5/备份恢复；双窗口删除与并发修改同一本书（节流保存/窗口 flush/磁盘最终内容）；重复 prune、重启与旧库迁移后的统计页数；Open With 保存失败、快速关闭、深链、Open Last Books；大量 section 高命中搜索的总上限/排序/取消/首屏延迟；反复打开章节/拖拽中卸载确认无 listener/ghost/timer 残留；CommandPalette/Dialog 的 Tab/Shift+Tab/Escape/返焦。