# Readest Local 复核后 Bug 修复计划（2026-08-31）

## 0. 文档定位

本文件是对《`bugfix-implementation-report-2026-08-31.md`》逐条复核后的**后续修改计划**。它只描述要怎么改、如何验证以及如何分批提交；本轮不修改代码、不执行修复，也不把“已有自动化测试通过”当作“所有问题已经关闭”。

### 本轮结论

- **高优先级：1 项**：S-3 书内脚本仍可能触达宿主能力。
- **中优先级：7 项**：S-1/S-2、S-4、B-6、B-9、P-4、B-7、C-4。
- **低优先级或增强项：7 项**：遮罩 generation、C-6 残留监听器、P-6 hash 碰撞、C-10、C-12、焦点陷阱、P-3 cleanup。
- **P-8**：当前 `content-visibility` 优化已落地，完整虚拟化仍属于暂缓项，不作为本轮缺陷关闭依据。

## 1. 复核依据与当前基线

### 1.1 现场证据（行号以 2026-08-31 复核时为准）

| 编号 | 现场位置 | 复核结论 |
| --- | --- | --- |
| S-3 | `packages/foliate-js/paginator.js:670`、`fixed-layout.js:492/977` | iframe 仍使用 `sandbox="allow-same-origin allow-scripts"`；`FoliateViewer.tsx` 在允许脚本时会执行书内脚本。 |
| S-1/S-2 | `src-tauri/src/parser_common.rs:82`、`src-tauri/capabilities/default.json:69` | 仍放行 `BaseDirectory::Temp` 和 `$TEMP/**/*`，普通 parser 读取范围过宽。 |
| S-4 | `src-tauri/capabilities/default.json:117-145` | shell 白名单主要限制特殊字符和后缀，缺少目录、文件名及来源约束。 |
| B-6 | `src/services/bookService.ts:587-591, 640-651` | `firstMatch` 被直接当作 `existingBook` 原地修改；落盘失败时内存状态可能先被污染。 |
| B-9 | `src/services/statistics/statisticsDb.ts` 的 prune 逻辑 | 只根据本次删除页和当前保留页计算，没有历史页集合，重复 prune 会重复累计。 |
| B-7 | `src/services/libraryService.ts:57-67` | 目前是 hash 并集和 tombstone 保护，没有 revision/LWW，双窗口同时改同一本书时可能互相覆盖。 |
| C-4 | `src/app/**/page.tsx:673` 附近 `processOpenWithFiles` | `saveLibraryBooks(library)` 未 `await`，导航可能先于保存完成，失败时还可能产生未处理 rejection。 |
| P-4 | `src/services/librarySearchService.ts` 及 `library-search-algorithms.js` | worker 批内每个 section 都复用同一个 `remaining`，每节都可返回上限，批量结果仍会超算、超内存传输。 |
| C-6 | `src/components/reader/annotator/Annotator.tsx:339-422` | 需要确认既有提交是否覆盖全部监听器；匿名 `bind()`/弱集合方案仍可能残留 edge。 |
| P-6 | 内容 hash 生成路径 | 仍为 32 位 hash；极低概率碰撞在同书同章场景会造成错误复用。 |
| C-10 | `src/utils/simplecc.ts` | 仍以布尔守卫控制初始化，并发首次调用会重复 init。 |
| C-12 | `src/components/reader/ReadingRuler.tsx:293-298` | throttle 没有公开 `flush/cancel`；卸载时的补写与残留定时器存在竞态。 |
| P-3 | `Bookshelf` 拖拽 cleanup | cleanup 只取消 rAF，未统一调用 `endShelfDrag/cancelShelfDrag`，拖拽引用或 ghost 状态可能残留。 |

### 1.2 测试基线

- Web 单测：**5730 通过、10 跳过**。
- Rust 单测：**56 通过**。
- Browser 测试：仍有已知环境相关失败（`useEnv`、截图、ViewTransition、跨 section 选择等），本轮应记录失败清单和数量变化，不把环境失败误判为新回归。
- Tauri：在 Git Bash 中约 **119/121 通过**；`native-close-isolation` 属已知 Windows 路径环境波动。`pnpm test:tauri` 依赖 `bash`，在 PowerShell/cmd 中找不到 `/bin/bash` 不能直接判定代码失败。

