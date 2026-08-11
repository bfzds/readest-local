# PixivBatchDownloader 小说文件名解析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Readest Local 导入 PixivBatchDownloader 下载的小说时，书库自动显示原始 Pixiv 小说标题和作者名，而不是带日期、ID、序号等附加元素的文件名。

**Architecture:** 新增一个独立的 Pixiv 命名解析模块（纯函数），同时支持两条可靠来源：TXT 文件头部的下载器元数据块（最准确）和下载器命名规则生成的文件名/目录结构（覆盖元数据被关闭的场景）。解析结果接入 TXT→EPUB 转换、EPUB 导入回退、打开书籍回退三个入口，解析失败时保持现有行为，不误伤普通书籍。

**Tech Stack:** TypeScript、Vitest、Readest Local（Next.js + Tauri）现有 `apps/readest-app` 导入链路；不引入新依赖。

## Global Constraints

- 目标代码仅限 `apps/readest-app/src`；不修改 `apps/readest-app/src/types/book.ts`（工作区存在用户未提交改动）。
- 解析器必须保守：没有 Pixiv 特征时返回 `null`，由调用方走原有 fallback；不得把普通书名误当作 Pixiv 元数据。
- 下载器会把 `\ / : ? " < > * | ~` 替换为全角字符（`／ ： ？ ＂ ＜ ＞ ＊ ｜ ～`），解析时不要尝试“还原”这些字符，标题保持文件中的原样。
- Pixiv 作品 ID、用户 ID 均为 7-10 位数字；只有这种数字段才可作为 ID 锚点。
- 不引入新依赖，不新增后端/Rust 代码，不改 UI 文案。
- 测试命令（在本仓库根目录执行）：`pnpm --filter readest-local test -- --run <测试文件路径>`；Vitest 使用 `@/` 路径别名。
- 每次任务提交一次；提交信息格式：`feat(reader): ...`。

## 调研结论（背景）

PixivBatchDownloader 源码事实（已核对 `xuejianxianzun/PixivBatchDownloader`）：

- 单篇小说默认命名规则 `{follow_artwork}`，展开为图像作品默认规则 `pixiv/{user}-{user_id}/{id}-{title}`，所以默认文件形如：
  `pixiv/作者名-12345678/23456789-小说标题.txt` 或 `.epub`。
- 用户可自定义规则，常用标记包括 `{date}`、`{upload_date}`、`{task_date}`、`{user_id}`、`{id}`、`{title}`、`{user}`、`{tags}`、`{char_count}`、`{bmk}`、`{view}`、`{like}`、`{series_title}`、`{series_order}`（`#N`）、`{series_id}`；合并系列默认规则为 `novel series/{page_tag}/{series_title}-{series_id}-{user}-{part}-{tags}.{ext}`，其中 `{part}` 为空或 `01`、`02` 等两位数字。
- 小说 `{p}` 恒为空字符串；`{id}` 对小说等于小说 ID。
- 设置 `saveNovelMeta` 默认开启：单篇 TXT 开头写入
  `标题\n\n作者名\n\nhttps://www.pixiv.net/novel/show.php?id=12345678\n\n日期\n\n#tag\n\n简介\n\n----- 下面是正文 -----`；
  合并系列 TXT 开头写入 `系列标题\n\n作者: 作者名\n\nhttps://www.pixiv.net/novel/series/34567890\n\n更新日期: ...`。
- 下载器生成的单篇 EPUB 内部 OPF 已含正确 `<dc:title>` / `<dc:creator>`，问题集中在 TXT 下载和 EPUB 缺元数据/以文件名回退的场景。

Readest Local 现状：

- `bookService.ts:427-430` 对 `.txt` 调用 `TxtToEpubConverter.convert({ file })`，转换器只按 `《》` 或 `作者：X` 的通用规则解析文件名（`utils/txt.ts:18-36`），不识别 Pixiv 命名。
- `bookService.ts:478-481` 对 EPUB 等格式在 metadata title 为空或等于完整文件名时，直接回退到 `getBaseFilename(filename)`。
- `readerStore.ts:245-247` 打开书籍时也有同样的文件名回退。
- 书库 UI（`BookCover`、`BookItem`、`BookDetailView`）直接展示 `book.title` / `book.author`，因此修正导入时的 metadata 即可正确展示。

## File Structure

