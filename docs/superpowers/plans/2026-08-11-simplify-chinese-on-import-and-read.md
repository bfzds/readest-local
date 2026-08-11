# 导入/阅读简体中文自动转换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导入繁体书籍时自动把书名/作者落库为简体，阅读时默认把正文显示为简体。

**Architecture:** 复用仓库已有的 `simplecc-wasm`（OpenCC 词典）：在 `bookService.importBook` 的元数据归一化后转换标题/作者；把全局默认 `convertChineseVariant` 从 `none` 改为 `t2s`，并迁移旧版 `settings.json`，让新书旧书都默认生效。

**Tech Stack:** TypeScript / React 19 / Next.js / Tauri / Vitest / simplecc-wasm

## Global Constraints

- 工作区已有大量用户未提交改动。不要 revert、不要覆盖用户改动；提交时只暂存本计划新增/修改的文件。
- `metaHash` 必须基于转换前的原始元数据计算，避免同书重复导入被当成新书。
- `t2s` 对简体文本幂等，不做额外繁简检测。
- 不修改原书文件；PDF/FB2 正文转换不在本计划范围。
- 测试命令：`pnpm --filter readest-local test -- --run <files>`；lint 命令：`pnpm --filter readest-local lint`。
- 若目标文件与用户未提交改动冲突，先 `git diff` 确认，再在其基础上做局部修改。

---

### Task 1: `simplifyChineseText` 工具函数

**Files:**
- Modify: `apps/readest-app/src/utils/simplecc.ts`
- Test: `apps/readest-app/src/__tests__/utils/simplecc-title.test.ts`

**Interfaces:**
- Consumes: `initSimpleCC()` / `runSimpleCC(text, variant)`（已在 `apps/readest-app/src/utils/simplecc.ts`）
- Produces: `simplifyChineseText(text: string): Promise<string>`，繁体转简体，失败/无变化时返回原文

- [ ] **Step 1: 写失败测试**

Create `apps/readest-app/src/__tests__/utils/simplecc-title.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@simplecc/simplecc_wasm', () => ({
  default: vi.fn(),
  simplecc: vi.fn(),
}));

import init, { simplecc } from '@simplecc/simplecc_wasm';
import { simplifyChineseText } from '@/utils/simplecc';

const mockInit = init as unknown as Mock;
const mockSimplecc = simplecc as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockInit.mockResolvedValue(undefined);
  mockSimplecc.mockImplementation((text: string) => text);
});

describe('simplifyChineseText', () => {
  it('converts traditional Chinese text', async () => {
    mockSimplecc.mockImplementation((text: string, variant: string) => {
      if (text === '紅樓夢') return '红楼梦';
      if (text === '葉嘉瑩') return '叶嘉莹';
      return text;
    });

    expect(await simplifyChineseText('紅樓夢')).toBe('红楼梦');
    expect(await simplifyChineseText('葉嘉瑩')).toBe('叶嘉莹');
    expect(mockInit).toHaveBeenCalled();
  });

  it('keeps already simplified text unchanged', async () => {
    expect(await simplifyChineseText('红楼梦')).toBe('红楼梦');
  });

  it('keeps non-Chinese text unchanged', async () => {
    expect(await simplifyChineseText('The Dream of the Red Chamber')).toBe(
      'The Dream of the Red Chamber',
    );
  });

  it('returns empty string unchanged', async () => {
    expect(await simplifyChineseText('')).toBe('');
  });

  it('falls back to original text when WASM init fails', async () => {
    mockInit.mockRejectedValueOnce(new Error('wasm load failed'));
    expect(await simplifyChineseText('紅樓夢')).toBe('紅樓夢');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local test -- --run src/__tests__/utils/simplecc-title.test.ts`
Expected: FAIL，`simplifyChineseText` 未导出。

- [ ] **Step 3: 实现 helper**

Append to `apps/readest-app/src/utils/simplecc.ts`:

```ts
export const simplifyChineseText = async (text: string): Promise<string> => {
  if (!text) return text;
  try {
    await initSimpleCC();
    const simplified = runSimpleCC(text, 't2s');
    return simplified === text ? text : simplified;
  } catch (error) {
    console.warn('Failed to simplify Chinese text, keeping original:', error);
    return text;
  }
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local test -- --run src/__tests__/utils/simplecc-title.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/utils/simplecc.ts apps/readest-app/src/__tests__/utils/simplecc-title.test.ts
git commit -m "feat: add Chinese title simplification helper"
```

---

### Task 2: 导入时转换书名与作者