## 2. 执行约束与协作分工

### 2.1 通用约束

1. 采用 TDD：每个缺陷先增加一个能稳定复现问题的失败测试，再写最小实现。
2. 数据写入遵循“先准备副本和临时文件，全部成功后再提交内存状态”；失败路径必须可重试且不破坏旧数据。
3. 任何权限收紧都要同时验证桌面端正常导入、打开、缩略图、备份和阅读流程。
4. 不把未经浏览器和 Tauri 双端验证的 iframe 改法直接标记为 S-3 已修复。
5. 本计划按**可回滚的提交边界**拆分；每个提交应只包含一个风险主题及其测试。

### 2.2 Sol/Luna 分工（全局约定）

- **Sol（主模型）**：负责总结上下文、拆解任务、制定计划、审阅 Luna 的测试结果并给出最终结论。
- **Luna（`gpt-5.6-luna`）**：复制 Sol 的测试方案，在独立子任务中实际运行测试，只记录命令、退出码、失败用例和环境信息；除非用户另行明确授权，不修改代码。
- 测试结果必须回传主模型，由主模型判断是代码回归、既有失败还是环境问题。

## 3. 批次一：安全边界（先做）

### Task S-3：禁用书内脚本并保留可验证的隔离路线（P0）

**目标**：立即切断恶意 EPUB 通过书内 JavaScript 触达宿主 IPC 的路径，同时不破坏 Foliate 的 DOM 分页；真正的 iframe origin 隔离另立架构任务。

**涉及文件**

- `packages/foliate-js/paginator.js:670`、`fixed-layout.js:492/977`
- `apps/readest-app/src/components/reader/FoliateViewer.tsx`（脚本允许开关及调用路径）
- 现有 HTML sanitizer、EPUB 导入/渲染测试文件

**实施步骤**

1. 先为含 `<script>`、事件属性（如 `onclick`）和 `javascript:` URL 的 EPUB fixture 增加回归测试。
2. Tauri 生产环境将“允许书内脚本”默认值固定为关闭；除非有明确的受控实验开关，不向普通书籍暴露脚本执行路径。
3. sanitizer 在所有入口统一移除脚本节点、事件属性和 `javascript:` URL；不能只在单一渲染器入口处理。
4. 清理或禁用 `evalInlineScripts` 等执行辅助函数，并加静态搜索/单测防止生产路径重新调用。
5. 暂不直接删除 `allow-same-origin`：已有实测表明仅删除它会使 `contentDocument` 变为 `null`，导致 Foliate 同步 DOM 分页失效。另建架构任务评估 `srcdoc`、独立 origin、消息桥和权限最小化方案。

**必须覆盖的失败场景**

- 恶意脚本尝试调用 `window.__TAURI_INTERNALS__`、`invoke`、`fetch` 本地协议或读取宿主 DOM。
- 脚本、事件属性、`javascript:` URL 经过不同导入入口后仍全部被清理。
- 正常目录跳转、选中、划线、注释、翻章、固定版式分页不回归。
- 用户切换旧配置或打开历史书籍时，不能因旧设置残留重新执行脚本。

**验收标准**

- Tauri 生产构建打开恶意书时，脚本不执行且无法访问宿主 IPC。
- Web 单测、Tauri 书籍渲染回归通过；Chromium/WebView2 和 WebKit 至少各完成一次手工或自动化验证。
- 记录“脚本禁用已完成”和“真正 origin 隔离待架构验证”两个独立状态。

**建议提交边界**：`security: disable book scripts and harden sanitizer`；不要把 iframe 架构重构混入本提交。

### Task S-1/S-2：收紧 Temp 与 parser 文件 scope（P1）

**目标**：parser 只能读取应用授权的书籍/资源，不再因为 Temp 自动放行而成为任意普通文件读取入口。

**涉及文件**

