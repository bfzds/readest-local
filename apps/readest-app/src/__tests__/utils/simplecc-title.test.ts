import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@simplecc/simplecc_wasm', () => ({
  default: vi.fn(),
  simplecc: vi.fn(),
}));

import init, { simplecc } from '@simplecc/simplecc_wasm';
import { simplifyChineseText } from '@/utils/simplecc';

const mockInit = init as unknown as Mock;
const mockSimplecc = simplecc as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockInit.mockResolvedValue(undefined);
  mockSimplecc.mockImplementation((text: string) => text);
});

describe('simplifyChineseText', () => {
  it('converts traditional Chinese text', async () => {
    mockSimplecc.mockImplementation((text: string, variant: string) => {
      if (text === '紅樓夢') return '红楼梦';
      if (text === '葉嘉瑩') return '叶嘉莹';
      return text;
    });

    expect(await simplifyChineseText('紅樓夢')).toBe('红楼梦');
    expect(await simplifyChineseText('葉嘉瑩')).toBe('叶嘉莹');
    expect(mockInit).toHaveBeenCalled();
  });

  it('keeps already simplified text unchanged', async () => {
    expect(await simplifyChineseText('红楼梦')).toBe('红楼梦');
  });

  it('keeps non-Chinese text unchanged', async () => {
    expect(await simplifyChineseText('The Dream of the Red Chamber')).toBe(
      'The Dream of the Red Chamber',
    );
  });

  it('returns empty string unchanged', async () => {
    expect(await simplifyChineseText('')).toBe('');
  });

  it('falls back to original text when WASM init fails', async () => {
    mockInit.mockRejectedValueOnce(new Error('wasm load failed'));
    expect(await simplifyChineseText('紅樓夢')).toBe('紅樓夢');
  });
});
