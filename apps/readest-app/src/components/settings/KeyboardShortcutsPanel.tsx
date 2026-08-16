import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { isMacPlatform } from '@/services/environment';
import {
  ShortcutConfig,
  ShortcutEntry,
  SHORTCUT_SECTIONS,
  loadShortcuts,
  saveShortcuts,
  getDefaultShortcutKeys,
  resetShortcuts,
} from '@/helpers/shortcuts';
import { filterPlatformKeys, formatKeyForDisplay } from '@/utils/shortcutKeys';
import {
  buildShortcutFromKeyEvent,
  findConflictingActions,
  findKeyConflicts,
} from '@/utils/shortcutRecorder';
import { BoxedList, SettingsRow, Tips } from './primitives';
import { SettingsPanelPanelProp } from './SettingsDialog';

const KeyboardShortcutsPanel: React.FC<SettingsPanelPanelProp> = ({ onRegisterReset }) => {
  const _ = useTranslation();
  const isMac = isMacPlatform();
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(loadShortcuts);
  const [recordingKey, setRecordingKey] = useState<keyof ShortcutConfig | null>(null);
  const [conflictDescription, setConflictDescription] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Any save/reset (including from outside this panel) refreshes the list.
  useEffect(() => {
    const handleUpdate = () => setShortcuts(loadShortcuts());
    window.addEventListener('shortcutUpdate', handleUpdate);
    return () => window.removeEventListener('shortcutUpdate', handleUpdate);
  }, []);

  useEffect(() => {
    onRegisterReset(() => resetShortcuts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyKeys = (actionKey: keyof ShortcutConfig, newKeys: string[]) => {
    // Build a fresh config instead of mutating the shallow copy returned by
    // loadShortcuts — its per-action objects alias DEFAULT_SHORTCUTS, so a
    // direct assignment would corrupt the defaults.
    const current = loadShortcuts();
    const next: ShortcutConfig = {
      ...current,
      [actionKey]: { ...current[actionKey], keys: newKeys },
    };
    saveShortcuts(next); // dispatches shortcutUpdate, which refreshes state
  };

  const startRecording = (actionKey: keyof ShortcutConfig) => {
    setRecordingKey(actionKey);
    setConflictDescription(null);
    // focus after render so autoFocus on the fresh input wins
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const stopRecording = () => {
    setRecordingKey(null);
    setConflictDescription(null);
  };

  // 录制按键必须挂 input 的原生 keydown listener：SettingsDialog 的 Dialog
  // 组件在 dialog 元素上有原生 Esc 监听（dialogRef.addEventListener），它在
  // 事件冒泡到 dialog 时先于 React 合成 onKeyDown（#root 处理）触发，录制时
  // 按 Esc 会先关掉设置对话框而非注销绑定。原生 listener 在 target（input）
  // 最早触发，stopPropagation 可阻止冒泡到 dialog。
  useEffect(() => {
    const input = inputRef.current;
    if (!input || !recordingKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      event.preventDefault();

      if (event.key === 'Escape') {
        // Esc 注销当前绑定（面板显示为未绑定），Backspace 行为相同；仅退出
        // 录制不改动则靠 input 失焦（onBlur）。
        applyKeys(recordingKey, []);
        stopRecording();
        return;
      }
      if (event.key === 'Backspace') {
        applyKeys(recordingKey, []);
        stopRecording();
        return;
      }

      const shortcut = buildShortcutFromKeyEvent(event, isMac);
      if (!shortcut) return; // modifier-only press, keep waiting

      const conflicts = findConflictingActions(shortcuts, recordingKey, [shortcut]);
      if (conflicts.length > 0 && conflicts[0]) {
        setConflictDescription(conflicts[0].description);
        return; // stay in recording mode so the user can pick another key
      }

      applyKeys(recordingKey, [shortcut]);
      stopRecording();
    };
    input.addEventListener('keydown', handleKeyDown);
    return () => input.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingKey]);

  const platformKeys = (keys: string[]) => filterPlatformKeys(keys, isMac);

  const isDefaultKeys = (actionKey: keyof ShortcutConfig, keys: string[]) => {
    const a = platformKeys(keys);
    const b = platformKeys(getDefaultShortcutKeys(actionKey));
    return [...a].sort().join('|') === [...b].sort().join('|');
  };

  return (
    <div className='my-4 w-full space-y-6'>
      {SHORTCUT_SECTIONS.map((section) => {
        const entries = (
          Object.entries(shortcuts) as [keyof ShortcutConfig, ShortcutEntry][]
        ).filter(([, entry]) => entry.section === section);
        if (entries.length === 0) return null;
        return (
          <BoxedList
            key={section}
            title={_(section)}
            data-setting-id={`settings.keyboard.${section}`}
          >
            {entries.map(([actionKey, entry]) => {
              const keys = platformKeys(entry.keys);
              const isRecording = recordingKey === actionKey;
              return (
                <SettingsRow
                  key={actionKey}
                  label={_(entry.description)}
                  description={
                    isRecording && conflictDescription
                      ? _('Used by {{action}}', { action: conflictDescription })
                      : undefined
                  }
                  data-setting-id={`settings.keyboard.${actionKey}`}
                >
                  {isRecording ? (
                    <input
                      ref={inputRef}
                      readOnly
                      autoFocus
                      placeholder={_('Press new shortcut')}
                      className='input input-bordered input-sm w-44 text-sm'
                      onBlur={stopRecording}
                    />
                  ) : (
                    <div className='flex items-center gap-2'>
                      {keys.length === 0 ? (
                        <span className='text-base-content/50 text-sm'>{_('No shortcut')}</span>
                      ) : (
                        <div className='flex shrink-0 gap-1'>
                          {keys.map((key) => {
                            const conflicts = findKeyConflicts(shortcuts, actionKey, key);
                            const hasConflict = conflicts.length > 0;
                            return (
                              <kbd
                                key={key}
                                className={clsx(
                                  'inline-flex items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-medium shadow-sm',
                                  hasConflict
                                    ? 'border-red-500/50 bg-red-500/10 text-red-500'
                                    : 'border-base-300/40 bg-base-300/75 text-neutral-content',
                                )}
                                title={
                                  hasConflict
                                    ? _('Shared with {{action}}', {
                                        action: _(conflicts[0]!.description),
                                      })
                                    : undefined
                                }
                              >
                                {formatKeyForDisplay(key, isMac)}
                              </kbd>
                            );
                          })}
                        </div>
                      )}
                      <button
                        className='btn btn-ghost btn-sm px-2'
                        onClick={() => startRecording(actionKey)}
                      >
                        {_('Edit')}
                      </button>
                      {!isDefaultKeys(actionKey, entry.keys) && (
                        <button
                          className='btn btn-ghost btn-sm px-2'
                          title={_('Restore Default')}
                          onClick={() => applyKeys(actionKey, getDefaultShortcutKeys(actionKey))}
                        >
                          {_('Restore Default')}
                        </button>
                      )}
                    </div>
                  )}
                </SettingsRow>
              );
            })}
          </BoxedList>
        );
      })}
      <Tips title={_('Record Shortcuts')}>
        <li>
          {_('Click Edit, then press the new key combination. Esc cancels, Backspace clears.')}
        </li>
      </Tips>
    </div>
  );
};

export default KeyboardShortcutsPanel;
