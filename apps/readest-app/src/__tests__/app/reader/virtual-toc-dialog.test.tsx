// @vitest-environment jsdom
// 虚拟目录弹窗（Task 7）：内置规则预选 → 命中预览 → 生成/按文件分章 → 先 apply 后持久化。
// 三条路径（取消 / 正则生成 / 按文件分章）与两个门禁（apply 被拒、空条目）都钉在这里。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scanMock = vi.hoisted(() => ({
  countChapterMatches: vi.fn().mockResolvedValue(15),
  generateVirtualTocEntries: vi
    .fn()
    .mockResolvedValue([
      { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
    ]),
}));
// 两个模块各自独立 mock——共用一个对象会让「synthesis 没被调用」这类断言失去判别力。
const synthMock = vi.hoisted(() => ({
  synthesizeSectionToc: vi
    .fn()
    .mockResolvedValue([{ label: 's1', cfi: 'epubcfi(/6/4)', source: 'section', generatedAt: 1 }]),
  shouldOfferSynthesis: vi.fn().mockReturnValue(false),
}));
const applyMock = vi.hoisted(() => ({
  applyVirtualToc: vi.fn(() => true),
  isTocDegraded: vi.fn(() => true),
}));

vi.mock('@/services/virtualToc/scan', () => scanMock);
vi.mock('@/services/virtualToc/synthesis', () => synthMock);
vi.mock('@/services/virtualToc/apply', () => applyMock);

// 仓库真实路径是 @/hooks/useTranslation；mock 必须做 {{count}} 之类的插值，
// 否则界面渲染的是 key 原文，预览与 toast 断言都无从判别。
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (key: string, options: Record<string, number | string> = {}) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? '')),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: ReactNode }) => <div role='dialog'>{children}</div>,
}));

// Content（R18 用例）的依赖：重的子组件与无关 store 一律 stub，只留真实的 bookDataStore。
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setHoveredBookKey: vi.fn() }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ setSideBarVisible: vi.fn(), setSearchBarVisible: vi.fn() }),
}));
vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/app/reader/components/sidebar/TOCView', () => ({
  default: () => <div data-testid='toc-view' />,
}));
vi.mock('@/app/reader/components/sidebar/BooknoteView', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/TabNavigation', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/TOCChapterNav', () => ({ default: () => null }));

import VirtualTocDialog from '@/app/reader/components/VirtualTocDialog';
import Content from '@/app/reader/components/sidebar/Content';
import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { useBookDataStore } from '@/store/bookDataStore';
import { eventDispatcher } from '@/utils/event';

// 夹具必须是**真的类实例**：生产里 book 是 `new EPUB(...)` 的实例，`splitTOCHref`
// 定义在 `EPUB.prototype` 上（packages/foliate-js/epub.js）。手写普通对象天生没有
// 原型方法，永远测不出「对象字面量展开 `{ ...bookDoc }` 丢方法」这类破坏——Task 10
// 的回归钉子就靠这个夹具把住。
class FakeEPUB {
  toc: { id: number; label: string; href: string }[] = [];
  sections = [{ id: 's1' }];
  rendition = {};
  metadata: { language: string | string[] };
  constructor(language: string | string[] = 'zh') {
    this.metadata = { language };
  }
  splitTOCHref(href: string): (string | number)[] {
    return href.split('#');
  }
}

const makeBookDoc = (language: string | string[] = 'zh'): BookDoc =>
  new FakeEPUB(language) as unknown as BookDoc;

const bookDoc = makeBookDoc();

const makeStoreBookData = (id: string, doc: BookDoc, format = 'EPUB') =>
  ({
    id,
    book: { format },
    file: null,
    config: { updatedAt: 1, viewSettings: { sideBarTab: 'toc' } },
    bookDoc: doc,
    isFixedLayout: false,
  }) as never;

const renderDialog = (bookKey: string, onClose: () => void = () => {}, doc: BookDoc = bookDoc) =>
  render(<VirtualTocDialog bookKey={bookKey} bookDoc={doc} onClose={onClose} />);

const GENERATE = /^Generate$/u;
const SYNTHESIZE = /section files as chapters/iu;

