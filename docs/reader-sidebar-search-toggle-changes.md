# 侧边栏搜索按钮右移与默认显示开关 变更记录

> 记录时间：2026-08-11
> 计划文档：`docs/superpowers/plans/2026-08-11-reader-search-button-and-sidebar-toggle.md`

## 本次改动

1. 新增右下角浮动搜索按钮 `SearchFloatingButton`，位于“目录”浮动按钮正上方（`bottom-40 sm:bottom-32`，与 TOC 的 `bottom-24 sm:bottom-16` 相差一格）；两者同为 `right-4 w-12`，中心点在同一竖直线上。
   - 点击后打开当前书侧边栏、切到目录 Tab 并显示搜索栏。
   - 侧边栏已打开且属于当前书时按钮隐藏，与 `TOCFloatingButton` 行为一致。
2. 从侧边栏头部 `SidebarHeader` 移除旧搜索按钮及相关 props。
3. 新增 `ViewSettings.showSideBar` 布尔字段，默认 `false`。
4. 阅读设置 `ControlPanel` 的 Reading Interface 分组新增 “Sidebar / 侧边栏” 开关，默认关闭，即默认隐藏侧边栏。
5. `useSidebar` 初始化时仅在“已固定侧边栏且 `showSideBar` 为 true”时自动显示侧边栏。

## 涉及文件

- 新建：`apps/readest-app/src/app/reader/components/SearchFloatingButton.tsx`
- 修改：`apps/readest-app/src/app/reader/components/BooksGrid.tsx`
- 修改：`apps/readest-app/src/app/reader/components/sidebar/Header.tsx`
- 修改：`apps/readest-app/src/app/reader/components/sidebar/SideBar.tsx`
- 修改：`apps/readest-app/src/app/reader/hooks/useSidebar.ts`
- 修改：`apps/readest-app/src/types/book.ts`
- 修改：`apps/readest-app/src/services/constants.ts`
- 修改：`apps/readest-app/src/components/settings/ControlPanel.tsx`
- 修改：`apps/readest-app/public/locales/zh-CN/translation.json`
- 修改：`apps/readest-app/public/locales/en/translation.json`
- 测试：`apps/readest-app/src/__tests__/app/reader/hooks/useSidebar.test.tsx`
- 测试：`apps/readest-app/src/__tests__/components/SearchFloatingButton.test.tsx`
- 测试：`apps/readest-app/src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx`
- 测试：`apps/readest-app/src/__tests__/services/constants.test.ts`

## 验证结果

- `pnpm test -- --run ...`：5 个相关测试文件全部通过（141 个用例）。
- `pnpm lint`：通过，无本任务引入的错误。

## 未提交事项

- `types/book.ts`、`ControlPanel.tsx`、`zh-CN/translation.json` 中原本就有用户未提交改动，且与本次新增代码相邻，无法干净拆分，尚未提交。
- 建议用户确认后统一提交，或授权 Codex 将这批文件一并提交。
