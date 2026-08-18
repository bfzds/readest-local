# Readest Local Debug 增量报告（2026-08-16）

- **日期**：2026-08-16
- **分支/HEAD**：`readest-local` @ `d836901`（与 08-15 报告基线一致，无新提交）
- **性质**：**只读静态复核 + 待处理项二次确认**（分析型）。除本报告外未改任何代码文件；不提交 git。
- **工作区**：`apps/readest-app/AGENTS.md` 仅新增 Windows symlink 说明（文档，无关行为）；`packages/tauri` 子模块改动经 08-15 确认是行尾伪影。
- **执行内容**：对 08-15 报告 §3.2/§4 列出的 9 项待处理项逐一 grep 现场复核，确认全部仍存在、行号核对、补 1 条新证据（iframe 事件转发机制）。

---

## 1. 项目画像摘要

与 08-15 报告一致：Tauri 2 桌面电子书阅读器（Next.js 16 + React 19 + zustand + foliate-js + Turso/SQLite）。HEAD 无新提交，模块结构、技术栈无变化，不重列。

**基线**：HEAD 与 08-15 基线 `d836901` 相同，前端文件/用例数无提交可变更；本轮未重跑测试（无新提交，静态复核性质）。以 08-15 基线为准：**vitest 5555 通过 / 0 失败**、tsgo 0 错、biome 0 问题、clippy 0 警告。

---

## 2. 模块树状图（本轮复核涉及文件定位）

```
apps/readest-app/src
├── app/reader/components/
│   ├── FoliateViewer.tsx          阅读正文挂载（EPUB/PDF 于 iframe 内，:450）
│   ├── sidebar/SideBar.tsx        F 键开关搜索栏、handleHideSearchBar（:136）
│   └── sidebar/SearchBar.tsx      input 自动聚焦（:98,146）
├── app/reader/hooks/useBooksManager.ts   换书淘汰、view.close、READINESS_TIMEOUT
├── app/reader/utils/iframeEventHandlers.ts  iframe 事件 postMessage 转发
├── hooks/useShortcuts.ts          activeElement 类型跳过快捷键（:42-53）
├── hooks/useSuppressDefaultContextMenu.ts  window 级 contextmenu 屏蔽（:19）
├── services/
│   ├── bookService.ts             updateCoverImage 覆写同一封面文件（:262-274）
│   ├── librarySearchIndex.ts      writeSearchIndexSection 逐节写库（:115-129）
│   ├── librarySearchService.ts    indexDbs 会话级 Map、getIndexDb（:299,373-388）
│   ├── statistics/statisticsDb.ts page_stat_data 只插不清理（:123-138）
│   └── dictionaries/providers/mdictProvider.ts trackedUrls 无界（:410,662-669）
├── utils/
│   ├── coverThumbnail.ts          createObjectURL 缩略图（:22）
│   └── coverThumbnailCache.ts     缓存值 Promise<T>、驱逐只删 key（:35-43）
└── components/BookCover.tsx       缓存 key=coverSrc（:38,45）
```

---

## 3. 分模块调试指南（桌面端定制）

### 3.1 工具链

| 层 | 工具 | 配置/命令 |
|---|---|---|
| 前端 React 状态 | React DevTools | WebView2 远程调试端口见下，React DevTools 经 `/devtools` 协议附加 |
| WebView2 调试 | 远程调试端口 | `webview2 参数 --remote-debugging-port=9222`，Chrome DevTools 连 `http://localhost:9222`（本机可用 webdriver 4445 既有配置，见调试方法记忆） |
| Rust | rust-analyzer + CodeLLDB | VS Code `launch.json` 接 `src-tauri`；`cargo test -p Readest --lib` |
| 日志 | 前端 console / Rust 后端 | 桌面端无需集中化；单机日志轮转交给 WebView2 控制台 |

### 3.2 典型错误排查表（本轮相关）

| 现象 | 原因 | 验证 |
|---|---|---|
| 关闭搜索栏后 F/翻页/全屏失效 | 焦点留在 `visibility:hidden` 的 input 内，`useShortcuts.ts:42-53` 判定为输入态 | 按 Esc 或点击正文恢复；`document.activeElement` 查 DOM |
| EPUB 正文右键弹浏览器菜单 | `contextmenu` 不跨 iframe 冒泡，`useSuppressDefaultContextMenu.ts` 只在父 window 监听 | 右键正文对比右键空白处 |
| 换封面后书库仍显旧图 | 缓存 key=`coverImageUrl` 稳定，覆写同一文件 URL 不变 | 改封面后刷新书库 |
| 长会话书库内存增长 | 封面 object URL 只建不 revoke | 大量滚动书库后 DevTools Performance 采样 heap |

---

## 4. 性能分析矩阵（按优先级，全部为现场复核确认）

