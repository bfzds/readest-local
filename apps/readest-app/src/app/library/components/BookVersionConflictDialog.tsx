'use client';

import * as React from 'react';
import { useState } from 'react';
import clsx from 'clsx';
import { MdArrowDownward, MdArrowUpward } from 'react-icons/md';

import Dialog from '@/components/Dialog';
import {
  Book,
  BookVersionConflictChoice,
  BookVersionConflictInfo,
  BookVersionConflictReason,
  VersionTocEntry,
} from '@/types/book';
import type { VersionComparison } from '@/services/bookVersionCompare';

type BookVersionConflictDialogProps = {
  conflicts: BookVersionConflictInfo[];
  /**
   * 每条冲突的对比数据（键为 `incoming.hash`）。缺失＝还在读缓存，弹窗先渲染
   * 不依赖对比的部分——它绝不为此去解析书文件（不变量 3）。
   */
  comparisons: Record<string, VersionComparison>;
  /**
   * 每条冲突的最终选择（顺序与 `conflicts` 一致）。取消/关闭时也走这里——全部
   * 视为 keep，让"不选择"等价于"两本都留着"这个安全默认。
   */
  onConfirm: (choices: BookVersionConflictChoice[]) => void;
  onCancel: () => void;
};

const bookLabel = (book: Book) =>
  book.author ? `《${book.title}》（${book.author}）` : `《${book.title}》`;

/** 判定依据的文案：用户要能一眼看出"为什么系统认为这两本是同一本"。 */
const REASON_LABEL: Record<BookVersionConflictReason, string> = {
  'same-identifier': '书号相同',
  'identifier-differs': '书号不同',
  'incoming-without-identifier': '导入的文件没有书号，仅同名同作者',
  'same-title-author': '同名同作者',
};

/** 书号取前 8 位——两边并列时够用来判断"是不是同一个来源"。 */
const identifierOf = (book: Book) => (book.metaHash ? book.metaHash.slice(0, 8) : '无');

const progressLabel = (book: Book) => {
  const [current, total] = book.progress ?? [];
  if (!current || !total) return '尚未开始阅读';
  return `已读到 ${Math.round((current / total) * 100)}%`;
};

const CHOICES: Array<[BookVersionConflictChoice, string]> = [
  ['replace', '用新版替换（保留进度）'],
  ['keep', '保留为两本'],
  ['discard', '撤销导入'],
];

/** 只有"变了"才画箭头：两边一样时画个等号只会增加噪音。 */
const DIRECTION_ICON: Partial<Record<'up' | 'down' | 'same', React.ReactNode>> = {
  up: <MdArrowUpward className='inline size-3 align-[-2px]' />,
  down: <MdArrowDownward className='inline size-3 align-[-2px]' />,
};

/** 目录条目按层级缩进；只展示标签，不展示链接（两侧 href 的口径不可比）。 */
const TocColumn = ({ entries }: { entries: VersionTocEntry[] }) => (
  <ul className='flex flex-col gap-0.5'>
    {entries.map((entry, index) => (
      <li
        key={`${entry.label}-${index}`}
        className='truncate'
        style={{ paddingLeft: `${entry.depth * 12}px` }}
        title={entry.label}
      >
        {entry.label}
      </li>
    ))}
  </ul>
);

/**
 * 「导入的书可能是书库里某本的旧版本」确认框。
 *
 * 只在导入已经完成、两条记录都在库里之后弹出（见 replaceBookVersion 的注释）：
 * 用户关掉窗口不做选择，结果就是两本各存一份，不会有任何数据被删除。
 *
 * 对比数据全部来自记录、nav.json 缓存、config.json 的虚拟目录，以及导入时顺带
 * 算出的值：打开这个弹窗不解析任何文件。
 */
