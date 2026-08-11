# EPUB 正文内联编辑实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面版阅读页点击编辑按钮后，以所见即所得方式修改 EPUB 正文文字，保存后重打包覆盖当前书并保留阅读进度。

**Architecture:** 编辑状态放在 `readerStore` 的 `viewState.editing` 上；`HeaderBar` 提供入口，`FoliateViewer` 在编辑态渲染独立 `EditorView`（连续滚动 iframe + contenteditable）。保存时用 `@zip.js/zip.js` 重打包 EPUB，写入 `Books/<newHash>/`，迁移旧 `config.json`（进度）到新 hash 目录，再更新书库记录并以新 hash 重建阅读器。

**Tech Stack:** React 19 / Next.js / Tauri / foliate-js / @zip.js/zip.js / vitest / Biome / pnpm。

## Global Constraints

- 入口只在桌面端（`isTauriAppPlatform()`）且 `book.format === 'EPUB'` 时显示。
- 只允许文字修改（改字、增删句子和段落）；`P`/`DIV`/`BR` 之外的元素结构不可变，否则拒绝保存。
- 保存必须覆盖当前书并迁移旧进度；`metaHash` 不变，`book.hash` 更新为新 `partialMD5`。
- 复用现有 i18n（`useTranslation`），新增文案 key 必须同时写入 `zh-CN/translation.json` 和 `en/translation.json`。
- 单元测试命令：`pnpm --filter readest-local test:pr:web:unit <path>`；浏览器测试：`pnpm --filter readest-local test:browser <path>`；类型和 lint：`pnpm --filter readest-local lint`。

---

### Task 1: epubWriter 重打包模块

**Files:**
- Create: `apps/readest-app/src/app/reader/editor/epubWriter.ts`
- Test: `apps/readest-app/src/__tests__/editor/epubWriter.test.ts`

**Interfaces:**
- Consumes: `@zip.js/zip.js`（项目已有依赖）
- Produces:
  - `export interface ZipEntryData { name: string; data: Uint8Array }`
  - `export async function readZipEntries(file: Blob): Promise<ZipEntryData[]>`
  - `export async function rewriteEpub(entries: ZipEntryData[], targetName: string, newData: Uint8Array): Promise<Blob>`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/editor/epubWriter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';

import { readZipEntries, rewriteEpub } from '@/app/reader/editor/epubWriter';

const MIMETYPE = 'application/epub+zip';
const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Editor Test</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:12345</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`;
const chapter = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>${text}</p></body></html>`;

const makeEpub = async (): Promise<Blob> => {
  const zipWriter = new ZipWriter(new BlobWriter(MIMETYPE), { extendedTimestamp: false });
  await zipWriter.add('mimetype', new TextReader(MIMETYPE), { level: 0 });
  await zipWriter.add('META-INF/container.xml', new TextReader(CONTAINER));
  await zipWriter.add('OEBPS/content.opf', new TextReader(OPF));
  await zipWriter.add('OEBPS/chapter1.xhtml', new TextReader(chapter('Chapter 1')));
  await zipWriter.add('OEBPS/chapter2.xhtml', new TextReader(chapter('Chapter 2')));
  return zipWriter.close();
};

