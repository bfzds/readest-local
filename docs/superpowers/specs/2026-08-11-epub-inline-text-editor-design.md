# 阅读器内联编辑 EPUB 正文设计

日期：2026-08-11
范围：`apps/readest-app`，React 19 / Next.js / Tauri / foliate-js；仅桌面端。

## 目标

1. EPUB 阅读页提供“编辑”入口，点击后当前章节切换到独立编辑视图。
2. 所见即所得编辑正文文字：改字、增删句子和段落，保留原有排版。
3. 保存后重新打包 EPUB、覆盖当前书文件、更新书库记录，并尽量保留阅读进度。
4. 取消编辑时不落盘，直接回到阅读模式。

## 非目标

- 不改图片、链接、表格、脚注等结构，不做富文本工具条。
- 不增删章节、不改目录、不改元数据和封面。
- 不做 Markdown/源码编辑，不做撤销历史。
- 不做网页版和移动端。

## 设计决策

### 1. 编辑入口

- 在阅读页操作区新增“编辑”按钮（使用 lucide 图标并带 tooltip），只在 `book.format === 'EPUB'` 且桌面端（`isTauriAppPlatform`）显示。
- 按钮样式和位置跟随现有阅读页按钮清单，不引入新的视觉体系。

### 2. 编辑视图（EditorView）

- 点击编辑后，阅读器进入编辑状态：隐藏分页翻页交互和手势，显示独立编辑视图。
- 编辑视图使用 `foliate-js` 的 `Section.createDocument()` 加载当前章节原始 XHTML，放入连续滚动的 iframe，不接分页器。
- 开启 `contenteditable`，只允许文本编辑。通过输入事件过滤、粘贴过滤和保存前结构净化，保证图片、链接、脚注等标签结构不被改动；仅允许文本内容和段落级增删变化。
- 编辑视图尽量复用阅读主题的字体、字号和背景；第一版允许与阅读页视觉存在合理差异。
- 编辑状态顶部或底部提供“保存 / 取消”。未保存时切章节、关闭编辑或离开阅读页，先弹确认提示。

### 3. 保存与重打包（epubWriter）

- 保存时序列化编辑视图的 `body`，连同原 `head` 样式生成新章节 XHTML。
- 用项目已有的 `@zip.js/zip.js` `ZipWriter` 重建整个 EPUB：`mimetype` 保持第一项且不压缩，其余条目复制原字节，只替换当前章节条目。
- 输出 `Blob`/`ArrayBuffer`，交给保存流程。

### 4. 覆盖与进度迁移（saveEditedEpub）

- 定位当前书在 `Books` 目录的文件（复用 `getLocalBookFilename`）。
- 写盘前先把原文件备份到临时位置；覆盖失败时用备份恢复。
- 写入新 EPUB 后重算 `partialMD5`。
- 正文改动不影响 OPF 元数据，因此 `metaHash` 不变。复用 `importBook` 已有的“同书换文件”迁移逻辑：更新 `book.hash`，把旧配置（进度、封面等）迁移到新 hash 目录，更新 `config.bookHash` / `config.metaHash`，清理旧目录，更新书库记录。
- 保存成功后重新打开这本书，回到原章节。位置优先使用迁移后的 `location`（CFI）；解析失败时用 `progress` 页码比例兜底。
- 全部写入、迁移都成功后才算保存完成；任一环节失败都回滚备份并保留编辑状态报错。

### 5. 错误处理

- 书文件不存在或已被外部改动：不覆盖，报错并留在编辑状态。
- 重打包、hash 计算、写盘、目录迁移任一失败：用临时备份恢复原文件，报错并保留编辑内容。
- 非 EPUB 或非桌面端：编辑入口不显示。
- 保存前发现章节结构被破坏（例如非文本结构变化无法净化）：拒绝保存并提示仅支持文字编辑。

## 文件改动清单

新增：
- `apps/readest-app/src/app/reader/editor/EditorView.tsx`
- `apps/readest-app/src/app/reader/editor/epubWriter.ts`
- `apps/readest-app/src/app/reader/editor/saveEditedEpub.ts`
- `apps/readest-app/src/app/reader/editor/useEditorState.ts`
- `apps/readest-app/src/__tests__/editor/epubWriter.test.ts`
- `apps/readest-app/src/__tests__/editor/saveEditedEpub.test.ts`
- `apps/readest-app/src/__tests__/editor/EditorView.browser.test.tsx`
- 本文档

修改：
- `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`：接入编辑入口和编辑视图
- `apps/readest-app/src/services/bookService.ts` 或 `libraryStore.ts`：暴露“编辑保存”专用入口，复用现有 config 迁移逻辑
- `apps/readest-app/public/locales/zh-CN/translation.json`、`apps/readest-app/public/locales/en/translation.json`：编辑、保存、取消、未保存提示文案

## 验证

自动化测试：

- `epubWriter`：重打包后 `mimetype` 是第一项且未压缩；未编辑条目字节一致；编辑章节被替换；产物能被 `foliate-js` 重新解析。
- `saveEditedEpub`：覆盖后文件 hash 更新；配置迁移到新 hash 目录；失败时回滚备份；保存成功回到原章节。
- `EditorView`：可输入文字；图片、链接等结构不可编辑；取消不落盘。

手动验证：

1. 桌面端导入一本真实 EPUB，编辑某章节正文并保存。
2. 重新打开这本书，确认正文改动生效、排版正常、进度保留。
3. 编辑后不保存直接取消，确认文件未变化。
4. 编辑期间强制关书或切章节，确认有未保存提示。

## 风险

- `contenteditable` 在 Windows WebView2、macOS WKWebView、Linux WebKitGTK 上的行为有差异，保存前结构净化作为兜底。
- 少数章节含脚本、复杂 SVG 或不可编辑控件时，净化可能无法完整保留结构；第一版遇到此类情况拒绝保存并提示。
- 重打包可能改变未编辑条目的压缩参数和时间戳，但内容字节不变；大文件重打包耗时是已知限制，后续可考虑在 Rust 侧做增量替换。
