import { describe, it, expect, afterEach } from 'vitest';
import { handleContextMenu } from '@/app/reader/utils/iframeEventHandlers';

afterEach(() => {
  document.body.innerHTML = '';
});

// EPUB/PDF 正文在 FoliateViewer 的 iframe 内，contextmenu 事件不跨文档冒泡到
// 父 window（useSuppressDefaultContextMenu 只监听父 window），故 iframe 内容
// 文档需独立挂监听。这里验证 handleContextMenu 的放行/屏蔽规则。
const setupIframeDoc = (): Document => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = '<div data-testid="blank">blank</div>';
  return doc;
};

describe('handleContextMenu (iframe 内右键菜单屏蔽)', () => {
  it('空白处右键 → preventDefault（屏蔽浏览器菜单）', () => {
    const doc = setupIframeDoc();
    doc.addEventListener('contextmenu', handleContextMenu.bind(null, 'book-1'));

    const el = doc.querySelector('[data-testid="blank"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
  });

  it('iframe 内 input 保持原生菜单', () => {
    const doc = setupIframeDoc();
    doc.addEventListener('contextmenu', handleContextMenu.bind(null, 'book-1'));
    doc.body.innerHTML = '<input data-testid="input" />';

    const el = doc.querySelector('[data-testid="input"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });

  it('iframe 内 contenteditable 保持原生菜单', () => {
    const doc = setupIframeDoc();
    doc.addEventListener('contextmenu', handleContextMenu.bind(null, 'book-1'));
    doc.body.innerHTML = '<div data-testid="ce" contenteditable="true">edit</div>';

    const el = doc.querySelector('[data-testid="ce"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });

  it('事件不跨文档冒泡：父 window 收不到 iframe 内 contextmenu', () => {
    const doc = setupIframeDoc();
    let parentHandled = false;
    window.addEventListener('contextmenu', () => {
      parentHandled = true;
    });
    doc.addEventListener('contextmenu', handleContextMenu.bind(null, 'book-1'));

    const el = doc.querySelector('[data-testid="blank"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    // 验证问题根因存在：若父 window 能收到，useSuppressDefaultContextMenu 就够用
    expect(parentHandled).toBe(false);
  });
});
