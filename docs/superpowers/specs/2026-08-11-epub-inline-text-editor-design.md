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

#### 2.1 净化与输入控制

三层防线：进入编辑时的结构锁 → 输入/粘贴过滤 → 保存前净化。目标只有一个：**文本节点和段落级标签可编辑，其余结构（图片、链接、表格、脚注等）原样保留**。

**结构锁（进入编辑时一次性打标）**

- 只读保护元素（图片、链接、脚注标记、表格、音视频、SVG、`script`、`object` 等）统一挂 `contenteditable="false"`，并拦截其上的 `mousedown`/`click`，阻止被选中、删除或内部编辑。
- 第一版不做富文本工具条，不做选区样式操作；选中文本的复制/查找仍可用。

**输入/粘贴过滤（编辑过程中）**

- 监听 `beforeinput`/`input`：插入内容只允许为纯文本或白名单标签；检测到白名单外标签（如粘贴来的 `iframe`、`style`）立即回退到纯文本插入。
- 拦截 `paste`：优先解析剪贴板 HTML，走保存前同款净化后插入；剪贴板无 HTML 时按纯文本插入。
- 跨段 Backspace / 删除允许发生，结果交由保存前净化校验（合并到上一段末尾属正常文本编辑）。
- Enter 键默认在光标处插入段落分隔，不触发生成新元素类型。

**保存前净化（最终防线，算法固定）**

1. 遍历编辑视图 `body`，按白名单重建树：
   - 白名单标签：`p` `div` `h1`-`h6` `blockquote` `pre` `br`（文本/段落层），`ul` `ol` `li`（列表），`a` `span` `sup` `sub` `strong` `em` `i` `b` `code`（行内），`img` `figure` `figcaption` `table` `thead` `tbody` `tfoot` `tr` `td` `th` `video` `audio` `source` `svg`（只读结构层）。
   - 白名单外标签：删除标签、保留其文本内容（`iframe`/`object`/`script` 直接整体删除，不留文本）。
   - 白名单内标签的所有 `on*` 事件属性和未知属性一律删除。
2. 属性白名单（只读结构标签按此保留属性，其余属性删除）：
   - `img`：`src` `alt` `width` `height`
   - `a`：`href` `id` `type`（脚注回跳依赖）
   - `span`/`sup`：`id` `class` `data-*`（脚注标记、样式锚点）
   - `td`/`th`：`colspan` `rowspan`
   - `source`：`src` `type`
   - `svg` 内部属性原样保留（净化不深入 SVG 子树，仅保留元素本身）
3. 结构完整性校验：只读结构标签的**存在性、相对顺序、关键属性**必须与净化前完全一致（净化前后做一次签名对比）。一旦检测到只读结构被增删或改属性 → **拒绝保存**，提示“仅支持文字编辑”，保留编辑状态。
4. 文本规范化：合并相邻文本节点、删除空段落、剥离编辑器生成的 `span`/`div` 包裹层。
5. 产物 = 净化后 `body` 序列化 + 原 `head`（原样保留）。

**关于 iframe 相对路径**：`createDocument()` 输出原始 XHTML，正文内相对路径（`src="images/foo.jpg"`）在独立 iframe 中会失效。编辑视图 iframe 需设置 `<base>` 指向章节所在目录（用 `section.href` 推导），或对展示用的 `src`/`href` 做一次相对→blob URL 的临时映射；序列化回新章节时写回原始相对路径。

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

## 实现偏差（2026-08-12）

实现沿计划 `docs/superpowers/plans/2026-08-11-epub-inline-text-editor.md` 落地，六项任务均已完成并提交（`readest-local` 分支，起点 `dcc8273`：`ffa1143` epubWriter、`2e133dc` sectionSerializer、`a3952ab` saveEditedEpub、`639fb66` EditorView、`48390ac` 阅读页集成）。以下为与本文档的差异，均为实现取舍或既有环境限制：

1. **保存不做「备份-恢复」，改为「新目录写入 + 成功后删旧目录」**。本文档 §4 说写盘前备份原文件、失败恢复；实现改为先把新 EPUB 写入 `Books/<newHash>/`，封面/导航/配置迁移、library 更新全部成功后才删旧目录。旧文件从不在写盘窗口期处于半写状态，失败只需清理半成品新目录并 rethrow（`saveEditedEpub.ts`）。语义上更安全，且不依赖临时备份文件。

2. **净化算法由「白名单重建树」简化为「受保护元素签名序列比对」**。本文档 §2.1 描述的按白名单重建树未实现；`sectionSerializer.ts` 改为：`P`/`DIV`/`BR` 之外的所有元素（含 `A`/`IMG`/`SPAN`/`SUP`/`H1-H6`/`LI` 等）的「标签+属性+文档相对顺序」序列必须与原文完全一致，否则抛 `Only text edits are supported`。不重建树、不设属性白名单，而是要求受保护结构整体不变——比白名单更严格（顺序也校验）也更简单。通过校验后直接序列化编辑后文档。

3. **编辑视图相对路径未做 `<base>`/blob 映射**。本文档 §2.2 提到的 iframe 相对路径失效问题未处理：`EditorView` 用 `srcdoc` 渲染原章节，图片等相对资源在编辑视图中可能不显示。但图片 `src` 等受保护属性原样保留，保存后落盘章节保持原始相对路径，最终 EPUB 不受影响。属已知视觉限制。

4. **未保存离开的确认只覆盖编辑视图内的「取消」按钮**。本文档 §2 要求切章节/关闭编辑/离开阅读页都弹确认；实现只在 `EditorView` 的取消按钮用 `window.confirm` 拦截（`Unsaved changes will be lost`）。编辑态下阅读页 HeaderBar 被编辑视图覆盖，切章节入口不可达，故实际路径较窄；v1 未加 `beforeunload`/关书拦截。

5. **编辑视图显示原始（未转换）文本**。阅读器对章节应用 simplecc/标点等展示层转换，编辑器直接加载并编辑原始 XHTML，故简体转换开启时编辑器显示的是原文本（如繁体）。保存后展示层转换仍会在重开时生效，编辑内容落盘在原始文本上，行为自洽，仅是编辑器内视觉与阅读页不一致。

6. **vitest-browser 在本机（Windows）的 `vi.mock` 模块 mock 不生效**，导致既有浏览器测试（如 `dropdown-viewport`、`tts-auto-advance`）报 `useEnv must be used within EnvProvider` 而失败——这是既有环境问题（stash 掉本分支改动后复测同样失败），非本次改动引入。新增的 `EditorView.browser.test.tsx` 通过（其断言依赖的真实 hook 的 `defaultValue` fallback 与 mock 行为一致，故不受影响）。全量浏览器套件需在可正常 mock 的环境跑。

7. **en 翻译文件仅 111 键**（多数英文文案走 key fallback），本次按计划只追加 3 个新 key（`Edit Book Content` / `Only text edits are supported` / `Unsaved changes will be lost`）。
