# 只保留桌面端：阉割移动端与网页端 实现进度

- 开始：2026-08-12
- 计划：`~/.claude/plans/squishy-gathering-trinket.md`
- 执行方式：子代理逐任务 + 任务间审查验证
- 分支：`readest-local`
- 决策：分层执行（先保守锁定，再激进清理）；桌面端 = Windows/macOS/Linux Tauri；保留桌面窄窗口响应式布局
- 状态：**Phase 1 + Phase 2 全部完成，已提交**

## Phase 1 任务进度（保守锁定）

- T1: package.json 脚本清理 + 删 .env.web - 完成（`6689e1b`）
- T2: tauri.conf.json + 平台工程（gen/android、gen/apple、Info-ios.plist）- 完成（`5a363be`、`d06268c`）
- T3: CI workflows（删 web/mobile build job、android-e2e）- 完成（`59da988`）
- T4: 测试体系清理（删 android/ios 测试、vitest.android.config、test-android.sh、playwright.config.ts；浏览器测试改跑 tauri 平台）- 完成（`5f92c61`）

## Phase 2 任务进度（激进清理）

- P2-T1: DOMMatrix polyfill（修 3 个 PDF 测试）- 完成（`e78345f`）
- P2-T2: web 运行时移除（webAppService/IndexedDB/OPFS、isWebAppPlatform、next.config web 分支）- 完成（`ab1dbf7`）
- P2-T3: 移动 TS 字段与消费（删 isMobile/isMobileApp/isAndroidApp/isIOSApp/isDesktopApp 及 87 文件消费，保留 innerWidth 响应式）- 完成（`5523a26`）
- P2-T4: 残余移动死代码（本地 shim、死移动 UI 分支、Android 文件选择 hook）- 完成（`2d6ad04`）
- P2-T5: Rust 移动代码（android/ 模块、mobile_entry_point、移动 cfg、haptics/biometric 插件及 TS 调用）- 完成（`a5944ae`）
- P2-T6: 文档清理（AGENTS.md、testing.md、architecture.md、DESIGN.md）- 完成（`d66960c`）
- P2-T7: 最终验证收尾 - 完成（本文档）

## 验证结果（最终）

- **lint**（tsgo + biome）：通过（1069 文件）。
- **全量单元套件** `test:pr:web:unit`：399 文件 / 5450 用例 / **0 失败**（DOMMatrix polyfill 已修复原 3 个 PDF 失败）。
- **浏览器测试**（EditorView，tauri 平台）：2 通过。
- **cargo check -p Readest**（Windows 桌面 target）：通过。
- **pnpm build**（tauri 前端）：成功。
- **残留说明**：`tauri-plugin-device-info`（笔记本电池）、`tauri-plugin-native-bridge`（桌面系统字体/配色）、`tauri-plugin-native-tts`（桌面原生语音）因**桌面功能在用而保留**；eink（桌面 e-ink 显示器）、mediaSession/carPlay（macOS 锁屏）保留。它们并非"移动端产品"，而是桌面也在用的能力。
- 结论：网页端与移动端（Android/iOS）已从构建、配置、CI、平台工程、运行时字段/分支、Rust 代码与插件、文档中整体移除；桌面端可构建、可测试。

## 遗留（可选，非阻塞）

- `docs/architecture.md` 等文档中仍有少数更早的过时引用（s3/storage/sync 等），与 web/移动端无关，未处理。
- `src-tauri/src/` 实际只有 `macos/`、`windows/` 目录（linux 用 `#[cfg]` 内联），AGENTS.md 写的是 `{macos,windows,linux}` 便于表达。
