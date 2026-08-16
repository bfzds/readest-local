// 归还焦点到文档/body：隐藏搜索栏等场景下 input 用 visibility:hidden 隐藏
// 不触发 blur，焦点留在隐藏元素内会让全局快捷键（useShortcuts）判定为
// "正在输入"而跳过。主动 blur 恢复快捷键体系。
export const blurActiveElement = () => {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
};