**Files:**
- Modify: `apps/readest-app/src/services/bookService.ts`（`importBook` 中 `metaHash` 计算之后、`book` 对象创建之前）
- Test: `apps/readest-app/src/__tests__/services/import-metahash.test.ts`

**Interfaces:**
- Consumes: `simplifyChineseText(text: string): Promise<string>`（Task 1）
- Produces: 导入后的 `book.title` / `book.sourceTitle` / `book.author` / `book.metadata.title` / `book.metadata.author` 为简体；`book.metaHash` 仍基于原始元数据

- [ ] **Step 1: 写失败测试**

In `apps/readest-app/src/__tests__/services/import-metahash.test.ts`:

1. 在文件顶部（现有 `vi.mock` 区域）加：

```ts
const mockSimplifyChineseText = vi.hoisted(() => vi.fn(async (text: string) => text));

vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: vi.fn(),
  runSimpleCC: vi.fn(),
  simplifyChineseText: mockSimplifyChineseText,
}));
```

2. 在 `describe('importBook metaHash deduplication')` 内追加测试：

```ts
it('simplifies traditional Chinese title and author on import', async () => {
  const originalMetadata = {
    title: '紅樓夢',
    author: '葉嘉瑩',
    language: 'zh-TW',
    identifier: 'isbn-123',
  };
  const metaHash = getMetadataHash(originalMetadata);

  mockPartialMD5.mockResolvedValue('new-hash-456');
  setupMockBookDoc(originalMetadata);
  mockSimplifyChineseText.mockImplementation(async (text: string) => {
    if (text === '紅樓夢') return '红楼梦';
    if (text === '葉嘉瑩') return '叶嘉莹';
    return text;
  });

  const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
  const result = await service.importBook(mockFile, []);

  expect(result?.title).toBe('红楼梦');
  expect(result?.sourceTitle).toBe('红楼梦');
  expect(result?.author).toBe('叶嘉莹');
  expect(result?.metadata?.title).toBe('红楼梦');
  expect(result?.metadata?.author).toBe('叶嘉莹');
  expect(result?.metaHash).toBe(metaHash);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local test -- --run src/__tests__/services/import-metahash.test.ts`
Expected: 新测试 FAIL（title 仍是繁体）。

- [ ] **Step 3: 实现导入转换**

In `apps/readest-app/src/services/bookService.ts`:

1. 顶部加 import：

```ts
import { simplifyChineseText } from '@/utils/simplecc';
```

2. 在 `const primaryLanguage = getPrimaryLanguage(loadedBook.metadata.language);` 之后、`const book: Book = {` 之前插入：

```ts
// metaHash was computed above from the original metadata; only display fields
// are simplified so re-importing the same file still dedupes by original title.
const simplifiedTitle = await simplifyChineseText(formatTitle(loadedBook.metadata.title));
const simplifiedAuthor = await simplifyChineseText(
  formatAuthors(loadedBook.metadata.author, primaryLanguage),
);
loadedBook.metadata.title = simplifiedTitle;
loadedBook.metadata.author = simplifiedAuthor;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local test -- --run src/__tests__/services/import-metahash.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/services/bookService.ts apps/readest-app/src/__tests__/services/import-metahash.test.ts
git commit -m "feat: simplify Chinese title and author on import"
```

---

### Task 3: 阅读默认自动转换 + 旧设置迁移

**Files:**
- Modify: `apps/readest-app/src/services/constants.ts`
- Modify: `apps/readest-app/src/services/settingsService.ts`
- Modify: `apps/readest-app/src/store/readerStore.ts`
- Modify: `apps/readest-app/src/__tests__/services/constants.test.ts`
- Create: `apps/readest-app/src/__tests__/services/settings-chinese-conversion-migration.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_SETTINGS_VERSION`（升级到 2）
- Produces: `migrateChineseConversion(settings: SystemSettings, version: number): void`

- [ ] **Step 1: 写失败测试**

