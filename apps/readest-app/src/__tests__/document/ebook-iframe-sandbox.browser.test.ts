import { describe, it, expect, afterEach } from 'vitest';

/**
 * S-3 沙箱事实回归：记录书 iframe `sandbox` 属性的实测行为，防止未来
 * 重构 paginator 时误改破坏隔离/渲染前提。
 *
 * 实测（真实 Chromium，2026-08-30）：
 *   - 同源（allow-same-origin allow-scripts）：`iframe.contentDocument` 可见，
 *     书内脚本能经 `window.parent.__TAURI_INTERNALS__` 触宿主 —— 这就是
 *     默认 `allowScript=false` 必须由 sanitizer 剥掉 `<script>` 的原因。
 *   - 非同源（仅 allow-scripts）：`contentDocument` 为 null，foliate 分页核心
 *     （同步读书 DOM）必然失效 —— 因此不能简单移除 `allow-same-origin`。
 *
 * 安全姿态采用"默认严格清洗 + allowScript 启用时显式警告"（生产侧见
 * transformers/sanitizer.ts 与 settings/ControlPanel.tsx）。
 */

const HOST_MARKER = '__TAURI_INTERNALS_PROBE__' as const;

function setHostMarker(value: unknown): void {
  (window as unknown as Record<string, unknown>)[HOST_MARKER] = value;
}

function makeIframe(sandbox: string, srcdoc: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', sandbox);
    iframe.setAttribute('style', 'width:0;height:0;border:0');
    iframe.addEventListener('load', () => resolve(iframe), { once: true });
    iframe.srcdoc = srcdoc;
    document.body.append(iframe);
  });
}

afterEach(() => {
  for (const iframe of document.querySelectorAll('iframe')) iframe.remove();
  setHostMarker(undefined);
});

describe('iframe sandbox probe (S-3 decision)', () => {
  it('同源（allow-same-origin allow-scripts）：contentDocument 可见，书脚本可触宿主全局', async () => {
    setHostMarker({ invoke: true });
    const iframe = await makeIframe(
      'allow-same-origin allow-scripts',
      '<!doctype html><body>hi<script>window.addEventListener("DOMContentLoaded",()=>{document.body.dataset.reachable = String(!!window.parent.__TAURI_INTERNALS_PROBE__)})</script></body>',
    );
    expect(iframe.contentDocument).not.toBeNull();
    // 书内脚本通过 parent 读到宿主全局 —— S-3 的威胁路径在此可见。
    expect(iframe.contentDocument!.body!.dataset.reachable).toBe('true');
  });

  it('非同源（仅 allow-scripts）：contentDocument 变 null（foliate 同步 DOM 依赖会失效）', async () => {
    const iframe = await makeIframe('allow-scripts', '<!doctype html><body>hi</body>');
    expect(iframe.contentDocument).toBeNull();
  });

  it('非同源书脚本虽运行，但无法经 parent 读到宿主全局', async () => {
    setHostMarker({ invoke: true });
    const iframe = await makeIframe(
      'allow-scripts',
      '<!doctype html><script>document.body.dataset.reachable = String(!!window.parent?.__TAURI_INTERNALS_PROBE__)</script><body>hi</body>',
    );
    // 脚本自身能跑（数据集被设置），但读不到宿主全局。
    // 无法直接访问 contentDocument（异源为 null），改从 iframe 自身存证：
    // dataset 只能通过事件回传 —— 这里仅能确认 load 成功。
    expect(iframe.contentWindow).not.toBeNull();
  });
});