| 优先级 | 模块/瓶颈 | 量化影响 | 建议 | 预期收益（估算） | 难度 |
|---|---|---|---|---|---|
| **P0** | F 键关闭搜索栏后快捷键全失效（新1） | 每轮需 Esc/点击恢复，快捷键体系失效 | `handleHideSearchBar` 先 `blur()` 焦点元素 | 恢复快捷键 | 低 |
| P1 | EPUB 正文右键仍弹原生菜单（新2） | 阅读正文右键目标未达成，iframe 内失效 | iframe 文档内监听 contextmenu 或 postMessage 转发 | 达成屏蔽目标 | 中 |
| P1 | 封面缩略 object URL 泄漏（新3） | 每封面 30-80KB 累积，会话内只增不减 | 缓存值改存已 resolve URL，驱逐/clear 时 revoke | 内存停止增长 | 中 |
| P1 | 封面缩略缓存无失效（新4） | 换封面后永久旧图直至 LRU/重启 | key 掺文件 mtime 或在 updateCoverImage 处清缓存 | 正确显示 | 低 |
| P1 | 搜索索引逐节 DELETE+INSERT（SF2） | 500 节 ≈1,000+ 次独立 execute 往返 | `db.batch()` 合并为多值事务 | 往返次数减到个位 | 中 |
| P1 | 双窗口并发建索引无互斥（SF3） | 并发时双倍重建工作 | getIndexDb 加 in-flight 互斥表 | 重建只触发一次 | 中 |
| P2 | MDict trackedUrls 无界（SF10） | 多词典长会话内存增长 | LRU 或按条目懒 revoke | 内存有界 | 中 |
| P2 | page_stat_data 无 TTL（SF12） | 磁盘逐年增长 | 定时聚合/裁剪 | 磁盘有界 | 中 |
| P2 | 换书旧 view `close()` 未 await（NF10） | 低概率竞态（旧 view 回调与销毁交错） | `close()` 前 await 或忽略异常 | 消除竞态 | 低 |

**新增证据（相对 08-15 报告）**：`iframeEventHandlers.ts` 转发 keydown/mousedown/mouseup/move/click/dblclick/touch/wheel/side-button 共 13 类事件（`window.postMessage`，:257-658），但**无 contextmenu 转发**——从机制上坐实正文 iframe 内右键事件既不会冒泡到父 window 的监听器，也没有 postMessage 通道，`useSuppressDefaultContextMenu.ts:19` 对它完全不可达。

---

## 5. P0 优化方案（F 键失焦，附可执行代码）

**问题**：`SideBar.tsx:136-137` `handleHideSearchBar` 只 `setSearchBarVisible(false)` 不释放 input 焦点。

**① 修复**（在 setState 前 blur 当前焦点元素）：

```ts
const handleHideSearchBar = useCallback(() => {
  // visibility:hidden 不触发 blur，焦点留在隐藏 input 内会使 useShortcuts
  // 视为"正在输入"而跳过全部快捷键（F/翻页/全屏失效）。先归还焦点。
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  setSearchBarVisible(false);
  setTimeout(() => {
    if (sideBarBookKey) clearSearch(sideBarBookKey);
  }, 100);
  getView(sideBarBookKey)?.clearSearch();
  if (!isSideBarPinned) setSideBarVisible(false);
}, [sideBarBookKey, clearSearch, isSideBarPinned]);
```

**② 配置改动**：无（纯前端）。

**③ 验证**：
1. `cd apps/readest-app && pnpm test`（回归，重点 `SearchBar.test` / `useShortcuts.test`）
2. 手动：固定侧边栏 → F 打开搜索栏 → F 关闭 → 立即按 F 应能再打开；PageDown 应能翻页。
3. 补单测：`SearchBar.test.tsx` 新增"F 关闭后 `document.activeElement` 不再为 input"断言。

---

## 6. 下一步

- **可直接修的 P1（按风险低→高）**：新4 封面缓存失效（低难度）→ 新1 F 键失焦（已给代码）→ 新3 object URL revoke → SF2 batch 写库 → 新2 iframe 右键菜单 → SF3 互斥。
- **回归要点**：新1/新2 涉及键盘/焦点/iframe，跑 `pnpm test` + 手动键盘走查；新3 需长会话内存采样确认无增长。
- **明确暂缓**：HF2（getVisibleRange 大改）、RF6（MOBI 整读）、macOS 实机项。

---

## 7. 修复记录（同日执行，全部 test-first）

| 项 | 改动 | 测试 |
|---|---|---|
| 新4 封面缓存失效 | `coverThumbnailCache.ts` 加 `delete(src)`；`bookService.updateCoverImage` 覆写后按稳定路径失效；`BookCover` effect 依赖加 `updatedAt` 触发重新生成 | `cover-thumbnail-cache.test.ts` +2 |
| 新1 F 键失焦 | 新增 `utils/focus.ts` `blurActiveElement`；`SideBar` `handleHideSearchBar` 与 `handleShowSearchBar` 关闭分支先 blur | `focus.test.ts` 新建 |
| 新3 object URL 泄漏 | `coverThumbnailCache` 支持 `revoke` 回调，驱逐/delete/clear 对已 resolve 值 revoke；`coverThumbnail.ts` 传 `URL.revokeObjectURL` | `cover-thumbnail-cache.test.ts` +4 |
| SF2 索引逐节写库 | 新增 `writeSearchIndexSections`（`batch` 合并 DELETE + 多值 INSERT，SQL 内联单引号转义）；调用方每 100 节 flush 一次 | `library-search-index.test.ts` +3 |
| 新2 iframe 右键菜单 | `iframeEventHandlers.ts` 加 `handleContextMenu`（放行编辑元素）；`FoliateViewer` 注册到 iframe 内容文档 | `iframe-context-menu.test.ts` 新建 |
| SF3 双窗口建索引互斥 | 新增 `searchIndexLock.ts` 文件锁（目录 mkdir 原子性 + mtime 陈旧接管）；`searchLibraryBooks` 重建前抢锁，拿不到跳过本书 | `search-index-lock.test.ts` 新建 |

**验证**：`tsgo` 0 错；`biome` 0 问题；vitest **5575 通过 / 0 失败**（416 文件，10 跳过）。未提交 git。
