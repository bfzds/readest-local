# Readest Local

Readest Local 是 [Readest](https://github.com/readest/readest) v0.12.1 的纯本地离线分支。它保留本地阅读能力，移除全部联网功能（云同步、在线词典与翻译、AI、订阅、支付、更新检查、遥测等），并把 Tauri CSP 收紧为只允许本地协议。代码继续按 AGPL-3.0 开源。

## 功能

- 支持 EPUB、PDF、MOBI、AZW3、FB2、CBZ、TXT、Markdown
- 滚动 / 翻页两种阅读模式
- 书内与书架全文搜索
- 高亮、书签、笔记
- 本地词典（导入 MDict、StarDict、SLOB、BGL 等词典文件）
- 本地 TTS（系统语音，支持 EPUB 3 Media Overlays 朗读）
- 字体、布局、主题自定义
- 代码语法高亮
- 文件关联与“打开方式”
- 书库管理
- 无障碍键盘导航与阅读辅助（阅读尺、逐段模式、速读）

本分支不包含：账号与云同步、在线翻译、AI、OPDS/Calibre 在线目录、平行阅读、更新检查、遥测、支付与订阅入口。

## 构建

环境要求：Windows、Rust 工具链、Node.js 与 pnpm、Microsoft Edge WebView2 Runtime。

```powershell
pnpm install
pnpm --filter @readest/readest-app setup-vendors
pnpm tauri build
```

构建免安装便携版：

```powershell
cd apps/readest-app
pnpm tauri build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1 -ExeName readest-local.exe
```

便携版产物位于 `apps/readest-app/release/readest-local/`，直接运行 `readest-local.exe` 即可，无需安装。目标机器需要 Microsoft Edge WebView2 Runtime（Windows 11 自带）。
便携版数据默认保存在 exe 同一目录：设置存于 `settings.json`，书库、字体、图片与词典等存于 `Readest` 子目录。整个文件夹可直接复制迁移。

## 离线验收

1. 断开网络后从 `apps/readest-app/release/readest-local/readest-local.exe` 启动。
2. 导入 EPUB、PDF、TXT 各一本，确认能打开并阅读。
3. 验证滚动/翻页、字体/主题、全文搜索、高亮/笔记/书签。
4. 验证本地词典（导入 MDict 词典文件）与本地 TTS（系统语音）。
5. 验证备份/导出 zip 可正常生成和恢复。
6. 确认界面没有任何同步、翻译、AI、订阅、分享、更新入口。
7. 用防火墙/代理或任务管理器确认应用运行期间无网络连接尝试。
8. 确认无 readest.com、Supabase、PostHog、Sentry、Stripe 等外部域名流量。

自动化检查由 `apps/readest-app/src/__tests__/offline-guard.test.ts` 提供，持续扫描云域名、网络 token 与云依赖。完整审计方法、报告位置和 CSP 说明见 [docs/offline-audit/README.md](docs/offline-audit/README.md)，最终审计结果见 [docs/offline-audit/offline-audit-report.txt](docs/offline-audit/offline-audit-report.txt)。

## 许可证

Readest Local 基于 Readest 修改，继续遵循 [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)，详见 [LICENSE](LICENSE)。