- `apps/readest-app/src-tauri/src/parser_common.rs:82`
- `apps/readest-app/src-tauri/src/lib.rs` 的 parser 命令和 scope 校验
- `apps/readest-app/src-tauri/capabilities/default.json:69`
- fs/asset scope 配置及相关 Rust 测试

**实施步骤**

1. 删除整个 `BaseDirectory::Temp` 自动放行；为导入、解压和中间产物建立应用私有临时目录，并在创建时记录授权 token/根路径。
2. 将 `$TEMP/**/*` 替换为最小化的应用私有目录 glob，禁止通过路径拼接逃逸到父目录、用户 profile 或系统临时目录其他文件。
3. parser 的 OPF/nav/cover/partialMD5 等命令统一复用同一 scope 校验，不再只调用 `exists()`。
4. 规范化 Windows 盘符、UNC、符号链接、`..` 和大小写路径后再做 containment 检查；拒绝空路径、目录路径和 scope 外路径。
5. 保留用户通过文件选择器明确授权的外部书库能力，并为该授权路径生成短生命周期 scope。

**测试与验收**

- 允许：用户选择的 EPUB/PDF、应用私有临时文件、合法封面和导航文件。
- 拒绝：`$TEMP` 下任意非应用文件、父目录、系统文件、符号链接越界、空路径和目录。
- 验证导入、打开、缩略图、部分 MD5、备份恢复和升级后的旧路径兼容。

**建议提交边界**：先提交 scope/parser 校验及 Rust 测试，再单独提交 capabilities 配置；便于出现平台差异时回滚配置而保留校验代码。

**2026-08-31 执行状态（Task8 同步）**：S-1/S-2 = **部分落地**。已实施：删除 `BaseDirectory::Temp` 自动放行与 `$TEMP/**/*`；parser 命令（epub 3 + mobi 2 处）统一经 `validate_scoped_file`。未实施：应用私有临时目录 + 授权 token/根路径——原因：当前生产代码不存在对系统 Temp 的导入/解压真实落点（唯一 `os.tmpdir()` 引用在 Node/SSR 辅助），无落点即不引入无调用方的架构。**复评触发条件**：未来新增 `os.tmpdir()`、`BaseDirectory::Temp`、系统临时解压目录或临时书籍文件流时，必须同时落地应用私有目录、生命周期清理、授权 token 与跨平台 scope 回归测试。

### Task S-4：删除泛化 shell capability，收紧环境变量（P1）

**目标**：避免宽泛 shell 参数校验与 S-3 形成可利用链；只保留应用确实需要的启动能力。

**涉及文件**

- `apps/readest-app/src-tauri/capabilities/default.json:117-145`
- `apps/readest-app/src-tauri/src/lib.rs` 环境变量读取逻辑
- 全仓库 shell/spawn 生产调用点及对应测试

**实施步骤**

1. 先用静态搜索确认生产环境是否仍有 shell spawn；当前复核未发现必须保留的生产调用。
2. 若无调用，删除泛化 shell capability 和仅为其服务的白名单规则；若有调用，只允许固定可执行文件的绝对路径、固定参数模板和固定工作目录。
3. 禁止通过 shell 解释器拼接字符串；参数使用数组传递，并拒绝 `& | < > %`、换行、引号逃逸及路径重定向。
4. `get_environment_variable` 改为显式环境变量白名单，未知 key 返回拒绝或空值，不回传完整环境。
5. 增加能力清单快照测试，防止后续提交无意扩大权限。

**验收标准**：应用启动、Gamescope 检测、AppImage/Windows 启动等真实流程继续可用；任意未列入白名单的命令、参数和环境变量均被拒绝。

## 4. 批次二：数据一致性与竞态

### Task B-6：导入合并改为草稿对象 + shadow index（P1）

**目标**：任何落盘步骤失败时，内存中的书库数组、索引和订阅者状态都保持旧值。

**涉及文件**

- `apps/readest-app/src/services/bookService.ts:587-591, 640-651`
- `apps/readest-app/src/services/ingestService.ts`
- library store、metadata index 和导入失败注入测试

**实施步骤**