describe('epubWriter', () => {
  it('reads every zip entry with raw bytes', async () => {
    const entries = await readZipEntries(await makeEpub());
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/chapter1.xhtml',
      'OEBPS/chapter2.xhtml',
    ]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(MIMETYPE);
  });

  it('keeps mimetype first and replaces only the target chapter', async () => {
    const entries = await readZipEntries(await makeEpub());
    const edited = chapter('Edited chapter 2');
    const blob = await rewriteEpub(
      entries,
      'OEBPS/chapter2.xhtml',
      new TextEncoder().encode(edited),
    );

    const reader = new ZipReader(new BlobReader(blob));
    const out = await reader.getEntries();
    await reader.close();
    expect(out[0]!.filename).toBe('mimetype');
    expect(await out[0]!.getData(new TextWriter())).toBe(MIMETYPE);
    expect(await out[1]!.getData(new TextWriter())).toBe(CONTAINER);
    expect(await out[3]!.getData(new TextWriter())).toBe(chapter('Chapter 1'));
    expect(await out[4]!.getData(new TextWriter())).toBe(edited);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/epubWriter.test.ts`
Expected: FAIL with module `@/app/reader/editor/epubWriter` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/app/reader/editor/epubWriter.ts`:

```ts
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';

export interface ZipEntryData {
  name: string;
  data: Uint8Array;
}

const EPUB_MIME = 'application/epub+zip';
const MIMETYPE_ENTRY = 'mimetype';
// Reuse the timestamp policy already used by TxtToEpubConverter so
// rebuilds are stable across runs where nothing else changed.
const zipWriteOptions = {
  lastAccessDate: new Date(0),
  lastModDate: new Date(0),
};

export async function readZipEntries(file: Blob): Promise<ZipEntryData[]> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const result: ZipEntryData[] = [];
    for (const entry of entries) {
      const data = await entry.getData(new Uint8ArrayWriter());
      result.push({ name: entry.filename, data });
    }
    return result;
  } finally {
    await reader.close();
  }
}

export async function rewriteEpub(
  entries: ZipEntryData[],
  targetName: string,
  newData: Uint8Array,
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter(EPUB_MIME), { extendedTimestamp: false });
  try {
    for (const entry of entries) {
      const data = entry.name === targetName ? newData : entry.data;
      await writer.add(entry.name, new Uint8ArrayReader(data), {
        ...zipWriteOptions,
        // EPUB 3 requires mimetype as the first entry, uncompressed.
        level: entry.name === MIMETYPE_ENTRY ? 0 : 6,
      });
    }
    return await writer.close();
  } catch (error) {
    await writer.abort?.();
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/epubWriter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/app/reader/editor/epubWriter.ts apps/readest-app/src/__tests__/editor/epubWriter.test.ts
git commit -m "feat(editor): add EPUB repack module"
```

---

### Task 2: 章节结构净化 sectionSerializer

**Files:**
- Create: `apps/readest-app/src/app/reader/editor/sectionSerializer.ts`
- Test: `apps/readest-app/src/__tests__/editor/sectionSerializer.test.ts`

**Interfaces:**
- Consumes: 原始章节 XHTML 字符串、编辑后的 XHTML 字符串
- Produces: `export function serializeEditedSection(originalHtml: string, editedHtml: string): string`

规则：只允许文本内容变化以及 `P`/`DIV`/`BR` 元素增删；其他元素（`A`、`IMG`、`SPAN`、`SUP`、`H1-H6`、`LI` 等）的标签与属性集合必须与原文一致，否则抛 `Error('Only text edits are supported')`。

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/editor/sectionSerializer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { serializeEditedSection } from '@/app/reader/editor/sectionSerializer';

const original = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body>
    <p>Hello <a href="note.html#1">note</a> world.</p>
    <p>Second paragraph with <sup class="fn">1</sup>.</p>
    <img src="cover.jpg" alt="cover"/>
  </body>
</html>`;

describe('serializeEditedSection', () => {
  it('accepts text changes and paragraph-level edits', () => {
    const edited = original.replace('Hello', 'Edited text');
    const result = serializeEditedSection(original, edited);
    expect(result).toContain('Edited text');
  });

  it('rejects inserting a protected element such as an image', () => {
    const edited = original.replace('</body>', '<img src="x.jpg"/></body>');
    expect(() => serializeEditedSection(original, edited)).toThrow(
      'Only text edits are supported',
    );
  });

  it('rejects deleting a link structure', () => {
    const edited = original.replace('<a href="note.html#1">note</a>', 'note');
    expect(() => serializeEditedSection(original, edited)).toThrow(
      'Only text edits are supported',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/sectionSerializer.test.ts`
Expected: FAIL with module `@/app/reader/editor/sectionSerializer` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/app/reader/editor/sectionSerializer.ts`:

```ts
// Elements whose presence may change while editing. Everything else must
// keep the exact same tag + attribute signature as the original chapter.
const EDITABLE_BLOCK_LEVEL = new Set(['P', 'DIV', 'BR']);

const elementSignature = (el: Element): string => {
  const attrs = [...el.attributes]
    .map((attr) => `${attr.name}=${attr.value}`)
    .sort()
    .join('|');
  return `${el.tagName}:${attrs}`;
};

const collectProtectedElements = (body: HTMLElement): Element[] =>
  [...body.querySelectorAll('*')].filter((el) => !EDITABLE_BLOCK_LEVEL.has(el.tagName));

const parseXhtml = (html: string): Document => {
  const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XHTML');
  }
  return doc;
};

export const serializeEditedSection = (originalHtml: string, editedHtml: string): string => {
  const original = parseXhtml(originalHtml);
  const edited = parseXhtml(editedHtml);

  const originalSignatures = new Set(
    collectProtectedElements(original.body).map(elementSignature),
  );
  const editedSignatures = new Set(collectProtectedElements(edited.body).map(elementSignature));

  for (const signature of editedSignatures) {
    if (!originalSignatures.has(signature)) {
      throw new Error('Only text edits are supported');
    }
  }
  for (const signature of originalSignatures) {
    if (!editedSignatures.has(signature)) {
      throw new Error('Only text edits are supported');
    }
  }

  return new XMLSerializer().serializeToString(edited);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/sectionSerializer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/app/reader/editor/sectionSerializer.ts apps/readest-app/src/__tests__/editor/sectionSerializer.test.ts
git commit -m "feat(editor): add section structure serializer"
```

---

### Task 3: 保存覆盖与进度迁移 saveEditedEpub

**Files:**
- Create: `apps/readest-app/src/app/reader/editor/saveEditedEpub.ts`
- Test: `apps/readest-app/src/__tests__/editor/saveEditedEpub.test.ts`

**Interfaces:**
- Consumes: `AppService` 公开文件方法（`createDir` / `writeFile` / `readFile` / `copyFile` / `deleteDir` / `isDirectory`）与 `saveLibraryBooks`、`EnvConfigType`、`Book`、新 EPUB `Blob`
- Produces: `export interface SaveEditedEpubResult { book: Book }`；`export async function saveEditedEpub(opts: { appService: AppService; envConfig: EnvConfigType; book: Book; newEpub: Blob }): Promise<SaveEditedEpubResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/editor/saveEditedEpub.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveEditedEpub } from '@/app/reader/editor/saveEditedEpub';
import { Book } from '@/types/book';

const setLibrary = vi.fn();
const saveLibraryBooks = vi.fn(async () => {});
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ library: [bookFixture], setLibrary }),
  },
}));

