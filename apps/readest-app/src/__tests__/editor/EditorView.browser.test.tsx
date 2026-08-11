/**
 * EditorView 内联编辑视图浏览器测试。
 *
 * 渲染真实组件（chromium），验证：
 * 1. 挂载后从 bookDoc 加载章节 XHTML，经 srcdoc 渲染进 iframe，
 *    编辑后可保存并回调 onSave(html)，html 包含修改后的文本。
 * 2. 取消按钮在 window.confirm 返回 true 时才调用 onCancel。
 *
 * mock useTranslation（项目惯例，见 dropdown-viewport.browser.test.tsx），
 * 否则真实 hook 会触发 i18next http-backend 初始化（网络请求），测试不稳。
 * 另外补一个 react-i18next mock：vitest-browser 的模块 mock 在组件状态更新
 * 触发的 re-render 上可能失效，兜底让真实 useTranslation 走被 stub 的
 * react-i18next（返回 identity t，且不再挂 react-i18next 内部 hook），
 * 避免 mount/update 之间 hook 数量漂移触发 React「Should have a queue」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCallback } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { EditorView } from '@/app/reader/editor/EditorView';
import { BookDoc } from '@/libs/document';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (s: string) => s }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => {
    // 与真实 useTranslation 保持一致的单 useCallback hook，避免 mount/update
    // 之间 hook 数量漂移触发 React「Should have a queue」。
    useCallback(() => {}, []);
    return (s: string) => s;
  },
}));

const sectionHtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body><p>Hello world</p><p>Second paragraph</p></body>
</html>`;

const bookDoc = {
  sections: [{ id: 'OEBPS/chapter1.xhtml', loadText: async () => sectionHtml }],
} as unknown as BookDoc;

afterEach(cleanup);

describe('EditorView', () => {
  it('loads the section and reports the edited html on save', async () => {
    const onSave = vi.fn(async (_html: string) => {});
    render(<EditorView bookDoc={bookDoc} sectionIndex={0} onSave={onSave} onCancel={() => {}} />);

    const iframe = document.querySelector('iframe')!;
    await waitFor(() => {
      expect(iframe.contentDocument?.body.textContent).toContain('Hello world');
    });

    const doc = iframe.contentDocument!;
    doc.body.querySelector('p')!.textContent = 'Edited text';

    screen.getByRole('button', { name: /Save/ }).click();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const html = onSave.mock.calls[0]![0];
    expect(html).toContain('Edited text');
  });

  it('calls cancel after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCancel = vi.fn();
    render(<EditorView bookDoc={bookDoc} sectionIndex={0} onSave={vi.fn()} onCancel={onCancel} />);

    const iframe = document.querySelector('iframe')!;
    await waitFor(() => {
      expect(iframe.contentDocument?.body.textContent).toContain('Hello world');
    });

    screen.getByRole('button', { name: /Cancel/ }).click();
    expect(onCancel).toHaveBeenCalled();
  });
});