1. 将 `firstMatch`、重复书和 tombstone 转换为不可变草稿对象；禁止在现有 store 对象上直接写字段。
2. 在 shadow lookup index 上完成去重、合并、封面和 metadata 计算，保留原数组和原 index 不变。
3. 按“复制书文件/封面 -> 写配置 -> 写 library -> 提交 store/index”的顺序执行；每一步失败都停止后续提交。
4. 提交阶段使用单次不可变替换，并让订阅者只看到完整的新快照。
5. 补充重试路径：第一次失败后再次导入不得读取半成品或重复计数。

**失败测试场景**

- 配置写入失败、书文件复制失败、封面写入失败、旧目录删除失败。
- 批量导入中第 N 本失败，前 N-1 本是否按既有事务语义保留要明确并测试。
- 落盘失败后检查内存数组、索引、Zustand 引用和磁盘内容一致。

**验收标准**：失败不污染原对象；成功后数组、索引、配置和文件系统均指向同一版本；既有测试中“原地更新”断言应改为验证最终快照，而不是继续固化可变实现。

**建议提交边界**：先改纯合并函数和单测，再接入导入事务；不要与文件权限改动同提交。

### Task B-9：retained_pages 改为历史页集合累计（P1）

**目标**：同一页重复读取、重复 prune 或跨会话回填时，`total_read_pages` 只累计一次且不会因裁剪回缩。

**涉及文件**

- `apps/readest-app/src/services/statistics/statisticsDb.ts` 的 prune/recompute/累计逻辑
- 统计数据库 schema、迁移脚本和统计单测

**实施步骤**

1. 新增按书籍（必要时按章节）记录的历史页集合表，使用稳定 page key 去重；不要再试图从旧整数反推出历史集合。
2. 在同一事务内完成：写入阅读事件、更新历史集合、删除过期明细、重算 retained 值和总计。
3. 对重复 page key 使用唯一约束或 `INSERT ... ON CONFLICT DO NOTHING`，保证并发下也只计一次。
4. 为旧数据库提供向前迁移：保留旧整数作为已知累计下限，并在迁移说明中明确无法恢复历史页明细；从迁移点起保证精确去重。
5. 增加 recompute/DELETE/回滚路径，确保统计修复不会破坏其他阅读时间数据。

**验收标准**

- 同一页先保留、后裁剪、再重读，最终只增加一次。
- 多次 prune、应用重启、数据库迁移和并发写入结果稳定。
- 历史数据库的迁移限制和统计口径在报告中可追溯。

**建议提交边界**：schema/迁移与业务逻辑分开提交；迁移未验证前不能删除旧字段。

### Task B-7：library save 引入 revision/LWW（P1）

**目标**：双窗口、节流保存和删除操作不会让旧快照复活已删除书籍，也不会无提示覆盖新字段。

**涉及文件**

- `apps/readest-app/src/services/libraryService.ts:57-67`
- `saveLibraryBooks` 及其调用者、窗口关闭 flush、同步/导入路径
- library schema 和并发保存测试

**实施步骤**

1. 给书籍记录和可合并字段增加 `updatedAt`/revision；时间戳由统一时钟或单调递增版本生成，避免各调用点自行取值。
2. 保存前读取磁盘当前版本，按书籍行做 LWW 合并；metadata、reading status、cover 等字段复用字段级时间戳，避免整对象覆盖。
3. tombstone 必须带版本并优先于更旧的 upsert，防止删除复活。
4. `replace: true` 保留为显式全量替换，只允许初始化/迁移等受控调用，并在 API 名称或参数上明确危险语义。
5. 节流保存和窗口关闭 flush 走同一合并函数，禁止重新使用旧数组直接覆盖磁盘。

**失败测试场景**

- 窗口 A 持旧 library，窗口 B 删除书籍，A 的 30 秒节流保存不得复活。
- 一窗口改阅读进度、另一窗口改 metadata，最终两者按字段时间戳合并。
- 清空书库、导入同名书、删除后快速重建、窗口关闭 flush。

**验收标准**：并发保存可解释、可重复；日志能指出采用了哪个 revision；旧格式读取和单窗口正常保存不回归。

