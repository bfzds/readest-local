# Reader backup preferences audit

> Date: 2026-08-11
> Scope: whether library backup/restore persists reader font and theme preferences.

## Current behavior

The library backup zip always contains a sanitized `settings.json`
(`apps/readest-app/src/services/backupService.ts`). Restore reads that file,
deep-merges it onto the current device settings, and persists the result via
`appService.saveSettings`.

The reader preferences live in `SystemSettings`:

- Fonts: `globalViewSettings.defaultFont`, `serifFont`, `sansSerifFont`,
  `defaultFontSize`, `minimumFontSize`, `lineHeight`, and related fields.
- Theme: `globalViewSettings.theme`, `backgroundTextureId`,
  `backgroundOpacity`, `backgroundSize`, plus
  `globalReadSettings.customThemes`.
- Custom entries: `customFonts` and `customTextures` metadata.

None of these fields are in `BACKUP_SETTINGS_BLACKLIST`, so their values
already travel with the backup.

## Gaps found

1. After a restore, `BackupWindow` refreshed the library state but not the
   in-memory settings store. The restored preferences were written to disk,
   but the current session could keep showing the old settings until restart.
2. The backup settings tests covered `customThemes` and `userStylesheet`, but
   not the concrete font and theme fields listed above.

## Changes

- `BackupWindow.tsx`: after a successful restore, reload settings through
  `appService.loadSettings()` and push them into `useSettingsStore`.
- `backup-settings.test.ts`: assert that font/theme preference fields survive
  sanitization and restore through `mergeRestoredSettings`.

## Verification

- Backup service tests: 75 tests pass across the four backup test files.
- `tsgo --noEmit` passes; biome check passes for the touched files.

## Boundary

`settings.json` stores preference values and custom entry metadata, but the
backup zip does not include the binary files behind custom fonts or custom
background textures (they live outside the Books directory). On a fresh
device, restored custom entries may be marked unavailable until those files
are re-imported. Built-in fonts, themes, colors, font size, and line spacing
restore fully.