const bookFixture = {
  hash: 'oldhash',
  metaHash: 'metahash',
  format: 'EPUB',
  title: 'Book',
  sourceTitle: 'Book',
} as unknown as Book;

const makeAppService = () => {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    saveLibraryBooks,
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, _base: string, content: File | string) => {
      files.set(
        path,
        typeof content === 'string' ? content : new Uint8Array(await content.arrayBuffer()),
      );
    }),
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value == null) throw new Error('not found');
      return typeof value === 'string' ? value : new TextDecoder().decode(value);
    }),
    isDirectory: vi.fn(async (path: string) =>
      [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    ),
    copyFile: vi.fn(async (src: string, _srcBase: string, dst: string) => {
      const value = files.get(src);
      if (value) files.set(dst, value);
    }),
    deleteDir: vi.fn(async () => {}),
  };
};

describe('saveEditedEpub', () => {
  let appService: ReturnType<typeof makeAppService>;

  beforeEach(() => {
    appService = makeAppService();
    appService.files.set(
      'oldhash/config.json',
      JSON.stringify({ progress: [3, 100], bookHash: 'oldhash' }),
    );
    vi.clearAllMocks();
  });

  it('writes the new epub, migrates config progress, and updates the library', async () => {
    const result = await saveEditedEpub({
      appService: appService as never,
      envConfig: {} as never,
      book: bookFixture,
      newEpub: new Blob(['epub'], { type: 'application/epub+zip' }),
    });

    expect(result.book.hash).not.toBe('oldhash');
    expect(appService.files.has(`${result.book.hash}/Book.epub`)).toBe(true);
    expect(appService.files.get(`${result.book.hash}/config.json`)).toContain(
      '"progress":[3,100]',
    );
    expect(appService.files.get(`${result.book.hash}/config.json`)).toContain(result.book.hash);
    expect(appService.deleteDir).toHaveBeenCalledWith('oldhash', 'Books', true);
    expect(setLibrary).toHaveBeenCalledTimes(1);
    expect(saveLibraryBooks).toHaveBeenCalledTimes(1);
  });

  it('throws and keeps the old directory when writing fails', async () => {
    appService.writeFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      saveEditedEpub({
        appService: appService as never,
        envConfig: {} as never,
        book: bookFixture,
        newEpub: new Blob(['epub'], { type: 'application/epub+zip' }),
      }),
    ).rejects.toThrow('disk full');

    expect(appService.deleteDir).not.toHaveBeenCalled();
    expect(setLibrary).not.toHaveBeenCalled();
    expect(saveLibraryBooks).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/saveEditedEpub.test.ts`
Expected: FAIL with module `@/app/reader/editor/saveEditedEpub` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/app/reader/editor/saveEditedEpub.ts`:

```ts
import { AppService } from '@/services/appService';
import { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { Book, BookConfig } from '@/types/book';
import {
  getBookNavFilename,
  getConfigFilename,
  getCoverFilename,
  getDir,
  getLocalBookFilename,
  INIT_BOOK_CONFIG,
} from '@/utils/book';
import { partialMD5 } from '@/utils/md5';
import { serializeRawConfig } from '@/utils/serializer';

export interface SaveEditedEpubResult {
  book: Book;
}

export const saveEditedEpub = async ({
  appService,
  envConfig,
  book,
  newEpub,
}: {
  appService: AppService;
  envConfig: EnvConfigType;
  book: Book;
  newEpub: Blob;
}): Promise<SaveEditedEpubResult> => {
  const oldHash = book.hash;
  const filename = `${book.sourceTitle || book.title}.epub`;
  const file = new File([newEpub], filename, { type: 'application/epub+zip' });
  const newHash = await partialMD5(file);
  const newBook: Book = { ...book, hash: newHash, updatedAt: Date.now() };
  const newDir = getDir(newBook);

  try {
    await appService.createDir(newDir, 'Books', true);
    await appService.writeFile(getLocalBookFilename(newBook), 'Books', file);

    const oldConfigPath = getConfigFilename(book);
    let config: BookConfig = { ...INIT_BOOK_CONFIG };
    try {
      const raw = (await appService.readFile(oldConfigPath, 'Books', 'text')) as string;
      config = { ...INIT_BOOK_CONFIG, ...JSON.parse(raw) } as BookConfig;
    } catch {
      // No prior config: keep the initial config below.
    }
    config.bookHash = newHash;
    config.metaHash = book.metaHash;
    await appService.writeFile(getConfigFilename(newBook), 'Books', serializeRawConfig(config));

    try {
      await appService.copyFile(
        getCoverFilename(book),
        'Books',
        getCoverFilename(newBook),
        'Books',
      );
    } catch {
      // Cover is optional.
    }
    try {
      await appService.copyFile(
        getBookNavFilename(book),
        'Books',
        getBookNavFilename(newBook),
        'Books',
      );
    } catch {
      // Nav is optional.
    }

    const { library, setLibrary } = useLibraryStore.getState();
    const nextLibrary = library.map((item) => (item.hash === oldHash ? newBook : item));
    setLibrary(nextLibrary);
    await appService.saveLibraryBooks(nextLibrary);

    if (oldHash !== newHash && (await appService.isDirectory(oldHash, 'Books'))) {
      try {
        await appService.deleteDir(oldHash, 'Books', true);
      } catch {
        // Old directory cleanup is best-effort after the new copy is live.
      }
    }
    return { book: newBook };
  } catch (error) {
    if (newHash && newHash !== oldHash) {
      try {
        await appService.deleteDir(newDir, 'Books', true);
      } catch {
        // Best-effort cleanup; the old directory is untouched on failure.
      }
    }
    throw error;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/saveEditedEpub.test.ts`
Expected: PASS (2 tests). `partialMD5` reads the whole small fixture, so no hash stub is needed.

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/app/reader/editor/saveEditedEpub.ts apps/readest-app/src/__tests__/editor/saveEditedEpub.test.ts
git commit -m "feat(editor): save edited epub with progress migration"
```

---

### Task 4: EditorView 编辑视图

**Files:**
- Create: `apps/readest-app/src/app/reader/editor/EditorView.tsx`
- Test: `apps/readest-app/src/__tests__/editor/EditorView.browser.test.tsx`

**Interfaces:**
- Consumes: `BookDoc`、`serializeEditedSection`、`useTranslation`
- Produces: `export const EditorView: React.FC<{ bookDoc: BookDoc; sectionIndex: number; onSave: (html: string) => Promise<void> | void; onCancel: () => void }>`

- [ ] **Step 1: Write the failing browser test**

Create `apps/readest-app/src/__tests__/editor/EditorView.browser.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { EditorView } from '@/app/reader/editor/EditorView';
import { BookDoc } from '@/libs/document';

const sectionHtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body><p>Hello world</p><p>Second paragraph</p></body>
</html>`;

const bookDoc = {
  sections: [
    {
      id: 'OEBPS/chapter1.xhtml',
      loadText: async () => sectionHtml,
    },
  ],
} as unknown as BookDoc;

describe('EditorView', () => {
  it('loads the section and reports the edited html on save', async () => {
    const onSave = vi.fn(async () => {});
    render(<EditorView bookDoc={bookDoc} sectionIndex={0} onSave={onSave} onCancel={() => {}} />);

    const iframe = document.querySelector('iframe')!;
    await waitFor(() => {
      expect(iframe.contentDocument?.body.textContent).toContain('Hello world');
    });

    const doc = iframe.contentDocument!;
    doc.body.querySelector('p')!.textContent = 'Edited text';

    screen.getByRole('button', { name: /Save/ }).click();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const html = onSave.mock.calls[0]![0] as string;
    expect(html).toContain('Edited text');
  });

  it('calls cancel after confirming when there are unsaved changes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCancel = vi.fn();
    render(<EditorView bookDoc={bookDoc} sectionIndex={0} onSave={vi.fn()} onCancel={onCancel} />);

    const iframe = document.querySelector('iframe')!;
    await waitFor(() => {
      expect(iframe.contentDocument?.body.textContent).toContain('Hello world');
    });

    screen.getByRole('button', { name: /Cancel/ }).click();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter readest-local test:browser src/__tests__/editor/EditorView.browser.test.tsx`
Expected: FAIL with module `@/app/reader/editor/EditorView` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/readest-app/src/app/reader/editor/EditorView.tsx`:

```tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useTranslation } from '@/hooks/useTranslation';
import { serializeEditedSection } from './sectionSerializer';

interface EditorViewProps {
  bookDoc: BookDoc;
  sectionIndex: number;
  onSave: (html: string) => Promise<void> | void;
  onCancel: () => void;
}

const EDITOR_CSS = `
  html, body { height: 100%; margin: 0; padding: 16px; }
  body { font-family: inherit; line-height: 1.7; overflow-y: auto; }
  img, a, sup, span { pointer-events: none; user-select: none; }
`;

export const EditorView: React.FC<EditorViewProps> = ({
  bookDoc,
  sectionIndex,
  onSave,
  onCancel,
}) => {
  const _ = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const originalHtmlRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const section = bookDoc.sections[sectionIndex];
    section
      ?.loadText()
      .then((text) => {
        if (cancelled || !text) return;
        originalHtmlRef.current = text;
        const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
        iframeRef.current?.setAttribute('srcdoc', new XMLSerializer().serializeToString(doc));
      })
      .catch(() => setError(_('Failed to parse EPUB')));
    return () => {
      cancelled = true;
    };
  }, [bookDoc, sectionIndex, _]);

  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = EDITOR_CSS;
    doc.head?.append(style);
    doc.body.setAttribute('contenteditable', 'true');
  }, []);

  const handleCancel = useCallback(() => {
    if (window.confirm(_('Unsaved changes will be lost'))) onCancel();
  }, [onCancel, _]);

  const handleSave = useCallback(async () => {
    const originalHtml = originalHtmlRef.current;
    const doc = iframeRef.current?.contentDocument;
    if (!originalHtml || !doc || saving) return;
    setError(null);
    try {
      const html = serializeEditedSection(
        originalHtml,
        new XMLSerializer().serializeToString(doc),
      );
      setSaving(true);
      await onSave(html);
    } catch (e) {
      setError(e instanceof Error ? e.message : _('Save Changes'));
    } finally {
      setSaving(false);
    }
  }, [onSave, saving, _]);

  return (
    <div className='editor-view flex h-full w-full flex-col bg-base-100'>
      <div className='flex h-11 shrink-0 items-center justify-between px-4'>
        <span className='text-sm font-medium'>{_('Edit Book Content')}</span>
        <div className='flex items-center gap-2'>
          {error && <span className='text-sm text-error'>{error}</span>}
          <button
            className='btn btn-ghost h-8 min-h-8 px-3 text-sm'
            onClick={handleCancel}
            disabled={saving}
          >
            {_('Cancel')}
          </button>
          <button
            className='btn btn-primary h-8 min-h-8 px-3 text-sm'
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? `${_('Save')}…` : _('Save')}
          </button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        className='w-full flex-1 border-0'
        sandbox='allow-same-origin'
        title={_('Edit Book Content')}
        onLoad={handleIframeLoad}
      />
    </div>
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter readest-local test:browser src/__tests__/editor/EditorView.browser.test.tsx`
Expected: PASS (2 tests). If the browser test cannot access `iframe.contentDocument`, verify the test runs in the existing Playwright-backed browser config; `allow-same-origin` keeps same-origin access.

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/app/reader/editor/EditorView.tsx apps/readest-app/src/__tests__/editor/EditorView.browser.test.tsx
git commit -m "feat(editor): add inline editor view"
```