**建议提交边界**：先提交 schema/merge 纯函数及并发单测，再接入生产 save；不要同时改同步协议。

### Task C-4：Open With 保存必须 await；遮罩 bail 增加 generation（P1/P2）

**目标**：Open With 路径只有在书库保存成功后才导航；旧初始化轮次不能关闭新轮次的 loading 遮罩。

**涉及文件**

- `apps/readest-app/src/app/**/page.tsx` 的 `processOpenWithFiles`（复核约 673 行）
- 同页 loading 状态、`bail()`/初始化 generation 逻辑
- Open With、深链和启动恢复测试

**实施步骤**

1. 将 `saveLibraryBooks(library)` 改为 `await`，在 `try/catch` 中处理失败；保存失败时保留当前页面和错误提示，不执行导航。
2. 给每次初始化分配 generation；异步完成、失败和 `bail()` 回调只允许更新与当前 generation 相同的状态。
3. 组件卸载时取消或标记过期的 promise，避免旧轮次修改新页面。
4. 统一 Open With、新书导入和普通打开的提交顺序，避免“盘上有文件但 library 未写入”或反过来的半状态。

**验收标准**：保存失败不会出现未处理 rejection；快速连续打开/关闭、深链、Open Last Books 和 Open With 均无白屏、旧请求覆盖或错误导航；旧遮罩不会提前关闭新轮次遮罩。

**建议提交边界**：保存 await 与 generation 守卫可同属一个竞态修复提交，但测试需分别覆盖。

## 5. 批次三：性能、生命周期与可用性

### Task P-4：worker 批内共享剩余预算并在 service 端二次截断（P1）

**目标**：全库搜索始终遵守总上限，不因 section 数量增加而线性超算、超传输。

**涉及文件**

- `apps/readest-app/src/services/librarySearchService.ts`
- `packages/foliate-js/library-search-algorithms.js` 或对应 worker 协议
- 搜索 worker、fuzzy/nearby 结果测试

**实施步骤**

1. worker 接收批次总预算，而不是为每个 section 复制同一个上限。
2. 每消费一个 section 就递减共享 `remaining`；达到 0 立即停止后续扫描，并在响应中带 `capped: true`。
3. service 端按全库硬上限再次截断，防御旧 worker、异常 worker 或多批响应拼接导致的超量。
4. 保持结果排序、去重、nearby 词语上下文和取消信号语义不变。
5. 用 1、2、100 个 section 和极端高命中查询做基准，记录扫描量、传输量和首屏延迟。

**验收标准**：无论 section 数量如何变化，返回条数不超过全库上限；`capped` 语义准确；结果与旧实现逐项一致（仅允许截断位置变化）。

### Task C-6：Annotator 监听器改为具名 handler + 成对 cleanup（P2）

**目标**：反复加载章节或销毁阅读器后，监听器数量不随次数增长。

**实施步骤**

1. 对 `touch`、`pointer`、`selectionchange` 等事件定义具名 handler，保存实际绑定的 document/window 引用。
2. `onLoad` 返回幂等 cleanup；cleanup 逐一 `removeEventListener`，不使用每次生成的新 `bind()` 引用。
3. 先审计提交 `f09542e` 是否已覆盖主路径；若已覆盖，只修残留 edge，并增加测试证明主路径不重复注册。
4. 在 iframe 替换、章节预加载、组件卸载和异常加载时都执行 cleanup。

**验收标准**：同书重复打开 100 次、预加载 100 个章节、关闭 view 后无重复回调和可观测 listener 泄漏。

### Task P-6（hash）：补充长度与第二路 hash（P2）

> 原实施报告中的 P-6 还包含 transform LRU；transform LRU 已在 Task 16 落地。本节只处理本次复核发现的 **32 位内容 hash 碰撞**，不要重复改造缓存架构。

**涉及文件**：内容 hash/缓存 key 生成函数及其单测。

**实施步骤**