- Create: `apps/readest-app/src/utils/pixivNovel.ts` — Pixiv 文件名/内容头部元数据解析器（纯函数）。
- Create: `apps/readest-app/src/__tests__/utils/pixiv-novel-filename.test.ts` — 解析器单元测试。
- Modify: `apps/readest-app/src/utils/txt.ts` — 接入文件名解析和内容头部解析。
- Modify: `apps/readest-app/src/__tests__/utils/txt-converter.test.ts` — 增加 Pixiv 文件名/头部用例。
- Modify: `apps/readest-app/src/services/bookService.ts` — 把原始路径传入 TXT 转换；EPUB 缺元数据时用 Pixiv 解析回退。
- Modify: `apps/readest-app/src/store/readerStore.ts` — 打开书籍的文件名回退前先尝试 Pixiv 解析。
- Modify: `apps/readest-app/src/__tests__/services/import-metahash.test.ts` — 增加 EPUB 导入回退集成用例。

---

### Task 1: Pixiv 解析器（纯函数）

**Files:**
- Create: `apps/readest-app/src/utils/pixivNovel.ts`
- Test: `apps/readest-app/src/__tests__/utils/pixiv-novel-filename.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `interface PixivNovelMetadata { title: string; author?: string; novelId?: string; seriesId?: string }`
  - `parsePixivNovelMetaHeader(text: string): PixivNovelMetadata | null`
  - `parsePixivNovelFilename(filenameOrPath: string): PixivNovelMetadata | null`

- [ ] **Step 1: 写失败测试**

创建 `apps/readest-app/src/__tests__/utils/pixiv-novel-filename.test.ts`：

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePixivNovelFilename, parsePixivNovelMetaHeader } from '@/utils/pixivNovel';

describe('parsePixivNovelFilename', () => {
  it('parses the default pixiv/{user}-{user_id}/{id}-{title} layout', () => {
    expect(parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses the layout without the pixiv/ prefix', () => {
    expect(parsePixivNovelFilename('作者A-12345678/23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('strips trailing date, sequence and bracket decorations', () => {
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题-2024-01-01.txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题-p1.txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题 (12345678).txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题【AI】.txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
  });

  it('parses the merged-series default layout', () => {
    expect(
      parsePixivNovelFilename('novel series/作者A/系列标题-34567890-作者A-01-标签1,标签2.txt'),
    ).toEqual({ title: '系列标题', author: '作者A', seriesId: '34567890' });
    expect(
      parsePixivNovelFilename('novel series/系列标题-34567890-作者A--标签1,标签2.txt'),
    ).toEqual({ title: '系列标题', author: '作者A', seriesId: '34567890' });
  });

  it('parses custom {user}-{user_id}-{id}-{title} names', () => {
    expect(parsePixivNovelFilename('作者A-12345678-23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses custom {date}-{user_id}-{id}-{title} names without an author', () => {
    expect(parsePixivNovelFilename('2024-01-01-12345678-23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      novelId: '23456789',
    });
  });

  it('leaves ordinary filenames untouched', () => {
    expect(parsePixivNovelFilename('普通小说.txt')).toBeNull();
    expect(parsePixivNovelFilename('《三体》.txt')).toBeNull();
    expect(parsePixivNovelFilename('小说标题-2024-01-01.txt')).toBeNull();
    expect(parsePixivNovelFilename('')).toBeNull();
  });
});

describe('parsePixivNovelMetaHeader', () => {
  it('parses the single-novel TXT header written by the downloader', () => {
    const content = [
      '小说标题',
      '',
      '作者A',
      '',
      'https://www.pixiv.net/novel/show.php?id=23456789',
      '',
      '2024-01-01',
      '',
      '#tag1',
      '',
      '简介',
      '',
      '----- 下面是正文 -----',
      '',
      '正文内容',
    ].join('\n');
    expect(parsePixivNovelMetaHeader(content)).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses the merged-series TXT header written by the downloader', () => {
    const content = [
      '系列标题',
      '',
      '作者: 作者A',
      '',
      'https://www.pixiv.net/novel/series/34567890',
      '',
      '更新日期: 2024-01-01',
      '',
      '正文内容',
    ].join('\n');
    expect(parsePixivNovelMetaHeader(content)).toEqual({
      title: '系列标题',
      author: '作者A',
      seriesId: '34567890',
    });
  });

  it('returns null when no pixiv URL is present', () => {
    expect(parsePixivNovelMetaHeader('标题\n\n作者A\n\n普通内容')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/utils/pixiv-novel-filename.test.ts
```
Expected: FAIL，`@/utils/pixivNovel` 模块不存在。

