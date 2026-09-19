import { SUPPORTED_BOOK_EXTS } from '@/services/constants';
import type { SystemSettings, WatchedFolderMode, WatchedFolderRule } from '@/types/settings';

/**
 * Default minimum file size a watched-folder scan applies when the folder's own
 * rule does not record one. Matches the Import-from-Folder dialog's default, so
 * a folder watched through the dialog behaves identically before and after the
 * per-folder rule is stored.
 */
export const DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB = 20;

const WATCHED_FOLDER_MODES: WatchedFolderMode[] = ['mirror', 'flat', 'author'];

/** Narrow a stored / persisted value to a mode, rejecting stale or dirty data. */
export const isWatchedFolderMode = (mode: unknown): mode is WatchedFolderMode =>
  WATCHED_FOLDER_MODES.includes(mode as WatchedFolderMode);

/**
 * Normalize a path for matching a settings entry against a scanned path the
 * same way the library page's own `normalizeRoot` does: backslashes to slashes,
 * trailing slashes stripped. No case folding — entries are stored verbatim and
 * every other comparison in the app (in-place roots, watched roots) matches
 * them the same way, so folding here alone would make the two disagree.
 */
export function normalizeWatchedFolderPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** A folder's rule with every optional field filled in — what a scan needs. */
export interface ResolvedWatchedFolderRule {
  mode: WatchedFolderMode;
  /** Never empty. */
  extensions: string[];
  minSizeKB: number;
}

const isUsableMode = isWatchedFolderMode;

const resolveFilters = (rule: WatchedFolderRule | undefined) => {
  const extensions =
    rule?.extensions && rule.extensions.length > 0
      ? [...rule.extensions]
      : [...SUPPORTED_BOOK_EXTS];
  const minSizeKB =
    typeof rule?.minSizeKB === 'number' && Number.isFinite(rule.minSizeKB) && rule.minSizeKB >= 0
      ? rule.minSizeKB
      : DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB;
  return { extensions, minSizeKB };
};

/**
 * The effective rule for one watched folder.
 *
 * Resolution order:
 *   1. `settings.autoImportFolderRules[path]` when present — the whole rule.
 *   2. Otherwise the legacy `settings.autoImportFlattenFolders` array decides
 *      between `flat` and `mirror`, with default filters.
 *
 * Both keys and the queried path are normalized before comparison, because the
 * settings store keeps the path exactly as the folder picker returned it. A
 * folder watched before the rules map existed therefore resolves to `mirror`
 * plus `SUPPORTED_BOOK_EXTS` plus 20 KB — byte-for-byte what the scan used
 * before per-folder rules existed, which is the property this function has to
 * keep.
 */
export function resolveWatchedFolderRule(
  path: string,
  settings: Pick<SystemSettings, 'autoImportFolderRules' | 'autoImportFlattenFolders'>,
): ResolvedWatchedFolderRule {
  const target = normalizeWatchedFolderPath(path);
  const rules = settings.autoImportFolderRules ?? {};
  let stored: WatchedFolderRule | undefined;
  for (const [key, rule] of Object.entries(rules)) {
    if (rule && normalizeWatchedFolderPath(key) === target) {
      stored = rule;
      break;
    }
  }

  const { extensions, minSizeKB } = resolveFilters(stored);
  if (stored) {
    return { mode: isUsableMode(stored.mode) ? stored.mode : 'mirror', extensions, minSizeKB };
  }

  const flattened = settings.autoImportFlattenFolders ?? [];
  const flat = flattened.some((entry) => normalizeWatchedFolderPath(entry) === target);
  return { mode: flat ? 'flat' : 'mirror', extensions, minSizeKB };
}

/**
 * The rule a folder-import batch groups by: the one the import dialog just used
 * when the caller passed it, otherwise whatever is stored for the folder.
 *
 * The batch's own rule must win. "Import this folder" without ticking the watch
 * box persists nothing (there is no watched folder to attach a rule to), so
 * resolving from settings alone would silently ignore the structure the user
 * just picked — books would arrive mirrored while the dialog promised
 * `<folder>/<author>`.
 */
export const resolveImportBatchFolderRule = (
  batchRule: WatchedFolderRule | undefined,
  basePath: string,
  settings: Pick<SystemSettings, 'autoImportFolderRules' | 'autoImportFlattenFolders'>,
): WatchedFolderRule => batchRule ?? resolveWatchedFolderRule(basePath, settings);

