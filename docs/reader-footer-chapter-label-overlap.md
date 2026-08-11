# 页脚章节名与正文重叠问题

## 问题表现

- 重叠位置：滚动排版下，页脚左侧章节名悬浮在正文最后几行上方。
- 触发条件：滚动模式、非竖排、章节名较长或正文字号/行高较大、正文滚动到底部。
- 根因：滚动模式按原设计不保留底部空白带（`footerReservesBand` 对 `scrolled` 返回 `false`），页脚信息以悬浮方式压在正文上；章节名无背景且旧实现用 `truncate` 截断，长标题既与正文文字混淆，又无法完整查看。
- 上一版回归：胶囊类直接加在 `flex-1` 外层 `div` 上，背景被撑满整行，出现高度为章节名高度、宽度占满整页的遮罩。

## 最终方案

滚动模式也保留底部空白带，让正文在页脚区域上方停止，页脚章节名完全落在正文之外的独立条带内。具体改动：

1. `footerReservesBand`：滚动模式只要 `showFooter` 开启就保留底部空白带；分页模式仍按页脚信息是否可见决定，竖排不受影响。
2. `FoliateViewer` 复用已有的 `scrollBottom` 逻辑：滚动到底时正文停在页脚带上方，不再与章节名接触。
3. `ProgressBar`：章节名胶囊只包内层文本 `span`，外层只负责布局和限宽（`min(55vw,36rem)`），不出现整行遮罩；长标题在胶囊内横向滚动查看完整内容，悬停 `title` 保留完整章节名。
4. TTS 迷你播放器位置复用 `footerReservesBand`，滚动模式下也停在页脚带上方，不会盖住章节名。

## 适应性

- 滚动模式：正文完全不再经过页脚区域；代价是底部多保留 `marginBottomPx` 空白，正文可见高度略有减少。
- 分页模式：行为不变，仍只在页脚信息可见时保留空白带。
- 竖排：章节名走右侧竖排栏，不套用本方案。
- 字号变化：胶囊随文本缩放，最大宽度不变，超宽内容在胶囊内横向滚动。
- 窄屏/移动端：胶囊按内容宽度收缩并限宽，不挤压页码和剩余时间。
- 关闭 Show Footer：不保留空白带，回到无页脚状态。

## 改动文件

- `apps/readest-app/src/app/reader/utils/footerBand.ts`
- `apps/readest-app/src/app/reader/utils/ttsMiniPlayerPosition.ts`
- `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`
- `apps/readest-app/src/app/reader/components/ProgressBar.tsx`
- `apps/readest-app/src/__tests__/components/footer-band.test.ts`
- `apps/readest-app/src/__tests__/components/tts-mini-player-position.test.ts`
- `apps/readest-app/src/__tests__/components/ProgressBar.test.tsx`

## 验证

- `footer-band.test.ts`、`tts-mini-player-position.test.ts`、`ProgressBar.test.tsx` 共 29 个用例通过。
- 新增用例覆盖：滚动模式开启 Show Footer 时保留空白带、关闭时不保留、所有信息控件关闭时仍保留；胶囊背景和横向滚动只存在于内层文本 `span`。