const BookVersionConflictDialog = ({
  conflicts,
  comparisons,
  onConfirm,
  onCancel,
}: BookVersionConflictDialogProps) => {
  const [choices, setChoices] = useState<BookVersionConflictChoice[]>(() =>
    conflicts.map(() => 'keep'),
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const replaceCount = choices.filter((choice) => choice === 'replace').length;
  const discardCount = choices.filter((choice) => choice === 'discard').length;

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
          ——阅读进度、书签、笔记、分组和标签都会保留到新版上；认定不是同一本书（或这次导入的才是
          旧版）时，
          <span className='text-base-content font-medium'>保留为两本</span>或
          <span className='text-base-content font-medium'>撤销导入</span>
          都不会让书库少东西。
        </p>

        <div className='max-h-96 overflow-y-auto rounded-lg border border-base-300'>
          {conflicts.map((conflict, index) => {
            const choice = choices[index] ?? 'keep';
            const target = conflict.candidates[0];
            if (!target) return null;
            const comparison = comparisons[conflict.incoming.hash];
            const isDetailed = expanded[conflict.incoming.hash] ?? false;
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

                {/* 判定依据：两边书号并列，用户自己核对是不是同一个来源。 */}
                <div className='text-base-content/60 flex flex-col gap-0.5 text-xs leading-relaxed'>
                  <span>
                    判定依据：{REASON_LABEL[conflict.reason]} · 书号{' '}
                    {identifierOf(conflict.incoming)} / {identifierOf(target)}
                  </span>
                  <span>
                    书库已有：{bookLabel(target)} · {progressLabel(target)}
                  </span>
                  {conflict.candidates.length > 1 && (
                    <span>
                      另有 {conflict.candidates.length - 1} 本同书号记录，本次不会改动它们
                    </span>
                  )}
                </div>

                {comparison && (
                  <div className='flex flex-col gap-1.5'>
                    <table className='table-fixed w-full text-xs'>
                      <thead>
                        <tr className='text-base-content/50'>
                          <th className='w-20 text-left font-normal'> </th>
                          <th className='text-left font-normal'>书库已有</th>
                          <th className='text-left font-normal'>本次导入</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.rows.map((row) => (
                          <tr key={row.key} className='text-base-content/80'>
                            <td className='text-base-content/50 py-0.5'>{row.label}</td>
                            <td className='truncate py-0.5 pr-2' title={row.old}>
                              {row.old}
                            </td>
                            <td className='truncate py-0.5' title={row.new}>
                              {row.direction && DIRECTION_ICON[row.direction]}
                              {row.new}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {comparison.summary.length > 0 && (
                      <ul className='text-base-content/60 list-disc pl-4 text-xs leading-relaxed'>
                        {comparison.summary.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}

                    <div className='text-base-content/60 text-xs leading-relaxed'>
                      替换后会保留：阅读进度 · 书签与笔记 · 分组与标签 · 阅读状态
                    </div>

                    {comparison.sectionComparable ? (
                      <div className='flex flex-col gap-1'>
                        <button
                          type='button'
                          className='btn btn-ghost btn-xs self-start'
                          onClick={() =>
                            setExpanded((prev) => ({
                              ...prev,
                              [conflict.incoming.hash]: !isDetailed,
                            }))
                          }
                        >
                          {isDetailed ? '收起章节对比' : '展开章节对比'}
                        </button>
                        {isDetailed && (
                          <>
                            <div className='flex gap-3 text-xs'>
                              <div className='min-w-0 flex-1'>
                                <div className='text-base-content/50 mb-0.5'>
                                  书库已有（阅读器缓存的目录）
                                </div>
                                <TocColumn entries={comparison.oldToc ?? []} />
                              </div>
                              <div className='min-w-0 flex-1'>
                                <div className='text-base-content/50 mb-0.5'>
                                  本次导入（文件自带目录）
                                </div>
                                <TocColumn entries={comparison.newToc ?? []} />
                              </div>
                            </div>
                            <p className='text-base-content/50 leading-relaxed'>
                              两侧目录的出入口不同（旧侧来自阅读器缓存），条目数可能只是口径差异；目录
                              元数据不完整的书（条目是「信息」「目录」这类文件级项）这里比的只是条目数，
                              不保证逐条对应。真正的"哪边更新"看正文字数更可靠。
                            </p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className='text-base-content/50 text-xs leading-relaxed'>
                        {comparison.sectionNote}
                      </div>
                    )}
                  </div>
                )}

                <div className='flex gap-2'>
                  {CHOICES.map(([value, label]) => (
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
          <div className='flex flex-wrap items-center gap-2 text-xs'>
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
            <button
              type='button'
              className='btn btn-ghost btn-xs'
              onClick={() => setAll('discard')}
            >
              都撤销导入
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
            {replaceCount > 0 || discardCount > 0
              ? `确定（替换 ${replaceCount} · 撤销 ${discardCount}）`
              : '确定'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default BookVersionConflictDialog;
