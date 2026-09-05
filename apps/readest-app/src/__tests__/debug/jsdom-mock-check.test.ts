import { describe, it, expect, vi } from 'vitest';
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { MOCKED: true }, appService: null }),
  EnvProvider: ({ children }: { children: unknown }) => children,
}));
import { useEnv } from '@/context/EnvContext';
describe('jsdom mock check', () => {
  it('EnvContext mock applies in jsdom', () => {
    const env = useEnv() as unknown as { envConfig: Record<string, unknown> };
    expect(env.envConfig).toEqual({ MOCKED: true });
  });
});
