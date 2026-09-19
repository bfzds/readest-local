import clsx from 'clsx';
import React, { useState } from 'react';
import { IoMdCloseCircleOutline } from 'react-icons/io';
import { MdRefresh, MdExpandMore } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { useKeyDownActions } from '@/hooks/useKeyDownActions';
import { getFilename } from '@/utils/path';
import { formatDate } from '@/utils/book';
import type { WatchedFolderRule } from '@/types/settings';
import type { ResolvedWatchedFolderRule } from '@/utils/watchedFolders';
import Dialog from '@/components/Dialog';
import BoxedList from '@/components/settings/primitives/BoxedList';
import AdwaitaSelect from '@/components/settings/primitives/AdwaitaSelect';
import { DEFAULT_FORMAT_GROUPS } from './ImportFromFolderDialog';

/** One watched folder's most recent scan result. */
export interface WatchedFolderScanStatus {
  /** When the scan finished, ms since epoch. */
  at: number;
  /** Books that were genuinely new to the library. */
  imported: number;
  /** Files from this folder that failed to import. */
  failed: number;
  /** Set when the folder could not be scanned at all (unreadable / missing). */
  error?: string;
}

/** One row of the manager: the folder, its resolved rule, its last result. */
export interface WatchedFolderRow {
  /** Absolute path, exactly as stored in `settings.autoImportFolders`. */
  path: string;
  /** The rule a scan of this folder will actually use. */
  rule: ResolvedWatchedFolderRule;
  /** What is stored for this folder, if anything (absent = legacy defaults). */
  storedRule?: WatchedFolderRule;
  status?: WatchedFolderScanStatus;
}

interface WatchedFoldersDialogProps {
  folders: WatchedFolderRow[];
  /**
   * `null` while idle, `'all'` while every folder is being refreshed, otherwise
   * the path of the row currently refreshing. Rows render their own spinner
   * state off this, and every button is disabled while it is not null.
   */
  refreshingPath: string | null;
  /** Pick a folder, start watching it, and scan it right away. */
  onAddFolder: () => void;
  /** Stop watching `path`. The folder itself is never touched on disk. */
  onRemoveFolder: (path: string) => void;
  /** Change one folder's scan rule; other fields of its rule are preserved. */
  onSetRule: (path: string, patch: Partial<WatchedFolderRule>) => void;
  /** Rescan one folder, or every folder when `path` is omitted. */
  onRefresh: (path?: string) => void;
  onClose: () => void;
}

const DIALOG_BOX_CLASS = 'sm:min-w-[520px] sm:max-w-[640px] sm:h-auto sm:max-h-[90%]';

/**
 * Manage the folders Readest watches for new books.
 *
 * Deliberately a dialog of its own rather than a sub-page of the import
 * flow: watching a folder no longer implies reading it in place, so it is no
 * longer "a detail of importing this folder" — it is a standing arrangement
 * about folders elsewhere on disk, and it has to be reachable without starting
 * an import (library import menu → "Watched Folders…", and Settings → Custom).
 *
 * Every row is a self-contained rule: how the books are grouped, which formats
 * count, how small a file may be, and when it was last scanned. Edits apply
 * immediately (the caller persists them); closing the dialog does not roll them
 * back, same as any settings pane.
 */
