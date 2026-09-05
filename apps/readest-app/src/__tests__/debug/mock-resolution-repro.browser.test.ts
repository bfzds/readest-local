/**
 * [DEBUG-mock1] Throwaway minimal repro v2: which module kinds does vi.mock
 * intercept in browser mode here? Delete after diagnosis.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { MOCKED: true }, appService: null }),
  EnvProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => {
    const t = (s: string) => `MOCKED:${s}`;
    return t as unknown as ReturnType<typeof import('@/hooks/useTranslation')['useTranslation']>;
  },
}));

vi.mock('./minimal-context', () => ({
  useMinimal: () => ({ marker: 'MOCKED' }),
}));

import { useEnv as useEnvAliased } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useMinimal } from './minimal-context';

describe('[DEBUG-mock1] vi.mock interception by module kind', () => {
  it('control: .ts module (useTranslation) is mocked', () => {
    const t = useTranslation() as unknown as (s: string) => string;
    expect(t('x')).toBe('MOCKED:x');
  });

  it('env: .tsx context (EnvContext) is mocked', () => {
    const env = useEnvAliased() as unknown as { envConfig: Record<string, unknown> };
    expect(env.envConfig).toEqual({ MOCKED: true });
  });

  it('tsx: minimal .tsx context module is mocked', () => {
    expect(useMinimal().marker).toBe('MOCKED');
  });
});
