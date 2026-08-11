# 导入/阅读阶段简体中文自动转换设计

日期：2026-08-11
范围：`apps/readest-app`（React 19 / Next.js / Tauri / foliate-js）

## 目标

1. 导入繁体中文书籍时，自动把书名和作者名转换为简体，并作为书库展示、编辑和本地文件命名使用的值。
2. 阅读繁体中文书籍时，正文内容默认自动转换为简体；简体书籍不受影响。
3. 转换全部本地完成，复用仓库已有的 `simplecc-wasm`（OpenCC 词典），不新增第三方依赖。

## 非目标

- 不修改原书文件，导入阶段只影响书库元数据，阅读阶段只影响显示。
- 不实现繁体检测：`t2s` 对简体文本基本幂等，直接作为默认模式即可覆盖“繁体书自动转、简体书不变”。
- 不扩展 PDF、FB2 正文转换。PDF 走独立 PDF.js 渲染管线，FB2 没有 `transformTarget` 数据事件，当前均不经过 HTML 转换器；只转换目录标题。
- 不做 OCR、不做在线转换服务接入。

## 设计决策

### 1. 转换工具：复用 `simplecc-wasm`

- 项目已内置 `packages/simplecc-wasm`，词典来自 OpenCC 1.1.9，支持 `t2s`（繁体转简体）。
- 新增 helper 放在 `apps/readest-app/src/utils/simplecc.ts`：

```ts
const simplifyChineseText = async (text: string): Promise<string> => {
  if (!text) return text;
  await initSimpleCC();
  const simplified = runSimpleCC(text, 't2s');
  return simplified === text ? text : simplified;
};
```

- `runSimpleCC` 已在 [utils/simplecc.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/utils/simplecc.ts:25) 提供，`initSimpleCC` 负责加载本地 WASM。
- 转换失败（WASM 加载异常、空值等）时回退原文，不阻断导入。

### 2. 导入阶段：书名与作者落库为简体

修改 `apps/readest-app/src/services/bookService.ts` 的 `importBook`：

1. 保持现有解析与 `metaHash` 计算顺序不变：`getMetadataHash` 必须使用转换前的原始标题，避免同一本繁体书因标题变化在重复导入时被当作新书。
2. 在 `metaHash` 计算之后、创建 `book` 对象之前，对以下字段执行 `simplifyChineseText`：
   - `loadedBook.metadata.title`（字符串）
   - `loadedBook.metadata.author`（经 `formatAuthors` 归一化后写回字符串，保持 `BookDetailEdit` 等编辑界面显示简体）
   - `book.title` / `book.sourceTitle` / `book.author` 全部使用转换后的值
3. `sourceTitle` 会进入 `getLocalBookFilename`（[utils/book.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/utils/book.ts:16)），因此新导入书在本地存储、导出文件名也是简体。
4. 读取旧书时，[readerStore.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/store/readerStore.ts:250) 会用 `bookDoc.metadata.title` 重新覆盖 `sourceTitle`，所以必须同步改写 `metadata.title`，否则打开书后文件名会回到繁体。

### 3. 阅读阶段：默认开启繁体转简体

1. 把 [constants.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/services/constants.ts:340) 的 `DEFAULT_BOOK_LANGUAGE.convertChineseVariant` 从 `'none'` 改为 `'t2s'`。
2. 该默认值通过 `globalViewSettings` 合并进每本书的 `viewSettings`，现有 `simplecc` transformer、目录转换、注释反查、标点联动全部自动一致，无需改动 [transformers/simplecc.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/services/transformers/simplecc.ts:8)。
3. 把 [readerStore.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/store/readerStore.ts:244) 中 TOC 场景的 `?? 'none'` fallback 同步改为 `?? 't2s'`。
4. 用户仍可在设置中把单本书或全局改回“不转换”或其他模式，行为优先级不变。

### 4. 旧设置迁移

- 旧版 `settings.json` 的 `globalViewSettings` 通常已把 `convertChineseVariant: 'none'` 持久化，会覆盖新默认值，因此需要一次迁移：
  1. 把 [constants.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/services/constants.ts:523) 的 `SYSTEM_SETTINGS_VERSION` 从 `1` 升到 `2`。
  2. 在 [settingsService.ts](C:/Users/REDACTED_USER/Documents/阅读器/apps/readest-app/src/services/settingsService.ts:155) 的加载合并逻辑中，当旧版本号小于 `2` 且持久化的 `globalViewSettings.convertChineseVariant === 'none'` 时，改为 `'t2s'`。
- 取舍：无法区分“默认 none”和“用户手动设为 none”，迁移会把手动关闭的旧书也改为自动转换；用户可在迁移后手动改回。

## 文件改动清单

新增：

- `docs/superpowers/specs/2026-08-11-simplify-chinese-on-import-and-read-design.md`
- `apps/readest-app/src/__tests__/utils/simplecc-title.test.ts`（helper 单测）

修改：

- `apps/readest-app/src/utils/simplecc.ts`：新增 `simplifyChineseText`
- `apps/readest-app/src/services/bookService.ts`：导入时转换标题/作者
- `apps/readest-app/src/services/constants.ts`：默认 `t2s` + `SYSTEM_SETTINGS_VERSION` 升版
- `apps/readest-app/src/services/settingsService.ts`：旧设置迁移
- `apps/readest-app/src/store/readerStore.ts`：TOC fallback 同步
- `apps/readest-app/src/__tests__/services/constants.test.ts`：更新默认值断言（若现有断言覆盖 `convertChineseVariant`）

## 验证

自动化测试：

- helper：繁体书名/作者转简体；简体文本不变；英文文本不变；空值返回原文；WASM 初始化失败时回退原文。
- 迁移：`SYSTEM_SETTINGS_VERSION < 2` 且值为 `none` 时迁移为 `t2s`；已是 `t2s` 或其他模式时不变；版本已是最新时不迁移。
- 若现有导入测试断言元数据，补充一条“繁体 EPUB 导入后 `book.title` / `sourceTitle` / `author` / `metadata.title` 为简体、`metaHash` 与原始元数据一致”的断言。

手动验证：

1. 导入繁体书名的 EPUB/TXT，确认书库列表、详情编辑、导出文件名均为简体。
2. 打开繁体书，正文自动显示简体；目录、标点同步；关闭“繁体 → 简体”后恢复繁体显示。
3. 打开简体书，内容不变。
4. 升级前已有书：确认首次启动后自动转换生效，且可在设置中关闭。

## 风险

- 旧设置迁移会覆盖部分用户手动设置的“不转换”，影响范围是已有书默认行为，可通过设置改回。
- `t2s` 对生僻字、人名地名、台湾/香港惯用词可能不完整，用户可改用 `tw2s` / `hk2s` / `tw2sp` 模式。
- PDF、FB2 正文不转换属于当前架构限制，不做为本次范围。
