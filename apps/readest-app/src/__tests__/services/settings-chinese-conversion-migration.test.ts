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