Create `apps/readest-app/src/__tests__/services/settings-chinese-conversion-migration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { SYSTEM_SETTINGS_VERSION } from '@/services/constants';
import { migrateChineseConversion } from '@/services/settingsService';
import type { SystemSettings } from '@/types/settings';

const baseSettings = (): SystemSettings =>
  ({
    globalViewSettings: { convertChineseVariant: 'none' },
  }) as unknown as SystemSettings;

describe('migrateChineseConversion', () => {
  it('migrates legacy none to t2s', () => {
    const settings = baseSettings();
    migrateChineseConversion(settings, 1);
    expect(settings.globalViewSettings.convertChineseVariant).toBe('t2s');
  });

  it('keeps an existing t2s value', () => {
    const settings = baseSettings();
    settings.globalViewSettings.convertChineseVariant = 't2s';
    migrateChineseConversion(settings, 1);
    expect(settings.globalViewSettings.convertChineseVariant).toBe('t2s');
  });

  it('keeps a non-none user pick', () => {
    const settings = baseSettings();
    settings.globalViewSettings.convertChineseVariant = 's2t';
    migrateChineseConversion(settings, 1);
    expect(settings.globalViewSettings.convertChineseVariant).toBe('s2t');
  });

  it('does nothing at the current settings version', () => {
    const settings = baseSettings();
    migrateChineseConversion(settings, SYSTEM_SETTINGS_VERSION);
    expect(settings.globalViewSettings.convertChineseVariant).toBe('none');
  });
});
```

In `apps/readest-app/src/__tests__/services/constants.test.ts`:

```ts
expect(DEFAULT_BOOK_LANGUAGE.convertChineseVariant).toBe('t2s');
expect(SYSTEM_SETTINGS_VERSION).toBe(2);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local test -- --run src/__tests__/services/settings-chinese-conversion-migration.test.ts src/__tests__/services/constants.test.ts`
Expected: 新测试 FAIL（`migrateChineseConversion` 不存在），constants 断言 FAIL。

- [ ] **Step 3: 实现默认值与迁移**

In `apps/readest-app/src/services/constants.ts`:

```ts
convertChineseVariant: 't2s',
```

```ts
export const SYSTEM_SETTINGS_VERSION = 2;
```

In `apps/readest-app/src/services/settingsService.ts`:

1. 从 `./constants` import 增加 `SYSTEM_SETTINGS_VERSION`。
2. 新增导出函数：

```ts
export const migrateChineseConversion = (settings: SystemSettings, version: number): void => {
  if (version >= SYSTEM_SETTINGS_VERSION) return;
  if (settings.globalViewSettings?.convertChineseVariant === 'none') {
    settings.globalViewSettings.convertChineseVariant = 't2s';
  }
};
```

3. 在 `loadSettings` 中 `const version = settings.version ?? 0;` 之后调用：

```ts
migrateChineseConversion(settings, version);
```

In `apps/readest-app/src/store/readerStore.ts`:

```ts
config.viewSettings?.convertChineseVariant ?? 't2s',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local test -- --run src/__tests__/services/settings-chinese-conversion-migration.test.ts src/__tests__/services/constants.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/services/constants.ts apps/readest-app/src/services/settingsService.ts apps/readest-app/src/store/readerStore.ts apps/readest-app/src/__tests__/services/constants.test.ts apps/readest-app/src/__tests__/services/settings-chinese-conversion-migration.test.ts
git commit -m "feat: default simplified Chinese conversion and migrate old settings"
```

---

### Task 4: 全量验证与收尾

**Files:** 无新代码改动。

- [ ] **Step 1: 运行相关测试套件**

Run: `pnpm --filter readest-local test -- --run src/__tests__/utils/simplecc-title.test.ts src/__tests__/services/settings-chinese-conversion-migration.test.ts src/__tests__/services/import-metahash.test.ts src/__tests__/services/constants.test.ts`
Expected: PASS。

- [ ] **Step 2: 运行全量 unit tests**

Run: `pnpm --filter readest-local test -- --run`
Expected: PASS（若仓库已有失败用例，记录并单独说明）。

- [ ] **Step 3: 运行 lint / typecheck**

Run: `pnpm --filter readest-local lint`
Expected: PASS（若仓库已有既有问题，只确认本次改动未新增）。

- [ ] **Step 4: 更新收尾说明**

- 确认未修改原书文件。
- 说明旧书默认行为变化与 PDF/FB2 限制。
- 若目标文件与用户未提交改动冲突，明确列出哪些文件保留了用户改动、哪些已合并。

## Self-Review

- Spec 覆盖：书名/作者导入转换（Task 2）、阅读默认转换（Task 3）、旧设置迁移（Task 3）、helper 与测试（Task 1）、验证（Task 4）全部有对应任务。
- 占位符：无 TBD/TODO，所有代码步骤均给出实际内容。
- 类型一致性：`simplifyChineseText(text: string): Promise<string>` 在 Task 1 定义、Task 2 消费；`migrateChineseConversion(settings, version)` 在 Task 3 定义并测试；字段名与 spec 一致。