- [ ] **Step 3: 实现解析器**

创建 `apps/readest-app/src/utils/pixivNovel.ts`：

```ts
export interface PixivNovelMetadata {
  title: string;
  author?: string;
  novelId?: string;
  seriesId?: string;
}

const PIXIV_SHOW_URL_RE = /https:\/\/www\.pixiv\.net\/novel\/show\.php\?id=(\d+)/;
const PIXIV_SERIES_URL_RE = /https:\/\/www\.pixiv\.net\/novel\/series\/(\d+)/;
const PIXIV_ID_RE = /^\d{7,10}$/;
const DATE_TOKEN_RE =
  /(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/;
const TRAILING_TOKEN_RE = /(?:[-_ ](?:p\d+|第\d+[话話]|part\d+|#\d+|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{7,10}|\d+字|\d+收藏|AI|R-?18G?|r18g?|小说|novel))+$/i;
const KNOWN_BRACKET_RE =
  /^(?:\d{7,10}|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|AI|R-?18G?|r18g?|小说|novel)$/i;

const isReasonableName = (name: string): boolean =>
  name.length > 0 && name.length <= 200 && !name.includes('https://');

const cleanTitle = (title: string): string => {
  let result = title.trim();
  result = result.replace(
    /\s*(?:\(|（|\[|【)([^)）\]】]+)(?:\)|）|\]|】)\s*$/g,
    (all, inner: string) => (KNOWN_BRACKET_RE.test(inner.trim()) ? '' : all),
  );
  result = result.replace(TRAILING_TOKEN_RE, '');
  result = result.replace(/^[-_ ]+|[-_ ]+$/g, '').trim();
  return result && result !== title.trim() ? result : title.trim();
};

export const parsePixivNovelMetaHeader = (text: string): PixivNovelMetadata | null => {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  const showIndex = lines.findIndex((line) => PIXIV_SHOW_URL_RE.test(line));
  if (showIndex >= 2) {
    const title = lines[showIndex - 2];
    const author = lines[showIndex - 1];
    if (isReasonableName(title) && isReasonableName(author)) {
      return {
        title,
        author,
        novelId: lines[showIndex]!.match(PIXIV_SHOW_URL_RE)![1]!,
      };
    }
  }

  const seriesIndex = lines.findIndex((line) => PIXIV_SERIES_URL_RE.test(line));
  if (seriesIndex >= 2) {
    const title = lines[seriesIndex - 2];
    const author = lines[seriesIndex - 1]!.replace(/^作者\s*[:：]\s*/i, '');
    if (isReasonableName(title) && isReasonableName(author)) {
      return {
        title,
        author,
        seriesId: lines[seriesIndex]!.match(PIXIV_SERIES_URL_RE)![1]!,
      };
    }
  }

  return null;
};

const parseDefaultLayout = (path: string): PixivNovelMetadata | null => {
  // pixiv/<user>-<user_id>/<id>-<title>.<ext>
  const match = path.match(
    /(?:^|\/)([^/]+)-(\d{7,10})\/(\d{7,10})-(.+)\.(?:txt|epub)$/i,
  );
  if (!match) return null;
  const [, user, , novelId, titleRaw] = match;
  const title = cleanTitle(titleRaw);
  if (!title || !isReasonableName(title)) return null;
  return { title, author: user, novelId };
};

const parseSeriesLayout = (path: string, base: string): PixivNovelMetadata | null => {
  if (!/novel series\//i.test(path)) return null;
  const parts = base.split('-');
  const idIndex = parts.findIndex((part) => PIXIV_ID_RE.test(part));
  if (idIndex <= 0 || idIndex >= parts.length - 1) return null;
  const seriesTitle = parts.slice(0, idIndex).join('-');
  const author = parts[idIndex + 1];
  if (!isReasonableName(seriesTitle) || !isReasonableName(author)) return null;
  return { title: seriesTitle, author, seriesId: parts[idIndex] };
};

const parseTwoIdLayout = (base: string): PixivNovelMetadata | null => {
  let candidate = base;
  const datePrefix = candidate.match(
    /^(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}[-_ ]+/,
  );
  if (datePrefix) candidate = candidate.slice(datePrefix[0].length);

  // {user}-{user_id}-{id}-{title}
  const match = candidate.match(/^(.+)-(\d{7,10})-(\d{7,10})-(.+)$/);
  if (!match) return null;
  const [, user, , novelId, titleRaw] = match;
  const title = cleanTitle(titleRaw);
  if (!title || !isReasonableName(title)) return null;
  return {
    title,
    author: isReasonableName(user) ? user : undefined,
    novelId,
  };
};

const looksLikePixivPath = (path: string, base: string): boolean =>
  /pixiv\/|novel series\//i.test(path) ||
  /^\d{7,10}-/.test(base) ||
  /\/[^/]*-?\d{7,10}\//.test(path);

export const parsePixivNovelFilename = (
  filenameOrPath: string,
): PixivNovelMetadata | null => {
  if (!filenameOrPath) return null;
  const normalized = filenameOrPath.replace(/\\/g, '/');
  const base = (normalized.split('/').pop() ?? '').replace(
    /\.(?:txt|epub)$/i,
    '',
  );
  if (!base || !looksLikePixivPath(normalized, base)) return null;

  const defaultLayout = parseDefaultLayout(normalized);
  if (defaultLayout) return defaultLayout;

  const seriesLayout = parseSeriesLayout(normalized, base);
  if (seriesLayout) return seriesLayout;

  const twoIdLayout = parseTwoIdLayout(base);
  if (twoIdLayout) return twoIdLayout;

  return null;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/utils/pixiv-novel-filename.test.ts
```
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```powershell
git add apps/readest-app/src/utils/pixivNovel.ts apps/readest-app/src/__tests__/utils/pixiv-novel-filename.test.ts
git commit -m "feat(reader): parse PixivBatchDownloader novel filenames"
```

