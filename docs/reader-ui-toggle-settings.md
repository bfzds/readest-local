# 阅读界面功能开关实现记录

> 记录时间：2026-08-11
> 功能：在阅读设置中新增 4 个开关，控制“笔记本”“书签”“上一页”“下一页”按钮的显示与隐藏。

## 开关清单

| 开关 | 默认值 | 控制的按钮 |
| --- | --- | --- |
| Notebook | 关闭 | 顶栏“笔记本”按钮 |
| Bookmark | 关闭 | 顶栏“书签”按钮 |
| Previous Page | 关闭 | 底栏/移动端面板/正文悬浮按钮中的“上一页”和“上一章”按钮组 |
| Next Page | 关闭 | 底栏/移动端面板/正文悬浮按钮中的“下一页”和“下一章”按钮组 |

开关位于阅读设置的 “Reading Interface（阅读界面）” 分组，位于 Scroll 与 Pagination 分组之间。

## 布局处理

- 顶栏使用条件渲染，按钮隐藏后其余按钮自动左/右对齐，不预留占位。
- 桌面底栏为流式布局，隐藏后进度条自动补齐剩余宽度。
- 正文两侧悬浮按钮按左右侧独立隐藏，两侧都关闭时整组不渲染。
- 移动端进度面板改为 `1fr auto 1fr` 三栏网格，中间“后退/前进”始终居中，任何一侧按钮隐藏都不会留下空白。

## 涉及文件

- `apps/readest-app/src/types/book.ts`：`ViewConfig` 新增 4 个布尔字段。
- `apps/readest-app/src/services/constants.ts`：默认值全部为 `false`。
- `apps/readest-app/src/components/settings/ControlPanel.tsx`：新增 4 个开关及保存/重置逻辑。
- `apps/readest-app/src/app/reader/components/HeaderBar.tsx`：控制笔记本、书签按钮。
- `apps/readest-app/src/app/reader/components/footerbar/DesktopFooterBar.tsx`：控制桌面底栏上一页/下一页按钮组。
- `apps/readest-app/src/app/reader/components/footerbar/NavigationPanel.tsx`：控制移动端进度面板按钮组并调整布局。
- `apps/readest-app/src/app/reader/components/PageNavigationButtons.tsx`：控制正文两侧悬浮翻页按钮。
- `apps/readest-app/public/locales/zh-CN/translation.json`：新增中文文案。
- `apps/readest-app/src/__tests__/services/constants.test.ts`：新增默认配置断言。
