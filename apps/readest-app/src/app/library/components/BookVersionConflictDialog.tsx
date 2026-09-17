'use client';

import { useState } from 'react';
import clsx from 'clsx';

import Dialog from '@/components/Dialog';
import { Book, BookVersionConflictChoice, BookVersionConflictInfo } from '@/types/book';

type BookVersionConflictDialogProps = {
  conflicts: BookVersionConflictInfo[];
  /**
   * 每条冲突的最终选择（顺序与 `conflicts` 一致）。取消/关闭时也走这里——全部
   * 视为 keep，让"不选择"等价于"两本都留着"这个安全默认。
   */
  onConfirm: (choices: BookVersionConflictChoice[]) => void;
  onCancel: () => void;
};

const bookLabel = (book: Book) =>
  book.author ? `《${book.title}》（${book.author}）` : `《${book.title}》`;

/**
 * 「导入的书可能是书库里某本的旧版本」确认框。
 *
 * 只在导入已经完成、两条记录都在库里之后弹出（见 replaceBookVersion 的注释）：
 * 用户关掉窗口不做选择，结果就是两本各存一份，不会有任何数据被删除。
 */
const BookVersionConflictDialog = ({
  conflicts,
  onConfirm,
  onCancel,
}: BookVersionConflictDialogProps) => {
  const [choices, setChoices] = useState<BookVersionConflictChoice[]>(() =>
    conflicts.map(() => 'keep'),
  );
  const replaceCount = choices.filter((choice) => choice === 'replace').length;

  const setChoice = (index: number, choice: BookVersionConflictChoice) => {
    setChoices((prev) => prev.map((value, i) => (i === index ? choice : value)));
  };

  const setAll = (choice: BookVersionConflictChoice) => {
    setChoices((prev) => prev.map(() => choice));
  };

  return (
    <Dialog isOpen title='发现同一本书的新版本' onClose={onCancel} useOverlayScroll>
      <div className='flex flex-col gap-3 p-4'>
        <p className='text-base-content/80 text-sm leading-relaxed'>
          下面这些书，书库里已经有一本同名的了。如果这次导入的是同一个故事的新版本（换了下载来源、
          重新排版或修订过），可以选
          <span className='text-base-content font-medium'>用新版替换</span>
          ——阅读进度、书签、笔记、分组和标签都会保留到新版上；如果不是同一本书，保持
          <span className='text-base-content font-medium'>保留为两本</span>即可。
        </p>

        <div className='max-h-72 overflow-y-auto rounded-lg border border-base-300'>
          {conflicts.map((conflict, index) => {
            const choice = choices[index] ?? 'keep';
            return (
              <div
                key={conflict.incoming.hash}
                className={clsx(
                  'flex flex-col gap-2 px-3 py-3',
                  index > 0 && 'border-t border-base-300',
                )}
              >
                <div className='text-base-content text-sm font-medium'>
                  {bookLabel(conflict.incoming)}
                </div>
                <div className='text-base-content/60 text-xs leading-relaxed'>
                  书库已有：{bookLabel(conflict.existing)}
                </div>
                <div className='flex gap-2'>
                  {(
                    [
                      ['replace', '用新版替换（保留进度）'],
                      ['keep', '保留为两本'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type='button'
                      className={clsx(
                        'btn btn-sm flex-1',
                        choice === value ? 'btn-contrast' : 'btn-ghost border-base-300',
                      )}
                      onClick={() => setChoice(index, value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {conflicts.length > 1 && (
          <div className='flex items-center gap-2 text-xs'>
            <span className='text-base-content/60'>全部：</span>
            <button
              type='button'
              className='btn btn-ghost btn-xs'
              onClick={() => setAll('replace')}
            >
              都用新版替换
            </button>
            <button type='button' className='btn btn-ghost btn-xs' onClick={() => setAll('keep')}>
              都保留为两本
            </button>
          </div>
        )}

        <div className='mt-1 flex justify-end gap-2 pb-2'>
          <button type='button' className='btn btn-ghost btn-sm' onClick={onCancel}>
            取消（都保留）
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            onClick={() => onConfirm(choices)}
          >
            {replaceCount > 0 ? `替换 ${replaceCount} 本` : '确定'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default BookVersionConflictDialog;
