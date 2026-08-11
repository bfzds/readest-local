# 阅读页左侧按钮列改动记录

日期：2026-08-11

范围：`apps/readest-app` 阅读页

## 本次改动

1. 新增“返回书库”悬浮按钮，位于搜索按钮正上方，与目录/搜索按钮同一条竖线（`right-4 w-12`）。
2. 新增左侧按钮列，从上到下依次为：上一章、下一章、返回、前进；其中“上一章/下一章”由阅读设置里的“章节跳转开关”控制，“返回/前进”常驻显示。
3. “上一章/下一章”和“返回/前进”从桌面底栏与移动端进度面板移除，统一由左侧按钮列承担。
4. 正文两侧悬浮按钮组只保留上一页/下一页，不再重复显示章节按钮。

## 布局

- 返回书库：`bottom-56 sm:bottom-48`，在搜索按钮（`bottom-40 sm:bottom-32`）正上方。
- 左侧导航列：`bottom-24 sm:bottom-16`，按钮纵向排列，不依赖悬停；“返回/前进”常驻显示，“上一章/下一章”仅在“章节跳转开关”开启时显示；图标尺寸与目录按钮一致。
- 右侧“返回书库”悬浮按钮受原有“Show Go to Library Button”开关控制，关闭后不渲染。
- 目录按钮保持在 `bottom-24 sm:bottom-16`，与搜索按钮原有间距不变。

## 涉及文件

- 新增：`apps/readest-app/src/app/reader/components/LibraryFloatingButton.tsx`
- 新增：`apps/readest-app/src/app/reader/components/ReaderNavFloatingButtons.tsx`
- 修改：`apps/readest-app/src/app/reader/components/BooksGrid.tsx`
- 修改：`apps/readest-app/src/app/reader/components/PageNavigationButtons.tsx`
- 修改：`apps/readest-app/src/app/reader/components/footerbar/DesktopFooterBar.tsx`
- 修改：`apps/readest-app/src/app/reader/components/footerbar/NavigationPanel.tsx`
- 新增测试：`apps/readest-app/src/__tests__/components/LibraryFloatingButton.test.tsx`
- 新增测试：`apps/readest-app/src/__tests__/components/ReaderNavFloatingButtons.test.tsx`
- 新增测试：`apps/readest-app/src/__tests__/components/LibraryFloatingButtonToggle.test.tsx`（验证返回书库按钮受开关控制）

## 验证

- 相关组件测试通过（新增开关显隐用例）。
- `pnpm --filter readest-local lint` 通过。