---

### Task 5: 阅读页集成（编辑按钮、编辑态、保存重开）

**Files:**
- Modify: `apps/readest-app/src/store/readerStore.ts`
- Modify: `apps/readest-app/src/app/reader/components/HeaderBar.tsx`
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`
- Modify: `apps/readest-app/public/locales/zh-CN/translation.json`
- Modify: `apps/readest-app/public/locales/en/translation.json`

**Interfaces:**
- Consumes: Task 1-4 的 `readZipEntries` / `rewriteEpub` / `saveEditedEpub` / `EditorView`
- Produces: `ReaderStore.setEditing(key: string, editing: boolean)`；HeaderBar 编辑按钮；FoliateViewer 编辑态渲染、保存后用新 hash 重建阅读器

- [ ] **Step 1: Add editing state to readerStore**

In `apps/readest-app/src/store/readerStore.ts`:

1. In `interface ViewState`, after `previewMode: boolean;` add:

```ts
  /* True while the inline EPUB text editor is open for this view. */
  editing: boolean;
```

2. In `interface ReaderStore`, after `setPreviewMode` add:

```ts
  setEditing: (key: string, editing: boolean) => void;
```

3. In every `ViewState` object literal that sets `previewMode: false` (there are three, at roughly lines 170, 310, and 334), add `editing: false,` next to it.

4. Add the action after `setPreviewMode`:

```ts
  setEditing: (key, editing) =>
    set((state) => {
      const current = state.viewStates[key];
      if (!current) return state;
      return {
        viewStates: {
          ...state.viewStates,
          [key]: { ...current, editing },
        },
      };
    }),
