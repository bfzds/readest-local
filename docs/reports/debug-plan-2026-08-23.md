# Debug 修改方案：新书导入后第一次打开报 "Book not found"（2026-08-23）

## 背景

全新书籍导入成功后立即点开（第一次点击），阅读页显示"打开书籍识别"失败态；退出重进（第二次点击）正常。**仅"从未导入过"的新书触发**；已导入过（含删除后重导）的书不触发。

## 根因

竞态窗口（日志 + 代码双重确认）：

```
主窗口导入:  importBook → updateBooks(内存) ────────→ saveLibraryBooks(磁盘，批次末)
你点击:                     └── 点新书 ──→ 开阅读窗口
阅读窗口(独立 WebView):                     useLibrary 挂载 → loadLibraryBooks(读磁盘──仍旧) → initViewState 按 id 查 → 找不到 → "Book not found"
```

- 阅读页是**独立 WebView 窗口**，有独立 `libraryStore`，不共享主窗口内存（`page.tsx:532` 注释明示）。它挂载时从磁盘重读书库（`useLibrary.ts:32`）。
- 主窗口导入是"先更新内存、最后统一写盘"（`page.tsx:970-981`）。新书写盘完成前，阅读窗口从磁盘读到的仍是**不含新书的旧清单**。
- `readerStore.initViewState`（`readerStore.ts:192`）在内存清单里按 id 找不到书就抛 `Book not found`（日志 line：`Book db2f20... not found in library (size=397)`）。
- **为什么只对全新书**：`libraryStore.ts:8` 注释"list 可能含已删除书"。已导入/已删过的书无论清单状态如何**永远在数组里**，`getBookByHash` 总能命中；全新书是清单里第一次出现，旧清单里自然没有。

## 修复方案（已选：阅读窗口兜底重读）

只改一处：`readerStore.ts` 的 `initViewState`，在 `getBookByHash(id)` 未命中时**从磁盘重读一次书库再查**。此时主窗口 `saveLibraryBooks` 通常已落盘（点击发生在写盘之后），重读即拿到含新书的清单。

```ts
// readerStore.ts initViewState 内，替换现有 !book 分支：
const appService = await envConfig.getAppService();
const { getBookByHash, library, setLibrary } = useLibraryStore.getState();
let book = getBookByHash(id);
if (!book) {
  // 竞态兜底：独立阅读窗口从盘加载时可能早于主窗口写盘，读到未含新书的
  // 旧清单（全新书首次打开必踩）。此时磁盘一般已写入，重读一次再查。
  console.warn(
    `Book ${id} not in in-memory library (size=${library.length}); reloading from disk`,
  );
  const reloaded = await appService.loadLibraryBooks();
  setLibrary(reloaded);
  book = getBookByHash(id);
}
if (!book) {
  console.error(`Book ${id} not found in library after disk reload`);
  throw new Error('Book not found');
}
```

要点：
- 正常路径零影响——只有"内存没命中"的罕见窗口才多一次磁盘读。
- 复用现有 `envConfig.getAppService()` 与 `useLibraryStore`（均已 import）。
- 重读后 `setLibrary` 会让阅读窗口的清单与盘同步，`initViewState` 继续后续正常流程（解析 book doc 等）。

## 测试策略

- 新单测：`reader-store.test.ts` 中 `initViewState` 内存 miss → mock `loadLibraryBooks` 返回含该书清单 → 断言不再抛 `Book not found` 且调用了 `loadLibraryBooks`。
- 现有 mock 骨架已备（libraryStore 已 mock `setLibrary`/`getBookByHash`；需补 mock `envConfig.getAppService` 与 `loadLibraryBooks`，以及 `initViewState` 后续依赖——book doc/config/nav——使流程可跑通）。
- 若 initViewState 全量 mock 过重，退而测纯增量逻辑：断言 miss 分支触发 `loadLibraryBooks` + `getBookByHash` 二次查询。

## 验证步骤

1. `pnpm test` —— 新增用例 + 全量回归。
2. `pnpm lint`（tsgo + biome）+ 无 Rust 改动跳过 `fmt/clippy`（rule：仅 src-tauri 变更才跑）。
3. 手动：`pnpm tauri dev` 导入一本全新书 → 立即首次点击 → 应直接进入阅读页（不再出现失败态）；再导一本全新书、删除后重导验证仍正常。
4. 回归：已导入书正常打开、退出再点正常。

## 备选方案（不采用，留档）

- **导入先写盘、后更新内存**：会破坏"批次合并写盘"优化（`page.tsx:970-981` 注释注明写盘是大批导入主导成本），且阅读窗口仍可能读早，收益被兜底重读覆盖。不采用。