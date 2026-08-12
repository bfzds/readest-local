# 只保留桌面端：阉割移动端与网页端 实现进度

- 开始：2026-08-12
- 计划：`~/.claude/plans/squishy-gathering-trinket.md`
- 执行方式：子代理逐任务 + 任务间审查验证
- 分支：`readest-local`
- 决策：分层执行（先保守锁定，Phase 2 再激进清理）；桌面端 = Windows/macOS/Linux Tauri；保留桌面窄窗口响应式布局
- 状态：Phase 1 完成，已提交

## Phase 1 任务进度（保守锁定）

- T1: package.json 脚本清理 + 删 .env.web - 完成（`6689e1b`）
- T2: tauri.conf.json + 平台工程（gen/android、gen/apple、Info-ios.plist）- 完成（`5a363be`、`d06268c`）
- T3: CI workflows（删 web/mobile build job、android-e2e）- 完成（`59da988`）
- T4: 测试体系清理（删 android/ios 测试、vitest.android.config、test-android.sh、playwright.config.ts；浏览器测试改跑 tauri 平台）- 完成（`5f92c61`）

## 验证结果

- lint（tsgo + biome）：通过（1080 文件）。
- 浏览器测试（EditorView，tauri 平台）：2 通过。
- 全量单元套件 `test:pr:web:unit`：405 文件，401 通过 / 3 失败 / 1 跳过（5541 用例通过）。3 个失败均为既有 PDF 测试的 `DOMMatrix is not defined`（jsdom 环境缺全局，与本次改动无关；Phase 1 删除的 android/ios 测试均无失败）。文件数 411→405 即已删的 6 个默认套件内测试（android 3 个无平台后缀 + ios 3 个）。
- `cargo check -p Readest`（Windows 桌面 target）：通过（2m27s，无错误）。
- `pnpm build`（tauri 前端静态导出）：成功，路由 /、/library、/offline、/reader、/reader/[ids]。
- 结论：桌面端可构建、可测试；网页端/移动端不再有构建脚本、env、CI job 或平台工程。

## Phase 2 待办（激进清理，未执行）

1. 删 web 运行时：`webAppService.ts`、IndexedDB/OPFS 文件系统与数据库、`isWebAppPlatform()` 及消费点、`next.config.mjs` web 分支。
2. 删移动运行时（TS）：`isMobile/isMobileApp/isAndroidApp/isIOSApp/isDesktopApp` 字段及消费、移动 UI/手势/服务。
3. 删移动运行时（Rust）：`#[cfg(target_os=android/ios)]` 模块、移动插件与 Cargo 依赖。
4. 清理文档（AGENTS.md、docs/architecture.md、docs/testing.md、DESIGN.md）中的 web/移动端章节。