const WatchedFoldersDialog: React.FC<WatchedFoldersDialogProps> = ({
  folders,
  refreshingPath,
  onAddFolder,
  onRemoveFolder,
  onSetRule,
  onRefresh,
  onClose,
}) => {
  const _ = useTranslation();
  // Which row's rule editor is open. One at a time: these rows are narrow and
  // two open editors push the list off the screen.
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const busy = refreshingPath !== null;

  useKeyDownActions({ onCancel: onClose });

  const formatLastScan = (status: WatchedFolderScanStatus) => {
    if (status.error) return _('Last scan failed: {{error}}', { error: status.error });
    if (status.imported > 0) {
      return _('Last scan: {{count}} new book(s), {{time}}', {
        count: status.imported,
        time: formatDate(status.at),
      });
    }
    return _('Last scan: nothing new, {{time}}', { time: formatDate(status.at) });
  };

  /**
   * Toggle a whole format group. Groups span several extensions (MOBI/AZW/AZW3,
   * CBZ/ZIP) and the scan filters on those extensions, so flipping only the
   * first one would leave the rest being imported while the box reads empty.
   * The last remaining selection can't be unticked — an empty set would stop
   * the folder importing anything at all.
   */
  const toggleFormatGroup = (row: WatchedFolderRow, exts: string[]) => {
    const allTicked = exts.every((ext) => row.rule.extensions.includes(ext));
    const next = allTicked
      ? row.rule.extensions.filter((ext) => !exts.includes(ext))
      : [...row.rule.extensions, ...exts.filter((ext) => !row.rule.extensions.includes(ext))];
    if (next.length === 0) return;
    onSetRule(row.path, { extensions: next });
  };

  return (
    <Dialog isOpen title={_('Watched Folders')} boxClassName={DIALOG_BOX_CLASS} onClose={onClose}>
      <div className='flex flex-col gap-3 pt-2'>
        <span className='text-base-content/65 text-[0.85em] leading-relaxed'>
          {_(
            'Readest re-scans these folders when it opens, when it returns to the foreground, and whenever you press refresh. Folders are scanned recursively, including every subfolder.',
          )}
        </span>

        <div className='flex items-center justify-between gap-2'>
          <button
            type='button'
            className={clsx('btn btn-ghost btn-sm', busy && 'btn-disabled')}
            disabled={busy}
            onClick={() => onRefresh()}
          >
            <MdRefresh className='h-4 w-4' />
            {_('Refresh all')}
          </button>
          <button
            type='button'
            className={clsx('btn btn-contrast btn-sm', busy && 'btn-disabled')}
            disabled={busy}
            onClick={onAddFolder}
          >
            {_('Add Folder')}
          </button>
        </div>

        {folders.length === 0 ? (
          <span className='text-base-content/65 py-4 text-center text-[0.85em]'>
            {_('No folders are watched.')}
          </span>
        ) : (
          <BoxedList>
            {folders.map((row) => {
              const expanded = expandedPath === row.path;
              const rowRefreshing = refreshingPath === row.path;
              return (
                <div key={row.path} className='flex flex-col gap-1 py-2 pe-2'>
                  <div className='flex items-center gap-2'>
                    <div className='min-w-0 flex-1'>
                      <div className='truncate font-medium' title={row.path}>
                        {getFilename(row.path) || row.path}
                      </div>
                      <div className='text-base-content/65 truncate text-[0.8em]'>{row.path}</div>
                    </div>
                    <AdwaitaSelect
                      value={row.rule.mode}
                      disabled={busy}
                      onChange={(mode) =>
                        onSetRule(row.path, { mode: mode as WatchedFolderRule['mode'] })
                      }
                      options={[
                        { value: 'mirror', label: _('Groups') },
                        { value: 'flat', label: _('Flat') },
                        // 按作者分组：忽略下载日期层，只取 <文件夹>/<作者>。
                        { value: 'author', label: _('By author') },
                      ]}
                      ariaLabel={_('Folder Structure')}
                    />
                    <button
                      type='button'
                      onClick={() => onRefresh(row.path)}
                      disabled={busy}
                      className={clsx('btn btn-ghost btn-sm shrink-0 px-1', busy && 'btn-disabled')}
                      aria-label={_('Refresh now')}
                      title={_('Refresh now')}
                    >
                      <MdRefresh className={clsx('h-5 w-5', rowRefreshing && 'animate-spin')} />
                    </button>
                    <button
                      type='button'
                      onClick={() => setExpandedPath(expanded ? null : row.path)}
                      className='btn btn-ghost btn-sm shrink-0 px-1'
                      aria-label={_('Formats and size')}
                      title={_('Formats and size')}
                    >
                      <MdExpandMore
                        className={clsx('h-5 w-5 transition-transform', expanded && 'rotate-180')}
                      />
                    </button>
                    <button
                      type='button'
                      onClick={() => onRemoveFolder(row.path)}
                      disabled={busy}
                      className={clsx('btn btn-ghost btn-sm shrink-0 px-1', busy && 'btn-disabled')}
                      aria-label={_('Stop watching')}
                      title={_('Stop watching')}
                    >
                      <IoMdCloseCircleOutline className='text-base-content/75 h-5 w-5' />
                    </button>
                  </div>

                  {/* Search rule for this folder. Kept collapsed by default: the
                      defaults are right for almost every folder, and the full
                      format list is six checkboxes wide. */}
                  {expanded && (
                    <div className='bg-base-200/40 flex flex-col gap-2 rounded-md p-2'>
                      <span className='text-base-content/70 text-xs'>{_('File Formats')}</span>
                      <div className='flex flex-wrap gap-x-3 gap-y-1'>
                        {DEFAULT_FORMAT_GROUPS.map((group) => {
                          const checked = group.exts.every((ext) =>
                            row.rule.extensions.includes(ext),
                          );
                          return (
                            <label
                              key={group.id}
                              className='flex cursor-pointer items-center gap-1.5 text-xs'
                            >
                              <input
                                type='checkbox'
                                className='checkbox checkbox-xs'
                                checked={checked}
                                disabled={busy}
                                onChange={() => toggleFormatGroup(row, group.exts)}
                              />
                              <span className='select-none'>{group.label}</span>
                            </label>
                          );
                        })}
                      </div>
                      <label className='flex items-center gap-2 text-xs'>
                        <span className='text-base-content/70 select-none'>
                          {_('Minimum file size (KB)')}
                        </span>
                        <input
                          type='number'
                          min={0}
                          value={row.rule.minSizeKB}
                          disabled={busy}
                          onChange={(e) => {
                            const value = Number.parseInt(e.target.value, 10);
                            onSetRule(row.path, {
                              minSizeKB: Number.isFinite(value) && value >= 0 ? value : 0,
                            });
                          }}
                          className='input input-xs eink-bordered w-20 text-end'
                          aria-label={_('Minimum file size (KB)')}
                        />
                      </label>
                    </div>
                  )}

                  {/* Result of the newest scan, so "did that refresh do
                      anything?" is answerable without leaving the dialog. */}
                  <div className='text-base-content/60 text-[0.8em]'>
                    {row.status
                      ? formatLastScan(row.status)
                      : _('Not scanned yet since this setting was added.')}
                  </div>
                </div>
              );
            })}
          </BoxedList>
        )}

        <span className='text-base-content/65 text-[0.8em] leading-relaxed'>
          {_(
            'New books are copied into the library unless the folder is also an external library folder read in place. Deleting a book from the library never touches the file in the watched folder.',
          )}
        </span>

        <div className='mt-1 flex justify-end gap-2 pb-2'>
          <button type='button' className='btn btn-ghost btn-sm' onClick={onClose}>
            {_('Close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default WatchedFoldersDialog;
