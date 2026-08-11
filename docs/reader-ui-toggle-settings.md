# 阅读界面翻页与章节跳转开关实现记录

> 记录时间：2026-08-11
> 本次改动：把“开启上一页/开启下一页”两个独立按钮合并为“翻页控制”，并把“上一章/下一章”按钮显示拆出为独立的“章节跳转开关”。

## 开关清单

| 开关 | 默认值 | 控制的按钮 |
| --- | --- | --- |
| Notebook | 关闭 | 顶栏“笔记本”按钮 |
| Bookmark | 关闭 | 顶栏“书签”按钮 |
| 翻页控制（Page Navigation Control） | 关闭 | 桌面底栏/移动端进度面板/正文两侧悬浮按钮中的“上一页/下一页”按钮 |
| 章节跳转开关（Chapter Navigation） | 关闭 | 左侧悬浮按钮列中的“上一章/下一章”按钮 |

“翻页控制”只控制页面级按钮，“章节跳转开关”只控制章节级按钮，两者互不干扰。左侧悬浮按钮列中的“返回/前进”历史按钮始终显示；“返回书库”悬浮按钮由原有的 `showGoToLibraryButton` 开关控制。另有“显示翻页按钮”（`showPaginationButtons`）控制正文两侧悬浮按钮组是否出现，与上面两个开关的层级不同。

开关位于阅读设置的 “Reading Interface（阅读界面）” 分组，位于 Scroll 与 Pagination 分组之间。

## 配置迁移

- 旧字段 `showPrevPageButton` / `showNextPageButton` 合并为 `showPageNavigationButtons`。
- 新增 `showChapterNavigationButtons`。
- 加载全局设置（`settingsService.loadSettings`）和书籍配置（`serializer.deserializeConfig`）时，会把旧字段映射到新字段：任一旧开关开启，则两个新开关都开启（旧行为下页面/章节按钮成组显示），随后删除旧字段。

## 布局处理

- 顶栏使用条件渲染，按钮隐藏后其余按钮自动左/右对齐，不预留占位。
- 桌面底栏为流式布局，隐藏后进度条自动补齐剩余宽度。
- 桌面底栏与移动端进度面板只按“翻页控制”渲染上一页/下一页按钮；章节跳转与历史按钮统一由左侧悬浮按钮列承担。
- 左侧悬浮按钮列按“章节跳转开关”渲染上一章/下一章按钮，历史按钮常驻；开关关闭时章节按钮不渲染。
- 正文两侧悬浮翻页按钮按“翻页控制”独立渲染。
- 移动端进度面板保持 `1fr auto 1fr` 三栏网格，中间区域留空，任何一侧按钮隐藏都不会留下空白。

## 涉及文件

- `apps/readest-app/src/types/book.ts`：`ViewConfig` 替换旧的两个布尔字段。
- `apps/readest-app/src/services/constants.ts`：默认值全部为 `false`。
- `apps/readest-app/src/utils/serializer.ts`：新增旧配置迁移函数并在反序列化时调用。
- `apps/readest-app/src/services/settingsService.ts`：加载全局设置时迁移旧配置。
- `apps/readest-app/src/components/settings/ControlPanel.tsx`：新增 2 个开关及保存/重置逻辑，补充功能范围说明。
- `apps/readest-app/src/app/reader/components/footerbar/DesktopFooterBar.tsx`：控制桌面底栏上一页/下一页按钮。
- `apps/readest-app/src/app/reader/components/footerbar/NavigationPanel.tsx`：控制移动端进度面板上一页/下一页按钮。
- `apps/readest-app/src/app/reader/components/PageNavigationButtons.tsx`：控制正文两侧悬浮翻页按钮。
- `apps/readest-app/src/app/reader/components/ReaderNavFloatingButtons.tsx`：控制左侧悬浮章节/历史按钮列，章节按钮按 `showChapterNavigationButtons` 渲染。
- `apps/readest-app/src/app/reader/components/LibraryFloatingButton.tsx`：右侧悬浮“返回书库”按钮，按 `showGoToLibraryButton` 渲染。
- `apps/readest-app/src/services/commandRegistry.ts`：补充两个开关的搜索条目。
- `apps/readest-app/public/locales/zh-CN/translation.json`：新增中文文案。
- `apps/readest-app/src/__tests__/services/constants.test.ts`：更新默认配置断言。
- `apps/readest-app/src/__tests__/utils/serializer.test.ts`：新增迁移逻辑测试。
