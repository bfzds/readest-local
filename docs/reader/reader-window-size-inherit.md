# 阅读窗口继承书库窗口尺寸

## 问题

从书库打开书籍进入阅读页面时，新阅读窗口总是恢复为应用启动时的默认大小（800x600），而不是保持书库窗口当前尺寸。

## 根因

- `apps/readest-app/src/utils/nav.ts` 创建阅读窗口时硬编码 `width: 800, height: 600`。
- `tauri-plugin-window-state` 默认跟踪所有窗口；阅读窗口若保存过历史尺寸，会覆盖新窗口的初始尺寸。

## 修改

- `src/utils/nav.ts`：创建阅读窗口前读取当前窗口 `innerSize()` 和 `scaleFactor()`，换算成逻辑像素后作为新窗口初始尺寸；`showReaderWindow`、`showLibraryWindow` 改为异步。
- `src-tauri/src/lib.rs`：保持 window-state 插件默认跟踪所有窗口，阅读窗口的“记忆窗口”能力（保存/恢复上次位置和大小）不受影响。
- 调用点 `useOpenBook.ts`、`Bookshelf.tsx` 改为 `await showReaderWindow(...)`。

## 测试

- 新增用例：`inherits the current window inner size as logical pixels`，验证 2560x1440 物理尺寸在 2x 缩放下创建 1280x720 的阅读窗口。
- `pnpm test -- src/__tests__/utils/nav.test.ts src/__tests__/utils/nav-window.test.ts` 通过（36 个用例）。
- `cargo check -p Readest` 通过。
- Biome lint 与 `cargo fmt --check` 通过。

## 注意

- 当前实现继承内容区域尺寸；书库窗口最大化时，阅读窗口以相同内容尺寸打开但不会自动携带“最大化”状态。
- 阅读窗口已有保存的历史状态时，window-state 会在创建后恢复历史尺寸，此时以“记忆窗口”优先；没有历史状态的新窗口才使用书库当前尺寸。
- 全量 `tsgo --noEmit` 目前被 `src/__tests__/services/import-metahash.test.ts` 中已有的语法错误挡住，与本次修改无关。
