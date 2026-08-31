import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S-4：能力清单快照——防止后续提交无意扩大危险权限面（泛化 shell、temp 全放行）。
describe('capability scope snapshot', () => {
  const raw = readFileSync(join(__dirname, '../../../src-tauri/capabilities/default.json'), 'utf8');
  const json = JSON.parse(raw) as { permissions: Array<string | { identifier?: string }> };

  it('does not grant generic shell spawn', () => {
    expect(JSON.stringify(json.permissions)).not.toContain('shell:allow-spawn');
    expect(JSON.stringify(json.permissions)).not.toContain('"shell"');
  });

  it('does not blanket-allow the system temp directory', () => {
    expect(JSON.stringify(json.permissions)).not.toContain('$TEMP');
  });

  it('keeps shell out of any scoped command list', () => {
    for (const p of json.permissions) {
      const id = typeof p === 'string' ? p : (p.identifier ?? '');
      expect(id.startsWith('shell:')).toBe(false);
    }
  });
});