---

### Task 2: 接入 TXT→EPUB 转换

**Files:**
- Modify: `apps/readest-app/src/utils/txt.ts:18-36`（`extractTxtFilenameMetadata`）和 `:124-214`（两个 convert 入口）
- Test: `apps/readest-app/src/__tests__/utils/txt-converter.test.ts:429-516`（追加 describe 块）

**Interfaces:**
- Consumes: `parsePixivNovelFilename(filenameOrPath)`、`parsePixivNovelMetaHeader(text)`（Task 1）。
- Produces:
  - `extractTxtFilenameMetadata(filename: string, sourcePath?: string): { title: string; author?: string }`（保持现有签名兼容，第二参可选）。
  - `Txt2EpubOptions` 增加 `sourcePath?: string`。

- [ ] **Step 1: 写失败测试**

在 `apps/readest-app/src/__tests__/utils/txt-converter.test.ts` 的 `extractTxtFilenameMetadata` describe 块末尾追加：

```ts
describe('PixivBatchDownloader names', () => {
  it('extracts title and author from the default layout', () => {
    expect(
      extractTxtFilenameMetadata('pixiv/作者A-12345678/23456789-小说标题.txt'),
    ).toEqual({ title: '小说标题', author: '作者A' });
  });

  it('extracts title and author from the default layout with sourcePath', () => {
    expect(
      extractTxtFilenameMetadata('23456789-小说标题.txt', 'pixiv/作者A-12345678/23456789-小说标题.txt'),
    ).toEqual({ title: '小说标题', author: '作者A' });
  });

  it('prefers the downloader TXT header over the filename', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    let captured: TestMetadata | undefined;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async (_chapters, metadata) => {
      captured = metadata;
      return new Blob();
    };
    const file = new File(
      [
        [
          '小说标题',
          '',
          '作者A',
          '',
          'https://www.pixiv.net/novel/show.php?id=23456789',
          '',
          '----- 下面是正文 -----',
          '',
          '正文',
        ].join('\n'),
      ],
      'pixiv/作者A-12345678/23456789-装饰文件名.txt',
    );
    await converter.convert({ file });
    expect(captured).toMatchObject({ bookTitle: '小说标题', author: '作者A' });
  });
});
```

说明：`TxtConverterFlowPrivateAPI` 与 `TestMetadata` 在该测试文件顶部已有定义（`convertAndCaptureMetadata` 一带），新增用例直接复用。

