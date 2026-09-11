'use client';

// 「从正文生成目录」弹窗（Task 7）：内置章节规则预选 → 命中预览 → 生成/按文件分章。
// 生成的条目先过 applyVirtualToc 门禁、落进书籍 config，再刷新 bookData 引用让目录树
// 立即更新；EPUB 文件本身永不改动。
import { useEffect, useMemo, useRef, useState } from 'react';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { getPrimaryLanguage } from '@/utils/book';
import { validateChapterPattern } from '@/utils/chapterRules';
import { countChapterMatches, generateVirtualTocEntries } from '@/services/virtualToc/scan';
import { shouldOfferSynthesis, synthesizeSectionToc } from '@/services/virtualToc/synthesis';
import { applyVirtualToc } from '@/services/virtualToc/apply';

type VirtualTocDialogProps = {
  bookKey: string;
  bookDoc: BookDoc;
  onClose: () => void;
};

// 预览扫描节流：正则每敲一个字符就扫全书的代价过高（slab 书单 section 就是几百 KB）。
const PREVIEW_DEBOUNCE_MS = 400;

const VirtualTocDialog = ({ bookKey, bookDoc, onClose }: VirtualTocDialogProps) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  // R19：CHAPTER_RULES 的键只有 zh/ja/ko/'*'，而 metadata.language 常带区域码
  // （Task 8 样本书的 OPF 就是 `zh-cn`）——不归一化会落到英文规则，中文书命中恒为 0、
  // 生成按钮被禁用。用仓库现成的 getPrimaryLanguage 取主码（不归一化时它是 'en'）。
  // R22：取第一个「去空白后非空」的语言码，空串/纯空白/`['']`（畸形 OPF）都兜底 zh——
  // 把 getPrimaryLanguage('') 的 'en' 当结果会把中文书推进英文规则。
  const rawLanguage = bookDoc.metadata?.language;
  const languageSource = Array.isArray(rawLanguage)
    ? rawLanguage.find((code) => typeof code === 'string' && code.trim() !== '')
    : rawLanguage;
  const hasLanguage = typeof languageSource === 'string' && languageSource.trim() !== '';
  const language = hasLanguage ? getPrimaryLanguage(languageSource) : 'zh';
  const [pattern, setPattern] = useState('');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  // R21：Dialog 自带的关闭入口（X / ESC / 遮罩 / Android 返回键 / 移动端拖拽）不受
  // `generating` 约束，都会 onClose → Content 卸载弹窗，而 pending 的 await 不随卸载中断。
  // 世代号在卸载时自增，让已经作废的生成结果放弃 apply / 写盘 / toast / onClose。
  const generationRef = useRef(0);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );
  // R6：synthesizeSectionToc 自身没有 fixed-layout 守卫，可见性一律由 shouldOfferSynthesis
  // 把守（它同时排除 pre-paginated 与健康目录），按钮不可见即调用点不可达。
  const offerSynthesis = useMemo(() => shouldOfferSynthesis(bookDoc), [bookDoc]);
  const patternErrors = pattern ? validateChapterPattern(pattern) : [];

  useEffect(() => {
    if (patternErrors.length > 0) return;
    let cancelled = false;
    setScanning(true);
    const timer = setTimeout(async () => {
      try {
        const count = await countChapterMatches(bookDoc, pattern, language);
        if (!cancelled) setPreviewCount(count);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, bookDoc, language]);

  // 顺序必须是「先 apply、后 saveConfig」：apply 会被 isTocDegraded / pre-paginated /
  // 空条目三道守卫拒绝，若先持久化就会留下一份永远不生效的死配置，而用户看到的是成功提示。
  // 返回 false 时：错误 toast、不写 config、不关弹窗（调用方据此决定是否 onClose）。
  const persistAndApply = async (entries: VirtualTocEntry[]): Promise<boolean> => {
    if (!applyVirtualToc(bookDoc, entries)) {
      eventDispatcher.dispatch('toast', {
        message: _('Cannot apply virtual TOC to this book'),
        type: 'error',
        timeout: 4000,
      });
      return false;
    }
    const store = useBookDataStore.getState();
    const existing = store.getConfig(bookKey) ?? { updatedAt: 0 };
    const config = { ...existing, virtualToc: entries, updatedAt: Date.now() };
    await store.saveConfig(envConfig, bookKey, config, useSettingsStore.getState().settings);
    // booksData 以书籍 id（bookKey 的 hash 段）为键，而 bookKey 带 `-viewN` 后缀：
    // 按完整 bookKey 写会新建一个永不读取的条目，目录树不会刷新。
    const bookId = bookKey.split('-')[0]!;
    useBookDataStore.setState((state) => {
      const current = state.booksData[bookId];
      if (!current) return state;
      // config 一并写回内存：内存里的 config 是 saveConfig(getConfig(bookKey)) 这类
      // 整份落盘调用的来源，不带上 virtualToc 会把刚生成的目录从磁盘上抹掉。
      return {
        booksData: {
          ...state.booksData,
          [bookId]: { ...current, config, bookDoc: { ...bookDoc } },
        },
      };
    });
    eventDispatcher.dispatch('toast', {
      message: _('TOC generated: {{count}} entries', { count: entries.length }),
      type: 'success',
      timeout: 2500,
    });
    return true;
  };

  const handleGenerate = async () => {
    const gen = ++generationRef.current;
    setGenerating(true);
    try {
      const entries = await generateVirtualTocEntries(bookDoc, pattern, language);
      // R21：弹窗已在扫描途中被关闭（卸载使世代号自增）→ 丢弃结果，不写盘。
      if (generationRef.current !== gen) return;
      if (entries.length === 0) {
        eventDispatcher.dispatch('toast', {
          message: _('No chapter-like lines matched. Try a custom pattern.'),
          type: 'error',
          timeout: 4000,
        });
        return;
      }
      if (await persistAndApply(entries)) onClose();
    } catch (e) {
      console.error('virtualToc generate failed:', e);
      if (generationRef.current !== gen) return;
      eventDispatcher.dispatch('toast', { message: _('Failed to generate TOC'), type: 'error' });
    } finally {
      if (generationRef.current === gen) setGenerating(false);
    }
  };

  const handleSynthesize = async () => {
    const gen = ++generationRef.current;
    setGenerating(true);
    try {
      const entries = await synthesizeSectionToc(bookDoc);
      if (generationRef.current !== gen) return;
      if (await persistAndApply(entries)) onClose();
    } catch (e) {
      console.error('virtualToc synthesize failed:', e);
      if (generationRef.current !== gen) return;
      eventDispatcher.dispatch('toast', { message: _('Failed to generate TOC'), type: 'error' });
    } finally {
      if (generationRef.current === gen) setGenerating(false);
    }
  };

  return (
    <Dialog isOpen title={_('Generate TOC from content')} onClose={onClose} useOverlayScroll>
      <div className='flex flex-col gap-3 p-4'>
        <p className='text-base-content/80 text-sm leading-relaxed'>
          {_('This book has no usable TOC. Pick a chapter pattern; matches become TOC entries.')}
        </p>
        <label className='form-control'>
          <div className='label-text text-base-content/70'>
            {_('Custom chapter pattern (optional, e.g. 第\\d+章)')}
          </div>
          <input
            type='text'
            className='input input-sm input-bordered eink-bordered mt-1'
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setPreviewCount(null);
            }}
            placeholder='第[0-9一二三四五六七八九十]+章'
          />
        </label>
        {patternErrors.length > 0 && (
          <p className='text-error text-xs'>
            {_('Invalid pattern: {{reason}}', { reason: patternErrors[0]! })}
          </p>
        )}
        {patternErrors.length === 0 && (
          <p className='text-base-content/70 text-sm'>
            {scanning
              ? _('Scanning…')
              : previewCount !== null
                ? _('This pattern matches {{count}} locations', { count: previewCount })
                : ''}
          </p>
        )}
        {offerSynthesis && (
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={generating}
            onClick={handleSynthesize}
          >
            {_('Use section files as chapters')}
          </button>
        )}
        <div className='mt-1 flex justify-end gap-2 pb-2'>
          {/* R20：生成/合成途中禁用取消——否则扫描完成仍会 apply + saveConfig + 成功 toast，
              用户「已经取消却写了数据」。与另两个按钮同口径。 */}
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={generating}
            onClick={onClose}
          >
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            disabled={generating || patternErrors.length > 0 || previewCount === 0}
            onClick={handleGenerate}
          >
            {generating ? _('Scanning…') : _('Generate')}
          </button>
        </div>
        <p className='text-base-content/50 text-xs leading-relaxed'>
          {_('Virtual TOC is saved per book and never modifies the EPUB file.')}
        </p>
      </div>
    </Dialog>
  );
};

export default VirtualTocDialog;
