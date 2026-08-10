import { describe, it, expect, beforeEach } from 'vitest';
import { getEnabledProviders, __resetRegistryForTests } from '@/services/dictionaries/registry';
import type { DictionarySettings, ImportedDictionary } from '@/services/dictionaries/types';

const baseDicts: ImportedDictionary[] = [
  {
    id: 'mdict:first',
    kind: 'mdict',
    name: 'First',
    bundleDir: 'f',
    files: { mdx: 'f.mdx' },
    addedAt: 1,
  },
  {
    id: 'stardict:second',
    kind: 'stardict',
    name: 'Second',
    bundleDir: 's',
    files: { ifo: 's.ifo' },
    addedAt: 2,
  },
];

const baseSettings: DictionarySettings = {
  providerOrder: ['mdict:first', 'stardict:second'],
  providerEnabled: { 'mdict:first': true, 'stardict:second': true },
};

const fs = { openFile: async () => new File([], '') };

describe('dictionary registry', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('returns enabled imported providers in order', () => {
    const providers = getEnabledProviders({ settings: baseSettings, dictionaries: baseDicts, fs });
    expect(providers.map((p) => p.id)).toEqual(['mdict:first', 'stardict:second']);
  });

  it('skips providers explicitly disabled', () => {
    const providers = getEnabledProviders({
      settings: {
        ...baseSettings,
        providerEnabled: { ...baseSettings.providerEnabled, 'stardict:second': false },
      },
      dictionaries: baseDicts,
      fs,
    });
    expect(providers.map((p) => p.id)).toEqual(['mdict:first']);
  });

  it('honors providerOrder regardless of declaration order', () => {
    const providers = getEnabledProviders({
      settings: {
        ...baseSettings,
        providerOrder: ['stardict:second', 'mdict:first'],
      },
      dictionaries: baseDicts,
      fs,
    });
    expect(providers.map((p) => p.id)).toEqual(['stardict:second', 'mdict:first']);
  });

  it('caches the same provider instance across calls', () => {
    const a = getEnabledProviders({ settings: baseSettings, dictionaries: baseDicts, fs });
    const b = getEnabledProviders({ settings: baseSettings, dictionaries: baseDicts, fs });
    expect(a[0]).toBe(b[0]);
  });

  it('skips imported dictionaries that are unavailable, deleted, or unsupported', () => {
    const dicts: ImportedDictionary[] = [
      ...baseDicts,
      {
        id: 'mdict:gone',
        kind: 'mdict',
        name: 'Gone',
        bundleDir: 'g',
        files: { mdx: 'g.mdx' },
        addedAt: 3,
        deletedAt: 1,
      },
      {
        id: 'stardict:nope',
        kind: 'stardict',
        name: 'Nope',
        bundleDir: 'n',
        files: { ifo: 'n.ifo' },
        addedAt: 4,
        unavailable: true,
      },
      {
        id: 'mdict:unsupported',
        kind: 'mdict',
        name: 'Unsupported',
        bundleDir: 'u',
        files: { mdx: 'u.mdx' },
        addedAt: 5,
        unsupported: true,
      },
    ];
    const settings: DictionarySettings = {
      providerOrder: [
        'mdict:first',
        'stardict:second',
        'mdict:gone',
        'stardict:nope',
        'mdict:unsupported',
      ],
      providerEnabled: {
        'mdict:first': true,
        'stardict:second': true,
        'mdict:gone': true,
        'stardict:nope': true,
        'mdict:unsupported': true,
      },
    };
    const providers = getEnabledProviders({ settings, dictionaries: dicts, fs });
    expect(providers.map((p) => p.id)).toEqual(['mdict:first', 'stardict:second']);
  });
});
