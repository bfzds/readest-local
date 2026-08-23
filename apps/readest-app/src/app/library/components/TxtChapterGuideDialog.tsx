'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

import Dialog from '@/components/Dialog';
import { extractTxtChapterCandidates, buildChapterPatternFromSamples } from '@/utils/txt';

type TxtChapterGuideDialogProps = {
  file: File;
  filename: string;
  onConfirm: (pattern: string, appliedCount: number) => void;
  onCancel: () => void;
};

// 目录识别失败引导：展示源文里的候选标题行，用户勾选哪行是章节标题，据此
// 生成一条临时识别规则（仅本次重切，不写全局设置）。
const TxtChapterGuideDialog = ({
  file,
  filename,
  onConfirm,
  onCancel,
}: TxtChapterGuideDialogProps) => {
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void extractTxtChapterCandidates(file).then((rows) => {
      if (cancelled) return;
      setCandidates(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const toggle = (line: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(line)) {
        next.delete(line);
      } else {
        next.add(line);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const pattern = buildChapterPatternFromSamples([...selected]);
    if (!pattern) {
      setError('无法从勾选的行生成匹配规则，请勾选至少两个格式相近的标题行');
      return;
    }
    onConfirm(pattern, selected.size);
  };

  return (
    <Dialog isOpen title='目录识别失败' onClose={onCancel} useOverlayScroll>
      <div className='flex flex-col gap-3 p-4'>
        <p className='text-base-content/80 text-sm leading-relaxed'>
          没能从《{filename}》中自动识别出章节标题。请从下面这些候选行中，勾选出
          <span className='text-base-content font-medium'>每一章的标题行</span>
          （勾选得越全，生成规则越准）。
        </p>

        {loading ? (
          <div className='text-base-content/60 py-6 text-center text-sm'>正在读取候选标题行…</div>
        ) : candidates.length === 0 ? (
          <div className='text-base-content/60 py-6 text-center text-sm'>
            未找到看似标题的候选行。可能是文件编码异常或章节格式太少见。
          </div>
        ) : (
          <div className='divide-y divide-base-300 max-h-72 overflow-y-auto rounded-lg border border-base-300'>
            {candidates.map((line) => {
              const checked = selected.has(line);
              return (
                <label
                  key={line}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                    checked && 'bg-base-200',
                  )}
                >
                  <input
                    type='checkbox'
                    className='checkbox checkbox-sm'
                    checked={checked}
                    onChange={() => toggle(line)}
                  />
                  <span className='text-base-content/80 line-clamp-1'>{line}</span>
                </label>
              );
            })}
          </div>
        )}

        {error && <p className='text-error text-xs'>{error}</p>}

        <div className='mt-1 flex justify-end gap-2 pb-2'>
          <button type='button' className='btn btn-ghost btn-sm' onClick={onCancel}>
            取消并放弃导入
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            disabled={selected.size === 0}
            onClick={handleConfirm}
          >
            按勾选重切（{selected.size} 行）
          </button>
        </div>

        <p className='text-base-content/50 text-xs leading-relaxed'>
          生成的规则仅用于本次重新切分，不会写入全局设置；想长期使用可在“设置 → TXT Chapter
          Pattern”里手工保存。
        </p>
      </div>
    </Dialog>
  );
};

export default TxtChapterGuideDialog;