1. 在现有 32 位 hash 外加入内容长度，先消除最廉价的前缀/截断碰撞。
2. 再增加第二路独立滚动 hash，缓存 key 使用两路 hash + 长度 + chapter key。
3. 保留旧 key 的读取兼容期；写入统一使用新 key，避免升级后整库瞬时失效。
4. 增加构造碰撞 fixture、不同长度同 hash、同书同章跨设置的回归测试。

**验收标准**：构造的碰撞样本不会错误复用缓存；正常翻章性能和 LRU 命中率没有明显回退。

### Task C-10：simplecc 初始化共享 Promise（P2）

**目标**：并发首次划词只初始化一次；初始化失败后仍可重试。

**实施步骤**

1. 用模块级 `initPromise` 缓存正在进行的 WASM 初始化，所有调用方 await 同一 Promise。
2. 初始化成功后缓存实例；失败时清空 `initPromise`，保留错误并允许下一次调用重试。
3. Annotator/搜索调用方显式 await，并把失败转换为可见的降级提示或原文路径，不静默吞错。
4. 用 fake loader 覆盖并发、成功、失败后重试和取消场景。

**验收标准**：并发调用只触发一次 loader；失败不会永久锁死；首次划词不再因 WASM 未完成而静默失败。

### Task C-12：throttle 提供 `flush/cancel`，ReadingRuler 卸载时 flush（P2）

**目标**：拖动阅读尺后立即关闭或切换页面，不丢最后位置，也不让旧定时器晚到写回旧 state。

**实施步骤**

1. 扩展 throttle 返回值：`flush()` 立即提交最新值，`cancel()` 清除待执行 timer 和 pending 参数。
2. `ReadingRuler` 在卸载、书籍切换和持久化目标变化前调用 `flush()`；不再额外写一份可能过期的当前值。
3. 组件销毁后调用 `cancel()`，保证旧 timer 不再触发 store 写入。
4. 用 fake timers 覆盖 10 秒窗口内卸载、连续拖动、切书和保存失败重试。

**验收标准**：最后位置稳定落盘；卸载后无旧 timer 写入；现有节流频率和正常拖动体验不变。

### Task 焦点陷阱：CommandPalette/Dialog 键盘循环（P2）

**目标**：键盘用户在弹层内按 Tab/Shift+Tab 时焦点不逃逸，并在关闭后返回触发控件。

**实施步骤**

1. 明确初始焦点（搜索输入或第一可执行项），弹层打开后 focus；空列表也要有可聚焦的安全目标。
2. 在首尾元素间实现 Tab/Shift+Tab 循环，过滤 disabled、不可见和 `tabindex=-1` 元素。
3. 保留 `aria-modal`、dialog role 和关闭后的返焦；嵌套弹层按栈恢复焦点。
4. 增加键盘单测和至少一次屏幕阅读器/键盘手工验收。

**验收标准**：焦点不落到背景页面；Escape/选择命令后返焦稳定；鼠标和触屏操作不受影响。

### Task P-3：拖拽 cleanup 统一调用幂等 `cancelShelfDrag`（P2）

**目标**：effect 重跑、组件卸载或拖拽中断时，ghost、命中高亮、引用和 rAF 全部清理。

**实施步骤**

1. 将 `cancelShelfDrag()` 设计为幂等函数，统一清理 pointer capture、ghost、highlight、坐标引用、pending rAF 和状态标记。
2. 在 effect cleanup、组件卸载、窗口失焦、Escape 和 drop 失败路径调用它。
3. 保证正常 drop 只提交一次，cleanup 重复调用不会触发额外保存或状态更新。
4. 增加“拖拽中 effect 重跑/组件卸载”的测试；保留已有 rAF 性能测试。

**验收标准**：不会残留 ghost 或高亮；下一次拖拽从干净状态开始；拖拽语义、排序和边缘翻页不变。

## 6. P-8 暂缓与复评条件

当前 `LibrarySearchResults.tsx` 已使用 `content-visibility` 跳过屏外渲染，属于**部分优化**，不是完整虚拟化。由于完整虚拟化需要同时兼容 sticky header、多本展开、键盘主导航和 ARIA 语义，本轮不把它作为缺陷修复项继续推进。

