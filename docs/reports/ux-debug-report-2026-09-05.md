# 用户体验 Bug 排查报告（2026-09-05）

- 依据：`ux-debug-plan-2026-09-05.md`（自主 debug 路线，不套用项目内规范）
- 分支：`readest-local`；改动**未提交**，待用户决定提交方式
- 验证：test-runner 子代理执行 `pnpm test -- --run`（5765 通过 / 0 失败 / 10 跳过）与 `pnpm lint`（tsgo 干净，biome 仅 1 个既有无关 warning）

---

## 一、已修复（4 项，均已通过全量测试）

### 1. 书库启动加载遮罩在异常路径下永久卡死（P1）
- 位置：`apps/readest-app/src/app/library/page.tsx`（initLibrary 调用点）
- 症状：冷启动时 `loadSettings`/`loadLibraryBooks` IPC 失败、封面 blob URL 生成失败等任何一步 reject，`initLibrary` 的 async 链中断，`bail()` 永不执行 → 全屏"加载中"遮罩常驻，应用不可点击，只能重启。此前修复只覆盖了 stale 提前退出路径，漏了异常路径。
- 修复：`initLibrary().catch(...)` —— 复用 `bail()` 收尾本轮流次；active 轮失败时给出"Failed to load library"错误 toast。

### 2. TTS 启动窗口期内点停止 → 朗读失控且无法再停止（P1）
- 位置：`apps/readest-app/src/app/reader/hooks/useTTSControl.ts`
- 症状：点"朗读"后（Edge/网络 TTS 初始化可达数秒）立刻点停止：`handleStop` 清空 `ttsControllerRef` 并复位 UI，但 `handleTTSSpeak` 在 await 恢复后无取消检查，继续在已 shutdown 的控制器上调 `speak()`，并把 `ttsEnabled` 重新置 true——此后所有 tts-stop（浮动按钮、快捷键 T、播放器）都在 ref 判空处变成 no-op，语音停不下来，只能关书。
- 修复：① init 后加守卫 `ttsControllerRef.current !== ttsController` 即放弃本次启动；② 快速 stop→start 时被并发守卫吞掉的第二次启动改为挂起、在途启动收尾后自动重放（修"按了播放没反应"）。

### 3. 导入"看似成功"实际磁盘未写入——重启后书消失（P1）
- 位置：`apps/readest-app/src/app/library/page.tsx`（runImportBooks 保存段 + processOpenWithFiles）
- 症状：双窗口场景下书库锁超时（5s）时 `saveLibraryBooks` 抛错，但书已进内存 store（书架可见），错误又无任何 toast（未处理 rejection）→ 用户以为导入成功，重启后书全部消失。Open With 打开损坏文件同样零反馈。
- 修复：① 导入保存失败 → "保存书库失败，本次更改可能未保存"错误 toast，并抑制误导性的"导入成功"toast；② Open With 单文件解析失败 → 复用现有 per-file 失败 toast；Open With 保存失败 → 保存失败 toast。

### 4. 书架拖拽两处交互缺陷（P2/低）
- 位置：`apps/readest-app/src/app/library/components/Bookshelf.tsx`
- 修复：① Escape 现在可取消进行中的拖拽（此前拖起后无法反悔）；② 选择模式下不再误触拖拽（此前多选时轻拖格子会触发排序交换而非选中）。

### 附带
- i18n：新增 key `Failed to save library`（zh-CN + zh-TW，locale 对齐测试 C-13 通过）。
- `src/__tests__/debug/` 遗留脚手架的 3 个 tsgo 类型错误修复（此前 lint 红灯的主因）。

## 二、证实但未修（需产品/架构决策）

| 项 | 症状 | 不修理由 |
| --- | --- | --- |
| 桌面端失去进度条滑杆/页码跳转入口 | 640px 以上窗口无拖动跳页 UI（键盘/命令面板也无等价物），仅保留进度百分比显示与章节浮动按钮（默认关闭） | 按交接文档这是用户要求的重构结果，恢复与否是产品决策 |
| 书库锁"毒锁" | 读窗在保存中途被销毁时锁未释放，同进程兄弟窗口视为"新鲜锁"不抢占，之后所有保存超时 5s 失败（现在至少有 toast 了） | 需 Tauri 侧按 owner 窗口回收锁，属架构级改动，建议单独立项 |
| TTS 迷你播放器 5s 自动隐藏 | 桌面默认 full 样式 5 秒后淡出，重新唤出仅剩顶栏 hover / TOC 按钮；浮动 Speak 按钮的 aria-label 恒为"Speak" | 机制属有意设计，改进属打磨项 |
| 重复导入同一文件提示"导入成功" | 去重路径按成功计数 | 数据无损，文案问题 |
| 窗口跨 640px 断点 resize 后底栏短暂错型 | 渲染期读 `window.innerWidth` 且无 resize 监听 | 下次交互自愈，TTS 播放期间有 1s 轮询自愈 |
| 并发导入 overlay 闪烁 | 第二批导入隐藏进度 UI | 无数据风险，低频场景 |

## 三、证伪/无需处理

- 拖拽引擎核心（落点语义 B-4、循环守卫、rAF 批处理、pointercancel/卸载清理）：代码级走查干净，纯函数测试在位。
- 跨窗口书库保存的 LWW/merge-floor、原子写、陈旧锁重启恢复：设计自洽。
- 浏览器套件既有 5~6 个"环境性失败"：本轮全量 jsdom 套件 0 失败，未发现新增真 bug 混入（跨 section 选择失败仍在 browser-only 套件，本轮未实机验证）。

## 四、验证记录（test-runner 执行）

| 命令 | 首轮 | 修复后 |
| --- | --- | --- |
| `pnpm test -- --run` | 5764 过 / 1 败（zh-TW 缺 key） | **5765 过 / 0 败 / 10 跳** |
| `pnpm lint` | tsgo 3 错（debug 脚手架） | **tsgo 干净，biome 仅 1 既有 warning** |