/**
 * Whether an import should record its format/size choice into the folder's
 * rule, or leave the folder's own resolved rule alone.
 *
 * The case this exists for: a folder watched before per-folder rules existed
 * has no stored rule and resolves to the full `SUPPORTED_BOOK_EXTS` list — a
 * list the dialog cannot express, because its checkboxes work in format groups
 * and no group carries `md`. Writing back an *untouched* selection would
 * therefore silently drop `md` from that folder's scans. When the selection is
 * exactly what the folder already resolves to there is nothing to record.
 *
 * Anything else is recorded: a folder that has a rule to update, and any
 * folder whose selection actually differs from its resolved defaults.
 */
export const shouldRecordWatchedFilters = (opts: {
  hasStoredRule: boolean;
  /** Format groups the folder's resolved rule covers. */
  resolvedGroupIds: string[];
  resolvedMinSizeKB: number;
  /** Format groups the user just confirmed. */
  selectionGroupIds: string[];
  selectionMinSizeKB: number;
}): boolean => {
  if (opts.hasStoredRule) return true;
  const key = (ids: string[]) => [...ids].sort().join('\n');
  if (key(opts.resolvedGroupIds) !== key(opts.selectionGroupIds)) return true;
  return opts.resolvedMinSizeKB !== opts.selectionMinSizeKB;
};

/**
 * The extension list to record for a folder whose format choice was just
 * confirmed.
 *
 * The dialog works in format groups, so its selection can only speak for the
 * extensions those groups contain. A folder's rule may legitimately hold more
 * than that — `SUPPORTED_BOOK_EXTS` carries `md`, which no group covers — and
 * writing the groups' extensions alone would silently drop them. Extensions the
 * dialog cannot express are therefore carried over from what the folder already
 * resolves to; extensions it *can* express follow the user's selection, so
 * unticking a group still removes its extensions.
 */
export const mergeRecordedExtensions = (opts: {
  /** Extensions the dialog's ticked groups add up to. */
  selectionExtensions: string[];
  /** Extensions the folder already scans. */
  resolvedExtensions: string[];
  /** Every extension any format group covers. */
  groupExtensions: string[];
}): string[] => {
  const inGroup = new Set(opts.groupExtensions.map((ext) => ext.toLowerCase()));
  const recorded = [...opts.selectionExtensions];
  const seen = new Set(recorded.map((ext) => ext.toLowerCase()));
  for (const ext of opts.resolvedExtensions) {
    const key = ext.toLowerCase();
    if (inGroup.has(key) || seen.has(key)) continue;
    seen.add(key);
    recorded.push(ext);
  }
  return recorded;
};

/**
 * Read the stored rule for `path`, or `undefined` when the folder has none.
 * The manager UI needs the raw shape (not the resolved one) so it can show an
 * empty "formats" field for a folder that never recorded any.
 */
export function findStoredWatchedFolderRule(
  path: string,
  settings: Pick<SystemSettings, 'autoImportFolderRules'>,
): WatchedFolderRule | undefined {
  const target = normalizeWatchedFolderPath(path);
  const rules = settings.autoImportFolderRules ?? {};
  for (const [key, rule] of Object.entries(rules)) {
    if (rule && normalizeWatchedFolderPath(key) === target) return rule;
  }
  return undefined;
}

/**
 * Write `rule` for `path` into a copy of the rules map, replacing any entry
 * that normalizes to the same folder. The path is stored under the caller's
 * original spelling (first key wins), so the map stays readable next to
 * `autoImportFolders`.
 */
export function withWatchedFolderRule(
  rules: Record<string, WatchedFolderRule> | undefined,
  path: string,
  rule: WatchedFolderRule,
): Record<string, WatchedFolderRule> {
  const target = normalizeWatchedFolderPath(path);
  const next: Record<string, WatchedFolderRule> = {};
  let existingKey: string | undefined;
  for (const [key, value] of Object.entries(rules ?? {})) {
    if (normalizeWatchedFolderPath(key) === target) {
      existingKey ??= key;
      continue;
    }
    next[key] = value;
  }
  next[existingKey ?? path] = rule;
  return next;
}

/** Drop `path`'s rule, keyed by the same normalized comparison. */
export function withoutWatchedFolderRule(
  rules: Record<string, WatchedFolderRule> | undefined,
  path: string,
): Record<string, WatchedFolderRule> {
  const target = normalizeWatchedFolderPath(path);
  const next: Record<string, WatchedFolderRule> = {};
  for (const [key, value] of Object.entries(rules ?? {})) {
    if (normalizeWatchedFolderPath(key) === target) continue;
    next[key] = value;
  }
  return next;
}
