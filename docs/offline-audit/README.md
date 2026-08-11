# 离线审计说明

本目录记录了 Readest Local 的离线化改造审计过程与结果，用于回答“这个版本是否真的不会联网”以及“以后改代码怎么防止联网功能回流”。

## 审计方法

### 1. 自动防护测试

`apps/readest-app/src/__tests__/offline-guard.test.ts` 是持续集成的离线防护测试，扫描 `apps/readest-app` 下的 `src`、`src-tauri`、`public`（跳过测试、构建产物、node_modules、Tauri gen/target、vendored plugins），断言不存在：

- 已知云域名：Supabase、PostHog、Sentry、Stripe、DeepL、Wikipedia、readest.com、Google Fonts、OpenAI 等；
- 网络 token：`wss://`、`new WebSocket(`、`ws` 模块、支付宝支付 scheme；
- 云依赖包：`ai`、`aws`、`openai`、`stripe`、`supabase`、`@sentry/*` 等；
- 平行阅读残留文件。

运行方式：

```powershell
cd apps/readest-app
pnpm exec vitest run src/__tests__/offline-guard.test.ts
```

### 2. 全量 URL 扫描

使用 `rg` 扫描全部运行时源码中的 URL，再逐条人工分类：

```powershell
rg -n -i "https?://|wss?://" apps/readest-app/src apps/readest-app/src-tauri apps/readest-app/public --glob "!**/__tests__/**" --glob "!**/gen/**" --glob "!**/target/**" --glob "!**/.next/**" --glob "!**/out/**" --glob "!**/plugins/**"
```

分类结果：本地协议/开发地址、XML/SVG/EPUB 命名空间、文档与许可证链接、示例 URL。除上述豁免外不得出现真实联网入口。

### 3. 手动验收

按 [README](../../../README.md) 的“离线验收”清单执行：断网启动、导入多种格式、验证核心阅读功能、检查界面入口，并用防火墙/任务管理器确认运行期间无网络连接尝试。

## 报告位置

- `offline-audit-report.txt`：Task 9 的最终扫描报告，含 81 个 URL 命中的完整分类；
- `task2-errors.txt` 至 `task9-*.txt`：各任务阶段的类型错误、lint、构建、测试与审计记录；
- `baseline-network-refs.txt`：改造前的网络引用基线；
- `handoff-2026-08-10.md`：任务交接记录。

## CSP 为什么只允许本地协议

Tauri 桌面应用由 WebView2 加载本地资源，页面自身的协议是 `http://tauri.localhost`，文件读取走 `asset`/`rangefile` 自定义协议，插件通信走 `ipc`。CSP 全部收紧为：

- `default-src` 只允许 `'self'`、本地 `asset`/`rangefile`/`ipc`、`blob:`、`data:`；
- `connect-src` 不包含任何 `https:` 或 `http://` 外域地址，因此即使代码中残留 fetch/XHR/WebSocket 也会被浏览器直接拦截；
- 开发时仅有 `http://localhost:3000` 作为 `devUrl`，产物中不存在。

这样形成双保险：源码层由防护测试和 URL 扫描把关，运行时由 CSP 兜底。
