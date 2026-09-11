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

const bookDoc = {
  rendition: {},
  toc: [],
  sections: [{ id: 's1' }],
  metadata: { language: 'zh' },
} as unknown as BookDoc;

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
  it.each([
    'zh-cn',
    'zh-CN',
    'zh-TW',
    'zh-Hant',
  ])('区域语言码 %s 归一化为规则表主码 zh，内置预览不为 0', async (lang) => {
    const regionDoc = { ...bookDoc, metadata: { language: lang } } as unknown as BookDoc;
    renderDialog('k1', () => {}, regionDoc);
    await waitFor(() =>
      expect(scanMock.countChapterMatches).toHaveBeenCalledWith(regionDoc, '', 'zh'),
    );
    await waitFor(() => expect(screen.getByText(/matches 15 locations/iu)).toBeTruthy());
  });

  it('确认生成：先 apply 再写 config、刷新 bookData 的 bookDoc 引用并关闭', async () => {
    // bookKey 带 `-view0` 后缀，而 booksData 以书籍 id（hash 段）为键——刷新必须写回 id。
    useBookDataStore.setState({ booksData: { k1: makeStoreBookData('k1', bookDoc) } });
    const setSpy = vi.spyOn(useBookDataStore, 'setState');
    const saveSpy = vi
      .spyOn(useBookDataStore.getState(), 'saveConfig')
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog('k1-view0', onClose);

    await waitFor(() => screen.getByRole('button', { name: GENERATE }));
    fireEvent.click(screen.getByRole('button', { name: GENERATE }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(scanMock.generateVirtualTocEntries).toHaveBeenCalledWith(bookDoc, '', 'zh');
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
    expect(useBookDataStore.getState().booksData['k1']!.bookDoc).not.toBe(bookDoc);
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
  it('扫描/合成途中取消按钮被禁用，完成前用户无法取消后仍写盘', async () => {
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
    const otherDoc = {
      rendition: {},
      toc: [],
      sections: [{ id: 's2' }],
      metadata: { language: 'zh' },
    } as unknown as BookDoc;
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