describe('VirtualTocDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBookDataStore.setState({ booksData: {} });
  });

  afterEach(() => {
    cleanup();
    synthMock.shouldOfferSynthesis.mockReturnValue(false);
  });

  it('挂载即对内置规则做命中预览', async () => {
    renderDialog('k1');
    await waitFor(() =>
      expect(scanMock.countChapterMatches).toHaveBeenCalledWith(bookDoc, '', 'zh'),
    );
    await waitFor(() => expect(screen.getByText(/matches 15 locations/iu)).toBeTruthy());
  });

  // 区域码是常态（Task 8 样本书的 OPF 是 `zh-cn`，全小写），而 CHAPTER_RULES 只认
  // zh/ja/ko/'*'——不归一化就会落到 EN_RULES，中文书内置预览恒为 0、生成按钮被禁用。
  // 生产里语言码是数组（epub.js 的 `dc.language?.map(x => x.value)` → `['zh-cn']`），
  // 裸字符串只是简写形态，两种都得归一化。
  it.each<[string, string | string[]]>([
    ['zh-cn', 'zh-cn'],
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-Hant', 'zh-Hant'],
    ["['zh-cn']（foliate 真实形状）", ['zh-cn']],
  ])('区域语言码 %s 归一化为规则表主码 zh，内置预览不为 0', async (_name, lang) => {
    const regionDoc = makeBookDoc(lang);
    renderDialog('k1', () => {}, regionDoc);
    await waitFor(() =>
      expect(scanMock.countChapterMatches).toHaveBeenCalledWith(regionDoc, '', 'zh'),
    );
    await waitFor(() => expect(screen.getByText(/matches 15 locations/iu)).toBeTruthy());
  });

  // R22：畸形的空 `<dc:language/>`（foliate 会保留空串）必须仍兜底 zh——
  // getPrimaryLanguage('') 返回 'en'，把中文书推进英文规则是方向相反的回归。
  it.each<[string, string | string[]]>([
    ['空串', ''],
    ['纯空白串', '   '],
    ["['']（空串数组）", ['']],
  ])('无有效语言码（%s）仍兜底 zh 规则，不落到 en', async (_name, lang) => {
    const doc = makeBookDoc(lang);
    renderDialog('k1', () => {}, doc);
    await waitFor(() => expect(scanMock.countChapterMatches).toHaveBeenCalledWith(doc, '', 'zh'));
  });

  it('确认生成：先 apply 再写 config、换成新的 bookData 对象（bookDoc 保留同一引用）并关闭', async () => {
    // bookKey 带 `-view0` 后缀，而 booksData 以书籍 id（hash 段）为键——刷新必须写回 id。
    const doc = makeBookDoc();
    useBookDataStore.setState({ booksData: { k1: makeStoreBookData('k1', doc) } });
    const before = useBookDataStore.getState().booksData['k1']!;
    const setSpy = vi.spyOn(useBookDataStore, 'setState');
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    // 用真实 apply 驱动：它**原地**把 bookDoc.toc 换成含负 id 虚拟条目的新数组，
    // 这正是「不换 bookDoc 引用也能刷新目录」的立足点。
    const realApply = await vi.importActual<typeof import('@/services/virtualToc/apply')>(
      '@/services/virtualToc/apply',
    );
    // 真实 apply 的签名是 (bookDoc, entries)；模块级 mock 是无参桩，注入时对齐类型。
    applyMock.applyVirtualToc.mockImplementationOnce(
      realApply.applyVirtualToc as unknown as () => boolean,
    );
    const onClose = vi.fn();
    renderDialog('k1-view0', onClose, doc);

    await waitFor(() => screen.getByRole('button', { name: GENERATE }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(scanMock.generateVirtualTocEntries).toHaveBeenCalledWith(doc, '', 'zh');
    expect(applyMock.applyVirtualToc).toHaveBeenCalled();
    // R13：apply 必须排在持久化之前，否则被守卫拒绝时会留下永不生效的死配置。
    expect(applyMock.applyVirtualToc.mock.invocationCallOrder[0]!).toBeLessThan(
      saveSpy.mock.invocationCallOrder[0]!,
    );
    expect(saveSpy).toHaveBeenCalledWith(
      {},
      'k1-view0',
      expect.objectContaining({
        virtualToc: [expect.objectContaining({ label: '第1章' })],
      }),
      {},
    );
    expect(setSpy).toHaveBeenCalled();
    const after = useBookDataStore.getState().booksData['k1']!;
    // 刷新目录靠的是**外层 BookData 换新对象**：侧栏 Content 用 useBookDataStore()
    // 无选择器订阅整个 store，外层一变就重渲染并读到新 toc，不需要换 bookDoc。
    expect(after).not.toBe(before);
    expect(after.bookDoc).toBe(doc);
    expect(after.bookDoc!.toc!.some((t) => t.id < 0)).toBe(true);
  });

  // Task 10 回归钉子（真机切书崩溃）：生成目录时若把 bookDoc 浅拷贝 `{ ...bookDoc }` 写回
  // store，对象字面量展开只复制自有字段——而 EPUB 的 splitTOCHref 挂在 EPUB.prototype 上，
  // 拷出来的对象 `typeof splitTOCHref === 'undefined'`；残废对象被 store 复用后 nav 管线
  // （services/nav/grouping.ts:43）直接抛 `TypeError: bookDoc.splitTOCHref is not a function`
  // → `Failed to open book in reader`。夹具是真类实例，所以只有它测得出这类破坏。
  it('回归钉子：生成目录后 store 里的 bookDoc 仍是可用类实例（原型方法未丢）', async () => {
    const doc = makeBookDoc();
    useBookDataStore.setState({ booksData: { k1: makeStoreBookData('k1', doc) } });
    const tocBefore = doc.toc;
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const realApply = await vi.importActual<typeof import('@/services/virtualToc/apply')>(
      '@/services/virtualToc/apply',
    );
    applyMock.applyVirtualToc.mockImplementationOnce(
      realApply.applyVirtualToc as unknown as () => boolean,
    );
    renderDialog('k1-view0', () => {}, doc);

    await waitFor(() => screen.getByRole('button', { name: GENERATE }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    const stored = useBookDataStore.getState().booksData['k1']!.bookDoc!;
    expect(typeof stored.splitTOCHref).toBe('function');
    // 目录确实合并进去了（负 id = 虚拟条目），证明刷新不依赖换 bookDoc 引用。
    expect(stored.toc!.some((t) => t.id < 0)).toBe(true);
    // 钉住真机崩溃点：nav 管线的调用形态（grouping.ts:43）不再抛 TypeError。
    expect(() => stored.splitTOCHref('OEBPS/ch1.xhtml#frag')).not.toThrow();
    // 钉住真实刷新机制的**前提**：侧栏是取数式读取——SideBar.tsx:214 每次渲染现调
    // getBookData(sideBarBookKey) 再把 bookDoc 当 props 传给 Content（:341），所以从
    // store 取回来的 bookDoc 必须已经**原地**换上了新 toc 数组。将来谁把「原地换 toc」
    // 改成「生成新对象却没写回 store」，这条立刻红。
    const viaGetter = useBookDataStore.getState().getBookData('k1-view0')!;
    expect(viaGetter.bookDoc).toBe(doc);
    expect(viaGetter.bookDoc!.toc).not.toBe(tocBefore);
    expect(viaGetter.bookDoc!.toc!.some((t) => t.id < 0)).toBe(true);
  });

  it('apply 被拒时：错误 toast、不写 config、不关弹窗（防死配置）', async () => {
    // 守卫拒绝（健康目录 / pre-paginated / 空条目）时，绝不能先持久化再 apply——
    // 那会留下一份永远不生效的死配置，而用户看到的是成功提示。
    applyMock.applyVirtualToc.mockReturnValueOnce(false);
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    const onClose = vi.fn();
    renderDialog('k1', onClose);

    await waitFor(() => screen.getByRole('button', { name: GENERATE }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await waitFor(() => expect(applyMock.applyVirtualToc).toHaveBeenCalled());
    await waitFor(() =>
      expect(dispatchSpy).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'error',
          message: 'Cannot apply virtual TOC to this book',
        }),
      ),
    );
    expect(saveSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('扫描零命中时：错误 toast、不 apply、不写 config', async () => {
    scanMock.generateVirtualTocEntries.mockResolvedValueOnce([]);
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    const onClose = vi.fn();
    renderDialog('k1', onClose);

    await waitFor(() => screen.getByRole('button', { name: GENERATE }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await waitFor(() => expect(scanMock.generateVirtualTocEntries).toHaveBeenCalled());
    await waitFor(() =>
      expect(dispatchSpy).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'error',
          message: 'No chapter-like lines matched. Try a custom pattern.',
        }),
      ),
    );
    expect(applyMock.applyVirtualToc).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('取消按钮直接关闭，不触发扫描生成', async () => {
    const onClose = vi.fn();
    renderDialog('k1', onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(scanMock.generateVirtualTocEntries).not.toHaveBeenCalled();
  });

  // R20：扫描途中「取消」若仍可点，用户取消后扫描完成依旧会 apply + saveConfig + 成功
  // toast——「用户已经取消却写了数据」。生成/合成期间禁用取消（与另外两个按钮同口径）。
  it('生成途中取消按钮被禁用，完成后恢复可点', async () => {
    let settleGenerate: ((entries: VirtualTocEntry[]) => void) | undefined;
    scanMock.generateVirtualTocEntries.mockImplementationOnce(
      () =>
        new Promise<VirtualTocEntry[]>((resolve) => {
          settleGenerate = resolve;
        }),
    );
    renderDialog('k1');
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      settleGenerate!([]);
    });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // R21：Dialog 自带的关闭入口（X / ESC / 遮罩 / Android 返回键 / 移动端拖拽）不受
  // `generating` 约束，都会 onClose → Content 卸载弹窗；而 pending 的 await 不随卸载中断，
  // 没有世代守卫时 resolve 后照旧 apply + saveConfig + 成功 toast（「用户已经取消却写了数据」）。
  it('生成途中弹窗被关闭（卸载）：丢弃结果，不 apply、不写 config、无成功 toast', async () => {
    let settleGenerate: ((entries: VirtualTocEntry[]) => void) | undefined;
    scanMock.generateVirtualTocEntries.mockImplementationOnce(
      () =>
        new Promise<VirtualTocEntry[]>((resolve) => {
          settleGenerate = resolve;
        }),
    );
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    const onClose = vi.fn();
    const { unmount } = renderDialog('k1', onClose);
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    unmount();
    await act(async () => {
      settleGenerate!([
        { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
      ]);
    });

    expect(applyMock.applyVirtualToc).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      'toast',
      expect.objectContaining({ type: 'success' }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  // 合成路径同样要守卫（同一个 generating 标志，同一类 pending await）。
  it('合成途中弹窗被关闭（卸载）：丢弃结果，不 apply、不写 config', async () => {
    let settleSynth: ((entries: VirtualTocEntry[]) => void) | undefined;
    synthMock.shouldOfferSynthesis.mockReturnValue(true);
    synthMock.synthesizeSectionToc.mockImplementationOnce(
      () =>
        new Promise<VirtualTocEntry[]>((resolve) => {
          settleSynth = resolve;
        }),
    );
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const { unmount } = renderDialog('k1');
    await waitFor(() => screen.getByRole('button', { name: SYNTHESIZE }));
    fireEvent.click(screen.getByRole('button', { name: SYNTHESIZE }));

    unmount();
    await act(async () => {
      settleSynth!([{ label: 's1', cfi: 'epubcfi(/6/4)', source: 'section', generatedAt: 1 }]);
    });

    expect(applyMock.applyVirtualToc).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('按文件分章：仅在 shouldOfferSynthesis 放行时出现，点击走合成 + apply + 持久化', async () => {
    // R6：synthesizeSectionToc 没有 fixed-layout 守卫，可见性由 shouldOfferSynthesis 把守。
    const { unmount } = renderDialog('k1');
    expect(screen.queryByRole('button', { name: SYNTHESIZE })).toBeNull();
    unmount();

    synthMock.shouldOfferSynthesis.mockReturnValue(true);
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog('k1', onClose);

    await waitFor(() => screen.getByRole('button', { name: SYNTHESIZE }));
    fireEvent.click(screen.getByRole('button', { name: SYNTHESIZE }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(synthMock.synthesizeSectionToc).toHaveBeenCalledWith(bookDoc);
    expect(applyMock.applyVirtualToc).toHaveBeenCalledWith(bookDoc, [
      expect.objectContaining({ source: 'section' }),
    ]);
  });

  // R18：弹窗 open 状态挂在 SidebarContent 根节点，而 SideBar 渲染它时未传 key——
  // 切书必须把 open 复位，否则弹窗跨书保留、按新 props 渲染，用户会误以为在操作原书。
  it('R18：侧栏切换书籍时关闭尚未完成的弹窗', async () => {
    const otherDoc = makeBookDoc();
    useBookDataStore.setState({
      booksData: {
        k1: makeStoreBookData('k1', bookDoc),
        k2: makeStoreBookData('k2', otherDoc),
      },
    });

    const { rerender } = render(<Content bookDoc={bookDoc} sideBarBookKey='k1' />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate TOC from content' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    rerender(<Content bookDoc={otherDoc} sideBarBookKey='k2' />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
