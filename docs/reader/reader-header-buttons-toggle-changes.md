# 阅读页顶栏按钮改动记录

> 记录时间：2026-08-11
> 功能：侧边栏隐藏时同步隐藏左上角切换按钮；为“前往书库”和“在选择时启用快速操作”按钮新增显示开关，默认关闭。

## 改动内容

1. 侧边栏默认隐藏（此前已完成）：`DEFAULT_VIEW_CONFIG.showSideBar` 为 `false`，`useSidebar` 初始化时仅当侧边栏已固定且 `showSideBar` 为真才自动显示。
2. 侧边栏切换按钮与侧边栏可见性联动：阅读页左上角切换按钮从“侧边栏隐藏时显示”改为“侧边栏显示时显示”。侧边栏默认隐藏时按钮不出现，可通过目录浮窗按钮或快捷键打开侧边栏。
3. “前往书库”按钮新增显示开关 `showGoToLibraryButton`，默认关闭。
4. “在选择时启用快速操作”按钮新增显示开关 `showAnnotationQuickActionButton`，默认关闭。
5. 两个新开关位于阅读设置的 “Reading Interface / 阅读界面” 分组，与 Notebook、Bookmark 等按钮开关并列。

## 涉及文件

- `apps/readest-app/src/types/book.ts`：`ViewConfig` 新增 2 个布尔字段。
- `apps/readest-app/src/services/constants.ts`：默认值均为 `false`。
- `apps/readest-app/src/components/settings/ControlPanel.tsx`：新增 2 个开关及保存/重置逻辑。
- `apps/readest-app/src/app/reader/components/HeaderBar.tsx`：侧边栏按钮联动，两个按钮按开关渲染。
- `apps/readest-app/public/locales/zh-CN/translation.json`：新增中文文案。
- 测试：`constants.test.ts`、`ControlPanelSidebarToggle.test.tsx`。
