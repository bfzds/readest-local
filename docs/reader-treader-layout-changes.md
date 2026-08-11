# 阅读页对齐 tReader 布局变更记录

日期：2026-08-11
范围：`apps/readest-app` 阅读页

## 改动摘要

1. 默认页边距改为上下左右 20px（紧凑模式保持 16px），正文更贴近 tReader 的四周留白观感。
2. 默认字号 16 -> 18px，行高 1.4 -> 1.3，段距 0.6 -> 0.5；CJK 行高保持 1.6。
3. 滚动模式默认最大行宽 720 -> 800px。
4. 新增右下角悬浮“目录”按钮，点击打开侧栏并直达 TOC；移动端底部栏的目录按钮移除，避免入口重复；HeaderBar 侧栏开关保留。
5. TOC 内容区底部新增常驻“上一章 / 下一章”切换条，当前章节名居中显示，不随翻页按钮开关隐藏。
6. 底部进度区左侧新增当前章节名，右侧保留百分比等进度信息；粘性进度条维持默认关闭。

## 涉及文件

- `apps/readest-app/src/services/constants.ts`
- `apps/readest-app/src/utils/config.ts`
- `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`（新增）
- `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`（新增）
- `apps/readest-app/src/app/reader/components/BooksGrid.tsx`
- `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx`
- `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`
- `apps/readest-app/src/app/reader/components/ProgressBar.tsx`

## 验证

- 新增组件测试：`TOCFloatingButton.test.tsx`、`TOCChapterNav.test.tsx`、`ProgressBar.test.tsx`
- 更新默认值断言：`constants.test.ts`
- 全量单元测试通过（397 个测试文件；1 个 SSR 导入超时在单跑时通过，判定为并发环境偶发）
- `pnpm --filter readest-local lint` 通过

## 注意

- 默认值只影响未自定义设置的阅读器用户，用户覆盖值优先。
- 右下角目录按钮在侧栏已打开且指向当前书时隐藏。
- 移动端目录入口现为右下角悬浮按钮。