只有在以下条件同时满足时才重新排期：

- 真实桌面端大书库数据证明当前首屏或滚动仍明显卡顿；
- 有可重复的性能基准和目标（例如首屏时间、滚动帧率、内存峰值）；
- 先完成可访问性和 sticky header 的原型验证；
- 有完整回归测试和可回滚方案。

## 7. 推荐执行顺序与提交安排

1. **S-3 脚本禁用与 sanitizer**：先切断最高风险路径，并单独记录 origin 隔离后续架构任务。
2. **S-1/S-2 scope 收紧**：权限配置和 parser 校验完成后再做跨平台回归。
3. **S-4 shell/env**：删除不必要能力，避免与安全边界形成组合攻击面。
4. **B-6 导入事务**、**C-4 Open With/generation**：优先消除失败时的数据和页面状态污染。
5. **B-9 统计页集合**、**B-7 revision/LWW**：先完成 schema/迁移测试，再接入生产写入。
6. **P-4 搜索预算**：修复明确的批量上限问题并做基准。
7. **C-6、C-10、C-12、P-3**：按组件边界逐项处理生命周期和并发。
8. **P-6 hash、焦点陷阱**：作为低风险增强项独立提交。
9. P-8 维持部分实现状态，等待数据驱动的复评。

建议每个编号至少形成一个独立提交；涉及数据库迁移、权限配置或 iframe 行为的提交必须能单独回滚。合并前由主模型检查提交是否混入无关重构。

## 8. 回归验证方案（执行时使用）

### 自动化命令

在 `apps/readest-app` 目录执行：

```bash
pnpm test -- --run
pnpm test:browser
pnpm fmt:check
pnpm clippy:check
pnpm test:rust
pnpm test:tauri
```

其中 `pnpm test:tauri` 必须在 Git Bash 或其他提供 `bash` 的环境运行；PowerShell/cmd 报 `/bin/bash` 不存在时，记录为环境阻塞并换环境复跑。

### Luna 测试记录格式

每批完成后由 `gpt-5.6-luna` 在独立子任务执行与 Sol 相同的命令，并回传：

- 命令和工作目录；
- 退出码；
- 通过、跳过、失败数量；
- 失败用例和首个堆栈；
- 是否疑似既有环境问题；
- 未执行项目及原因。

Luna 不修改代码、不改测试快照、不删除失败产物。主模型收到结果后再决定是否重跑、缩小范围或判定回归。

### 手工验收清单

- 打开含恶意脚本、事件属性和 `javascript:` URL 的 EPUB，确认无 IPC/本地资源访问。
- 正常 EPUB 的翻章、选中、划线、注释、目录跳转和固定版式分页。
- 外部授权书库导入、缩略图、部分 MD5、备份恢复及升级后路径。
- 双窗口删除/修改同一本书，观察节流保存、窗口关闭 flush 和磁盘最终内容。
- 重复 prune、重启和旧数据库迁移后的统计页数。
- Open With 保存失败、快速关闭页面、深链和 Open Last Books。
- 大量 section 的高命中搜索，确认总上限、排序、取消和首屏延迟。
- 反复打开章节、销毁 Annotator、拖拽中卸载/effect 重跑，确认无监听器、ghost、timer 残留。
- 键盘操作 CommandPalette/Dialog 的 Tab、Shift+Tab、Escape 和返焦。

## 9. 完成定义与报告要求

一个条目只有在以下条件都满足后才能标记“已修复”：

1. 有针对现场证据的自动化回归测试，且测试在实现前曾能稳定失败或有等价故障注入证明。
2. 实现通过对应的 Web/Rust/Tauri 检查，并由 Luna 提供退出码和失败清单。
3. 完成必要的桌面端手工验收；已知环境失败与代码失败分开记录。
4. 提交边界、迁移策略、回滚方式和未覆盖风险写入实施报告。
5. S-3 必须分别报告“脚本禁用/清洗已完成”和“真正 iframe origin 隔离是否完成”，不能用前者替代后者。

本计划文档本身不代表任何代码项已经修复；执行完成后应另行更新实施报告和验收状态。