- [ ] **Step 2: 运行测试确认失败**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/utils/txt-converter.test.ts
```
Expected: FAIL，新增用例得到不干净标题/空作者。

- [ ] **Step 3: 实现修改**

修改 `apps/readest-app/src/utils/txt.ts`：

1. 文件头部新增导入：

```ts
import { parsePixivNovelFilename, parsePixivNovelMetaHeader } from './pixivNovel';
```

2. `Txt2EpubOptions` 增加字段：

```ts
interface Txt2EpubOptions {
  file: File;
  author?: string;
  language?: string;
  /** 原始导入路径（可能含 Pixiv 目录结构）；缺省时用 file.name */
  sourcePath?: string;
}
```

3. `extractTxtFilenameMetadata` 增加可选第二参数，并在通用规则之前尝试 Pixiv 解析：

```ts
export const extractTxtFilenameMetadata = (
  filename: string,
  sourcePath?: string,
): { title: string; author?: string } => {
  const base = getBaseFilename(filename);
  const pixivMeta = parsePixivNovelFilename(sourcePath || filename);
  if (pixivMeta) {
    return {
      title: pixivMeta.title,
      ...(pixivMeta.author ? { author: pixivMeta.author } : {}),
    };
  }
  const cjkMatch = base.match(/《([^《》]+)》\s*(.*)/);
  // ...原有逻辑保持不变
};
```

4. `convertSmallFile` 在 `filenameMeta` 之前优先解析内容头部：

```ts
const sourcePath = options.sourcePath || txtFile.name;
const filenameMeta = extractTxtFilenameMetadata(txtFile.name, sourcePath);
const headerMeta = parsePixivNovelMetaHeader(txtContent);
const bookTitle = headerMeta?.title || filenameMeta.title;
const fileName = `${bookTitle}.epub`;
```

并把 author 解析改为：

```ts
const author = headerMeta?.author || headerAuthor || filenameMeta.author || providedAuthor || '';
```

5. `convertLargeFile` 做同样处理，`fileHeader` 来自 `readHeaderTextFromFile`（前 1024 字符已足够覆盖头部前几行）：

```ts
const sourcePath = options.sourcePath || txtFile.name;
const filenameMeta = extractTxtFilenameMetadata(txtFile.name, sourcePath);
const headerMeta = parsePixivNovelMetaHeader(fileHeader);
const bookTitle = headerMeta?.title || filenameMeta.title;
const fileName = `${bookTitle}.epub`;
```

`extractAuthorAndLanguage` 的调用改为：

```ts
const { author, language } = this.extractAuthorAndLanguage(
  fileHeader,
  headerMeta?.author || filenameMeta.author ?? providedAuthor,
  providedLanguage,
);
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/utils/txt-converter.test.ts src/__tests__/utils/txt.test.ts src/__tests__/utils/txt-chapter-regex.test.ts
```
Expected: PASS（新增用例通过，原有 TXT 相关用例不回归）。

- [ ] **Step 5: 提交**

```powershell
git add apps/readest-app/src/utils/txt.ts apps/readest-app/src/__tests__/utils/txt-converter.test.ts
git commit -m "feat(reader): apply Pixiv novel metadata during TXT import"
```

---

### Task 3: 接入 EPUB/非 TXT 导入与打开书籍回退

**Files:**
- Modify: `apps/readest-app/src/services/bookService.ts:419-481`
- Modify: `apps/readest-app/src/store/readerStore.ts:245-247`
- Test: `apps/readest-app/src/__tests__/services/import-metahash.test.ts`

**Interfaces:**
- Consumes: `parsePixivNovelFilename(filenameOrPath)`（Task 1）。
- Produces: 无新导出；行为变化为 EPUB 等格式缺 metadata 时自动填入解析出的 title/author。

- [ ] **Step 1: 写失败测试**

在 `apps/readest-app/src/__tests__/services/import-metahash.test.ts` 的 describe 内追加：

```ts
it('restores Pixiv title and author when EPUB metadata falls back to filename', async () => {
  mockPartialMD5.mockResolvedValue('pixiv-hash');
  const fs = service.getFs();
  fs.openFile.mockResolvedValue(new File(['epub'], '23456789-小说标题.txt', { type: 'text/plain' }));
  setupMockBookDoc({
    title: '23456789-小说标题.txt',
    author: '',
    language: 'ja',
    identifier: '',
  });

  const result = await service.importBook(
    'pixiv/作者A-12345678/23456789-小说标题.txt',
    [],
    { transient: true },
  );

  expect(result?.title).toBe('小说标题');
  expect(result?.author).toBe('作者A');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/services/import-metahash.test.ts
```
Expected: FAIL，`result.title` 仍是 `23456789-小说标题`，`author` 为空。

- [ ] **Step 3: 实现修改**

修改 `apps/readest-app/src/services/bookService.ts`：

1. 顶部导入解析器：

```ts
import { parsePixivNovelFilename } from '@/utils/pixivNovel';
```

2. 在 `filename` 计算后记录原始路径（`file` 为 string 时保留目录结构，File 输入用 `file.name`）：

```ts
if (typeof file === 'string') {
  fileobj = await fs.openFile(file, 'None');
  filename = fileobj.name || getFilename(file);
} else {
  fileobj = file;
  filename = file.name;
}
const sourcePath = typeof file === 'string' ? file : file.name;
```

3. TXT 转换传入 `sourcePath`：

```ts
if (/\.txt$/i.test(filename)) {
  const txt2epub = new TxtToEpubConverter();
  ({ file: fileobj } = await txt2epub.convert({ file: fileobj, sourcePath }));
}
```

4. metadata fallback 处先尝试 Pixiv 解析（覆盖 EPUB/PDF/MOBI 等非 TXT 格式）：

```ts
normalizeMetadataIsbn(loadedBook.metadata);
const metadataTitle = formatTitle(loadedBook.metadata.title);
const pixivMeta = parsePixivNovelFilename(sourcePath);
if (!metadataTitle || !metadataTitle.trim() || metadataTitle === filename) {
  loadedBook.metadata.title = pixivMeta?.title || getBaseFilename(filename);
}
if (pixivMeta?.author && !formatAuthors(loadedBook.metadata.author, 'ja')) {
  loadedBook.metadata.author = pixivMeta.author;
}
```

说明：`formatAuthors('')` 返回空串，`!空串` 为 true；`pixivMeta.author` 只在解析命中时存在，普通书籍不受影响。

修改 `apps/readest-app/src/store/readerStore.ts`：

```ts
import { parsePixivNovelFilename } from '@/utils/pixivNovel';
// ...
if (!bookDoc.metadata.title && file) {
  bookDoc.metadata.title =
    parsePixivNovelFilename(file.name)?.title || getBaseFilename(file.name);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```powershell
pnpm --filter readest-local test -- --run src/__tests__/services/import-metahash.test.ts src/__tests__/services/import-bookdoc-destroy.test.ts src/__tests__/services/auto-import-duplicate-files.test.ts
```
Expected: PASS（新增用例通过，importBook 相关回归通过）。

- [ ] **Step 5: 提交**

```powershell
git add apps/readest-app/src/services/bookService.ts apps/readest-app/src/store/readerStore.ts apps/readest-app/src/__tests__/services/import-metahash.test.ts
git commit -m "feat(reader): restore Pixiv metadata on non-TXT import fallback"
```

---

## Self-Review

**Spec coverage:**

1. 智能解析文件名并剥离附加元素 — Task 1 的 `parsePixivNovelFilename`，覆盖默认布局、系列布局、日期/序号/括号装饰、自定义双 ID 布局。
2. 书库显示原始标题与作者 — Task 2/3 在导入入口修正 `book.title` / `book.author`，UI 无需改动（`BookCover`/`BookItem` 直接读这两个字段）。
3. 兼容下载器常见格式 — 调研结论已列出默认与常用标记；解析器只在有 Pixiv 特征时生效，避免误伤普通文件名。
4. 生成计划文档 — 本文档保存于 `docs/superpowers/plans/2026-08-11-pixiv-batch-downloader-novel-metadata.md`。

**Placeholder scan:** 所有任务均含具体测试代码、实现代码、运行命令与提交命令，无 TBD/TODO。

**Type consistency:** `PixivNovelMetadata.title` 为 string；`author?: string`。Task 2 中 `extractTxtFilenameMetadata` 返回 `{ title, author? }`，与现有调用点（`convertSmallFile`/`convertLargeFile`）兼容；`Txt2EpubOptions.sourcePath` 在 Task 2 定义、Task 3 传入，签名一致。`parsePixivNovelFilename` 在 Task 1 定义，Task 2/3 均按相同签名调用。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-08-11-pixiv-batch-downloader-novel-metadata.md`。两种执行方式：

1. Subagent-Driven（推荐）：每个任务派发独立子代理，任务间审查，迭代快。
2. Inline Execution：在当前会话按 executing-plans 批量执行并设置检查点。