```

- [ ] **Step 2: Add the edit button to HeaderBar**

In `apps/readest-app/src/app/reader/components/HeaderBar.tsx`:

1. Import `MdEdit` from `react-icons/md`, `isTauriAppPlatform` from `@/services/environment`, and `useBookDataStore` from `@/store/bookDataStore`.

2. In the component body, after `const viewSettings = getViewSettings(bookKey);` add:

```ts
  const setEditing = useReaderStore((s) => s.setEditing);
  const editing = useReaderStore((s) => s.viewStates[bookKey]?.editing ?? false);
  const { getBookData } = useBookDataStore();
  const bookData = getBookData(bookKey);
  const canEditBookContent =
    isTauriAppPlatform() && bookData?.book?.format === 'EPUB' && !editing;
```

3. Inside the `header-tools-start` scroller, after the `showBookmarkButton` block, add:

```tsx
            {canEditBookContent && (
              <button
                title={_('Edit Book Content')}
                className='btn btn-ghost hidden h-8 min-h-8 w-8 p-0 sm:flex'
                onClick={() => setEditing(bookKey, true)}
              >
                <MdEdit size={iconSize18} className='fill-base-content' />
              </button>
            )}
```

- [ ] **Step 3: Render EditorView and save in FoliateViewer**

In `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`:

1. Add imports:

```ts
import { uniqueId } from '@/utils/misc';
import { useSidebarStore } from '@/store/sidebarStore';
import { EditorView } from '../editor/EditorView';
import { readZipEntries, rewriteEpub } from '../editor/epubWriter';
import { saveEditedEpub } from '../editor/saveEditedEpub';
```

2. Add store selectors at the top of the component:

```ts
  const editing = useReaderStore((s) => s.viewStates[bookKey]?.editing ?? false);
  const setEditing = useReaderStore((s) => s.setEditing);
  const initViewState = useReaderStore((s) => s.initViewState);
  const setBookKeys = useReaderStore((s) => s.setBookKeys);
  const { setSideBarBookKey } = useSidebarStore();
