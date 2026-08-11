# 2026-08-11 未提交改动审核记录

> 日期：2026-08-11

## 结论

- 无合并冲突，`git diff --check` 干净。
- 改动涉及阅读界面显示开关、Pixiv 小说元数据解析、阅读窗口尺寸继承、备份恢复设置、便携版打包脚本与配套测试、文档记录。
- 全量单测通过：5546 passed / 10 skipped。
- `tsgo --noEmit`、`biome lint`、`biome format`（排除仓库既有行尾基线）通过。

## 注意事项

- 根目录 `npm`、`pnpm` 为 0 字节文件，疑似误建，未纳入提交。
- `apps/readest-app/public/locales/en/translation.json` 的 CRLF 行尾为仓库既有基线，未做整文件转换。
