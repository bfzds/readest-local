import { describe, it, expect } from 'vitest';
import { getTauri, invoke } from './tauri-invoke';

describe('Tauri Smoke Tests', () => {
  it('should have __TAURI_INTERNALS__ available via window.top', () => {
    const tauri = getTauri();
    expect(tauri).toBeDefined();
    expect(typeof tauri.invoke).toBe('function');
  });

  it('should invoke get_executable_dir', async () => {
    const execDir = (await invoke('get_executable_dir')) as string;
    expect(typeof execDir).toBe('string');
    expect(execDir.length).toBeGreaterThan(0);
  });

  it('white-lists only env vars the app actually consumes (S-4)', async () => {
    // 未白名单变量一律返回空字符串，杜绝任意 env 可读面。
    const home = (await invoke('get_environment_variable', { name: 'HOME' })) as string;
    expect(home).toBe('');
    const pathVar = (await invoke('get_environment_variable', { name: 'PATH' })) as string;
    expect(pathVar).toBe('');
    const custom = (await invoke('get_environment_variable', {
      name: '__TAURI_SMOKE_TEST_NONEXISTENT__',
    })) as string;
    expect(custom).toBe('');
  });

  it('returns values for allowlisted env vars (Gamescope detection)', async () => {
    const desktop = (await invoke('get_environment_variable', {
      name: 'XDG_CURRENT_DESKTOP',
    })) as string;
    expect(typeof desktop).toBe('string');
    const gamescope = (await invoke('get_environment_variable', {
      name: 'GAMESCOPE_WAYLAND_DISPLAY',
    })) as string;
    expect(typeof gamescope).toBe('string');
  });

  it('should get executable dir that contains the app name', async () => {
    const execDir = (await invoke('get_executable_dir')) as string;
    expect(execDir.toLowerCase()).toMatch(/readest|target/);
  });
});