```

3. Add a handler before the `return (`:

```ts
  const handleSaveEdited = useCallback(
    async (html: string) => {
      const currentBook = bookData?.book;
      if (!appService || !currentBook || currentBook.format !== 'EPUB') return;
      const { file } = await appService.loadBookContent(currentBook);
      const entries = await readZipEntries(file);
      const sectionIndex = viewRef.current?.renderer.primaryIndex ?? 0;
      const sectionId = bookData.bookDoc.sections[sectionIndex]?.id;
      if (!sectionId) throw new Error('Section not found');
      const newEpub = await rewriteEpub(
        entries,
        sectionId,
        new TextEncoder().encode(html),
      );
      const { book: savedBook } = await saveEditedEpub({
        appService,
        envConfig,
        book: currentBook,
        newEpub,
      });

      setEditing(bookKey, false);
      // The book hash changed, so the reader key must follow the new hash.
      const newBookKey = `${savedBook.hash}-${uniqueId()}`;
      const nextKeys = useReaderStore
        .getState()
        .bookKeys.map((key) => (key === bookKey ? newBookKey : key));
      setBookKeys(nextKeys);
      setSideBarBookKey(newBookKey);
      void initViewState(envConfig, savedBook.hash, newBookKey, true);
    },
    [appService, bookData, bookKey, envConfig, initViewState, setBookKeys, setEditing],
  );
```

4. In the JSX, wrap the current reader container with an editing branch. Replace the existing `<div ref={containerRef} ... />` block with:

```tsx
      {editing ? (
        <EditorView
          bookDoc={bookData.bookDoc}
          sectionIndex={viewRef.current?.renderer.primaryIndex ?? 0}
          onSave={handleSaveEdited}
          onCancel={() => setEditing(bookKey, false)}
        />
      ) : (
        <div
          ref={containerRef}
          role='main'
          aria-label={_('Book Content')}
          className={clsx(
            'foliate-viewer absolute h-[100%] w-[100%] focus:outline-none',
            viewState?.loading && 'bg-base-100',
          )}
          style={{
            paddingTop: scrollMargins.top,
            paddingBottom: scrollMargins.bottom,
          }}
          {...mouseHandlers}
          {...touchHandlers}
        />
      )}
```

- [ ] **Step 4: Add translation keys**

In `apps/readest-app/public/locales/zh-CN/translation.json`, add:

```json
  "Edit Book Content": "编辑正文",
  "Only text edits are supported": "仅支持修改文字",
  "Unsaved changes will be lost": "未保存的修改将丢失"
```

In `apps/readest-app/public/locales/en/translation.json`, add:

```json
  "Edit Book Content": "Edit Book Content",
  "Only text edits are supported": "Only text edits are supported",
  "Unsaved changes will be lost": "Unsaved changes will be lost"
```

- [ ] **Step 5: Verify types, lint, and existing tests**

Run: `pnpm --filter readest-local lint`
Expected: PASS.

Run: `pnpm --filter readest-local test:pr:web:unit src/__tests__/editor/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/readest-app/src/store/readerStore.ts apps/readest-app/src/app/reader/components/HeaderBar.tsx apps/readest-app/src/app/reader/components/FoliateViewer.tsx apps/readest-app/public/locales/zh-CN/translation.json apps/readest-app/public/locales/en/translation.json
git commit -m "feat(editor): integrate inline EPUB editor into reader"
```

---

### Task 6: 集成验证与收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-epub-inline-text-editor.md`（勾选完成项，若有偏差则补记）

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm --filter readest-local test:pr:web:unit`
Expected: PASS (existing suite plus the new editor tests).

- [ ] **Step 2: Run the browser suite**

Run: `pnpm --filter readest-local test:browser src/__tests__/editor/`
Expected: PASS.

- [ ] **Step 3: Manual desktop verification**

1. 桌面端导入一本 EPUB，打开正文。
2. 顶部显示“编辑正文”按钮，点击进入编辑视图。
3. 修改一段文字、新增一个段落，点保存。
4. 确认书重新打开后正文变化生效、排版正常。
5. 在书库确认这本书仍是同一本（无重复条目）。
6. 关闭后重新打开，阅读进度与保存前一致（允许轻微位置偏差）。
7. 编辑视图里尝试插入图片或删除链接，确认保存被拒绝并提示“仅支持修改文字”。
8. 不保存点取消，确认原文件不变。

- [ ] **Step 4: Update the design doc if behavior diverged**

Run: 对比 `docs/superpowers/specs/2026-08-11-epub-inline-text-editor-design.md` 与最终行为，有偏差时在文档末尾追加“实现偏差”小节并提交。

- [ ] **Step 5: Commit any final doc changes**

```bash
git add docs
git commit -m "docs(editor): record implementation notes"
```
