# Readest 离线本地阅读器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Readest v0.12.1 裁剪成 Windows 桌面全离线便携阅读器 `readest-local`（绿色免安装，不生成安装包），移除所有联网功能与入口，保留本地阅读核心能力。

**Architecture:** 以官方 monorepo 的 `apps/readest-app`（Next.js 16 前端 + Tauri 2 Rust 壳）为基线；保留 foliate-js 阅读内核、Turso WASM 本地数据库、本地词典、本地 TTS；删除云服务目录、Next.js API 路由、认证/同步/遥测/支付/更新模块，并把 Tauri CSP 与权限收紧到纯本地协议。平行阅读不保留。

**Tech Stack:** pnpm 11.1.1 / Next.js 16.2.11 / React 19.2.8 / Tauri 2.11.4 / Rust / Turso WASM / foliate-js / PDF.js / Vitest / TypeScript。

## Global Constraints

- 基线：Readest 官方仓库 tag `v0.12.1`，子模块必须 `--recurse-submodules` 拉全。
- 工作区：`C:\Users\REDACTED_USER\Documents\阅读器`；目标平台：Windows x64 便携版（免安装目录，不生成 NSIS/MSI 安装包）。
- 100% 离线：应用运行时不得发起任何外部 HTTP/WebSocket 请求；验收通过源码扫描测试 + 用户断网手动验收。
- 不保留平行阅读（UI 入口、状态存储、相关测试全部删除）。
- 保留纯本地功能：EPUB/PDF/MOBI/AZW3/FB2/CBZ/TXT/MD 导入阅读、本地书库、滚动/翻页、字体/主题/布局、全文搜索、批注/高亮/笔记/书签、本地词典（MDict/StarDict/BGL/SLOB）、本地 TTS（Web Speech/native-tts）、RSVP 速读、阅读统计、简繁转换、本地备份/导出、文件关联与"打开方式"。
- 删除联网/云功能：Supabase 同步、KOReader 同步、Google Drive/iCloud/WebDAV 同步、OPDS/Calibre、RSS、在线小说、在线翻译、在线词典/Wikipedia、AI 助手、Stripe/内购、PostHog/Sentry 遥测、Tauri 自动更新、分享链接、云端 TTS、在线元数据、Web 部署、Discord Rich Presence。
- 许可证：保留 AGPL-3.0（`LICENSE`、`NOTICE`），分发修改版必须保持开源并公开源码。
- 依赖下载优先国内镜像：pnpm registry 使用 `https://registry.npmmirror.com`；下载前审核内容危险度，遇到混淆/提权/绕过信号立即停止并上报路径。
- 不使用 Codex 内置浏览器访问/验证本地项目；验收以命令行测试、构建和用户手动检查为准。

---

## 功能范围对照

| 功能 | 决策 | 说明 |
| --- | --- | --- |
| EPUB/PDF/MOBI/AZW3/FB2/CBZ/TXT/MD 导入与渲染 | 保留 | foliate-js + PDF.js 全本地 |
| 本地书库、搜索、排序 | 保留 | Turso WASM 本地库 |
| 批注、高亮、笔记、书签 | 保留 | 本地数据库 |
| 字体/主题/布局设置 | 保留 | 需把 CDN 字体改为本地/系统字体 |
| 滚动/翻页、TOC、代码高亮 | 保留 | 本地 |
| 本地词典 MDict/StarDict/BGL/SLOB | 保留 | 删 Wikipedia/Wiktionary/Web Search provider |
| 本地 TTS（Web Speech/native-tts/EPUB Media Overlay） | 保留 | 删 Edge TTS 云端 |
| RSVP 速读 | 保留 | 本地 |
| 阅读统计 | 保留 | 去掉 PostHog 上报，保留本地统计 |
| 简繁转换/文本清理 | 保留 | `src/services/transformers` 全本地 |
| 备份/导出 | 保留 | 本地 zip，去掉云相关黑名单字段 |
| 平行阅读 | 删除 | 入口、store、相关测试删除 |
| Supabase/云同步 | 删除 | `src/services/sync` 等 |
| OPDS/Calibre/RSS/在线小说 | 删除 | 相关服务目录 |
| 在线翻译/AI/在线词典/WordLens | 删除 | 相关服务目录与 API 路由 |
| 支付/订阅/内购 | 删除 | Stripe/Apple/Google 路由 |
| 遥测/崩溃上报 | 删除 | PostHog/Sentry |
| 自动更新/深链/OAuth/WebSocket | 删除 | Tauri 插件与权限 |
| Web 部署/Workers/Docker | 删除 | Cloudflare、Dockerfile、worker 子项目 |

## 文件结构地图

裁剪后只保留以下运行时入口：

- `apps/readest-app/src/app/library` 本地书库
- `apps/readest-app/src/app/reader` 本地阅读器
- `apps/readest-app/src/app/offline` 离线页（保留）
- `apps/readest-app/src/services/{annotation,database,dictionaries,nav,rsvp,statistics,transformers,tts,widget}` 本地服务
- `apps/readest-app/src-tauri` Tauri 壳（去掉网络插件）
- `apps/readest-app/release/readest-local/` 便携版产物目录（release exe + 说明文件）

以下目录整体删除：`apps/readest-calibre-plugin`、`apps/readest.koplugin`、`apps/readest-app/workers`、`apps/readest-app/extensions`、`apps/readest-app/src/app/api`、`apps/readest-app/src/pages/api`、`apps/readest-app/src/services/{ai,bookorbit,hardcover,metadata,novel,opds,readwise,reedy,rss,send,sync,translators,wordlens}`、`apps/readest-app/src/app/{auth,user,updater,s,o,gdrive-callback,onedrive-callback,send,opds}`、`Dockerfile`、`docker`、`fastlane`、`ops`。

---

### Task 0: 基线初始化与验证

**Files:**
- Create: `docs/offline-audit/baseline-network-refs.txt`
- Modify: `.git` 配置、`docs/offline-audit/`（后续所有审计报告都放这里）
- 引入：Readest v0.12.1 全部源码与子模块

**Interfaces:**
- Consumes: 空工作区（当前只有一个空的 `.git`）
- Produces: 干净可构建的 `readest-local` 基线分支；后续任务全部基于 `apps/readest-app`

- [ ] **Step 1: 关联官方仓库并确认工作区状态**

```powershell
git status --short
git remote -v
```

若没有 `origin`：

```powershell
git remote add origin https://github.com/readest/readest.git
```

- [ ] **Step 2: 拉取 v0.12.1 并创建裁剪分支**

```powershell
git fetch --depth 1 origin tag v0.12.1
git checkout -b readest-local v0.12.1
git submodule update --init --recursive
```

- [ ] **Step 3: 验证基线**

```powershell
git describe --tags
Test-Path packages\foliate-js\package.json
Test-Path apps\readest-app\src-tauri\Cargo.toml
```

期望：`git describe --tags` 输出 `v0.12.1`，两个 `Test-Path` 均为 `True`。

- [ ] **Step 4: 配置国内镜像并安装依赖**

```powershell
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

如 Rust 依赖下载慢，在 `$env:CARGO_HOME\config.toml` 配置 `sparse+https://rsproxy.cn/index/`。安装前对下载清单做危险度审核；发现混淆/提权/绕过信号立即停止并报告。

- [ ] **Step 5: 基线构建**

```powershell
cd apps\readest-app
pnpm build
```

期望：Next.js 静态导出成功，`apps/readest-app/out` 存在。若失败是因为缺少 Rust/Tauri 工具链，先安装 Rust stable + MSVC Build Tools 再重试；记录失败原因到 `docs/offline-audit/env-notes.md`。

- [ ] **Step 6: 生成联网引用基线**

```powershell
New-Item -ItemType Directory -Force docs\offline-audit
rg -n -i "https?://|wss?://|fetch\s*\(|WebSocket" apps/readest-app/src apps/readest-app/src-tauri --glob '*.{ts,tsx,js,jsx,rs}' > docs\offline-audit\baseline-network-refs.txt
```

- [ ] **Step 7: 提交基线**

```powershell
git add -A
git commit -m "import: readest v0.12.1 offline fork baseline"
```

---

### Task 1: 移除云伴侣应用与 Worker/扩展

**Files:**
- Delete: `apps/readest-calibre-plugin/`、`apps/readest.koplugin/`、`apps/readest-app/workers/`、`apps/readest-app/extensions/`
- Modify: `pnpm-workspace.yaml`、根 `package.json`、`.gitmodules`

**Interfaces:**
- Consumes: Task 0 基线
- Produces: 只包含 `apps/readest-app` 与 `packages/foliate-js` 的 workspace；不再存在 Calibre/KOReader/Workers/浏览器扩展

- [ ] **Step 1: 删除子项目目录**

```powershell
git rm -r apps/readest-calibre-plugin apps/readest.koplugin apps/readest-app/workers apps/readest-app/extensions
```

- [ ] **Step 2: 收窄 workspace**

把 `pnpm-workspace.yaml` 的 `packages` 替换为：

```yaml
packages:
  - apps/readest-app
  - packages/foliate-js
```

- [ ] **Step 3: 删除引用 koplugin 的脚本**

根 `package.json` 的 `scripts` 删除 `test:lua`、`lint:lua`；`apps/readest-app/package.json` 同步删除 `test:lua`、`lint:lua`。

- [ ] **Step 4: 删除无关 git 子模块条目**

```powershell
git config -f .gitmodules --remove-section submodule."apps/readest-app/.claude/skills/gstack"
git submodule sync
```

- [ ] **Step 5: 验证**

```powershell
pnpm install
rg -n "readest-calibre-plugin|readest.koplugin|send-to-readest|workers/" pnpm-workspace.yaml package.json apps/readest-app/package.json
```

期望：`rg` 无输出，`pnpm install` 成功。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "chore: remove cloud companion apps, workers and extensions"
```

---

### Task 2: 删除前端云服务目录

**Files:**
- Delete: `apps/readest-app/src/services/ai/`、`bookorbit/`、`hardcover/`、`metadata/`、`novel/`、`opds/`、`readwise/`、`reedy/`、`rss/`、`send/`、`sync/`、`translators/`、`wordlens/`
- Delete: `apps/readest-app/src/services/cloudService.ts`、`transferManager.ts`、`transferMessages.ts`
- Modify: 后续 Task 3/4 处理剩余引用

**Interfaces:**
- Consumes: Task 1 收窄后的 workspace
- Produces: `src/services` 只保留 `annotation`、`database`、`dictionaries`、`nav`、`rsvp`、`statistics`、`transformers`、`tts`、`widget` 与顶层本地服务文件

- [ ] **Step 1: 删除云服务目录**

```powershell
cd apps\readest-app
git rm -r src/services/ai src/services/bookorbit src/services/hardcover src/services/metadata src/services/novel src/services/opds src/services/readwise src/services/reedy src/services/rss src/services/send src/services/sync src/services/translators src/services/wordlens src/services/cloudService.ts src/services/transferManager.ts src/services/transferMessages.ts
```

- [ ] **Step 2: 记录残留引用**

```powershell
rg -l "services/(ai|bookorbit|hardcover|metadata|novel|opds|readwise|reedy|rss|send|sync|translators|wordlens)|cloudService|transferManager|transferMessages" src --glob '*.{ts,tsx}' > docs\offline-audit\task2-refs.txt
Get-Content docs\offline-audit\task2-refs.txt
```

- [ ] **Step 3: 清理已知引用点**

按 `task2-refs.txt` 逐文件删除 import 与调用；已知重点文件：

```text
src/app/library/page.tsx
src/app/library/components/TransferQueuePanel.tsx
src/app/library/hooks/useBookTransferActions.ts
src/hooks/useOPDSSubscriptions.ts
src/hooks/useQuotaStats.ts
src/hooks/useTransferQueue.ts
src/hooks/useReplicaPull.ts
src/libs/shareImport.ts
src/libs/storage.ts
src/services/ingestService.ts
src/services/bookService.ts
src/services/constants.ts
src/store/transferStore.ts
src/utils/transfer.ts
```

规则：只删除云相关 import/调用；`ingestService.ts` 的本地文件导入路径必须保留，远程下载路径删除；`src/libs/storage.ts` 中 S3/R2/上传下载分支删除，本地文件系统读写保留。

- [ ] **Step 4: 中间验证并保存错误清单**

```powershell
pnpm lint 2>&1 | Out-File -Encoding utf8 docs\offline-audit\task2-errors.txt
Get-Content docs\offline-audit\task2-errors.txt | Select-Object -First 60
```

预期仍有错误，因为依赖与页面尚未清理；本步只要求错误清单收敛到"已删除模块的引用"。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "refactor: remove cloud service modules"
```

---

### Task 3: 本地化词典与 TTS

**Files:**
- Delete: `src/services/dictionaries/providers/webSearchProvider.ts`、`wikipediaProvider.ts`、`wiktionaryProvider.ts`、`src/services/dictionaries/webSearchTemplates.ts`
- Delete: `src/services/tts/EdgeTTSClient.ts`、`src/services/tts/downloadChapters.ts`、`src/services/tts/providers/edge.ts`
- Modify: `src/services/dictionaries/` 的 provider 注册、`src/services/tts/index.ts`、`src/services/tts/TTSClient.ts`、`src/services/tts/TTSController.ts`

**Interfaces:**
- Consumes: Task 2 之后剩余的本地服务
- Produces: 词典只剩本地格式（MDict/StarDict/BGL/SLOB/system）；TTS 只剩 Web Speech、native-tts、Media Overlay

- [ ] **Step 1: 删除在线词典 provider**

```powershell
git rm src/services/dictionaries/providers/webSearchProvider.ts src/services/dictionaries/providers/wikipediaProvider.ts src/services/dictionaries/providers/wiktionaryProvider.ts src/services/dictionaries/webSearchTemplates.ts
```

- [ ] **Step 2: 修正 provider 注册**

```powershell
rg -n "webSearchProvider|wikipediaProvider|wiktionaryProvider|webSearchTemplates" src/services/dictionaries src/app/reader
```

对每个命中：删除 import 与 provider 数组条目；若某文件只剩该 import 则整文件删除。

- [ ] **Step 3: 删除云端 TTS**

```powershell
git rm src/services/tts/EdgeTTSClient.ts src/services/tts/downloadChapters.ts src/services/tts/providers/edge.ts
```

- [ ] **Step 4: 修正 TTS 注册**

```powershell
rg -n "EdgeTTS|edgeProvider|providers/edge|downloadChapters" src/services/tts src/app/reader src/app/api 2>$null
```

对每个命中：删除 import 与分支；`TTSClient.ts` 保留 `NativeTTSClient`、`WebSpeechClient`、`MediaOverlayClient` 分支，删除 Edge 分支。`src/app/api/tts` 在 Task 4 整目录删除，本步无需修复。

- [ ] **Step 5: 验证本地服务目录清单**

```powershell
Get-ChildItem src/services -Directory | Select-Object Name
rg -n -i "wikipedia|wiktionary|webSearchProvider|EdgeTTS|speech.platform.bing|microsofttranslator" src/services
```

期望：目录只有 `annotation,database,dictionaries,nav,rsvp,statistics,transformers,tts,widget`，`rg` 无输出。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor: localize dictionary and TTS providers"
```

---

### Task 4: 删除 API 路由与云页面

**Files:**
- Delete: `src/app/api/` 全部（ai/apple/azure-translate/google/hardcover/metadata/opds/share/stripe/tts/yandex-translate）
- Delete: `src/pages/api/` 全部（bookorbit/kosync/sync/deepl/send/storage/user）
- Delete: `src/app/auth/`、`src/app/user/`、`src/app/updater/`、`src/app/s/`、`src/app/o/`、`src/app/gdrive-callback/`、`src/app/onedrive-callback/`、`src/app/send/`、`src/app/opds/`
- Modify: `src/pages/_app.tsx`、`src/pages/_document.tsx`、`src/middleware.ts`、`next.config.mjs`

**Interfaces:**
- Consumes: Task 3 本地化后的服务
- Produces: 无 `/api` 路由；无认证/订阅/更新/分享/OPDS/云盘回调页面；`middleware.ts` 不再有 CORS 与 COOP 逻辑

- [ ] **Step 1: 删除 API 路由**

```powershell
git rm -r src/app/api src/pages/api
```

- [ ] **Step 2: 删除云相关页面**

```powershell
git rm -r src/app/auth src/app/user src/app/updater src/app/s src/app/o src/app/gdrive-callback src/app/onedrive-callback src/app/send src/app/opds
```

- [ ] **Step 3: 替换 middleware**

把 `src/middleware.ts` 替换为只做本地文档头的最小实现：

```ts
import { NextResponse } from 'next/server';

export function middleware() {
  const response = NextResponse.next();
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 4: 清理页面 provider 引用**

```powershell
rg -n "AuthProvider|CSPostHogProvider|SyncProvider" src/pages src/app --glob '*.{ts,tsx}'
```

`src/pages/reader/[ids].tsx` 中删除 `AuthProvider`、`CSPostHogProvider`、`SyncProvider`，保留 `EnvProvider` 与 `Reader`；对应文件由 Task 5 删除。

- [ ] **Step 5: 精简 next.config rewrites**

`next.config.mjs` 的 `rewrites` 只保留：

```js
async rewrites() {
  return [
    {
      source: '/reader/:ids',
      destination: '/reader?ids=:ids',
    },
  ];
},
```

删除 `/o/...`、`/s/:token` 两条。

- [ ] **Step 6: 验证**

```powershell
rg -n "/api/|/auth|/user|/updater|/share|/opds|/s\?|/o\?" src/pages src/app src/components src/hooks src/services --glob '*.{ts,tsx}' 2>$null
pnpm lint 2>&1 | Out-File -Encoding utf8 docs\offline-audit\task4-errors.txt
```

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor: remove API routes and cloud pages"
```

---

### Task 5: 删除认证/同步/遥测上下文与 Hooks/Store

**Files:**
- Delete: `src/context/AuthContext.tsx`、`src/context/SyncContext.tsx`、`src/context/PHContext.tsx`
- Delete: `src/hooks/useTranslator.ts`、`useReplicaPull.ts`、`useInboxDrainer.ts`、`useOpenShareLink.ts`、`useOpenBookLink.ts`、`useOpenAnnotationLink.ts`、`useClipUrlIngress.ts`、`useAvailablePlans.ts`、`useQuotaStats.ts`、`useTransferQueue.ts`、`useOPDSSubscriptions.ts`（`useMedianPageDurationSecs.ts` 是本地统计，保留）
- Delete: `src/store/transferStore.ts`、`src/utils/telemetry.ts`（PostHog 专用）
- Modify: `src/components/Providers.tsx`、`src/app/error.tsx`、`src/app/reader/components/ReadingStatsTracker.tsx`、`src/services/appService.ts`、`src/services/nativeAppService.ts`、`src/services/webAppService.ts`、`src/services/bookService.ts`

**Interfaces:**
- Consumes: Task 4 无云页面
- Produces: 应用不再初始化 PostHog/Sentry/认证/同步；本地统计保留

- [ ] **Step 1: 删除上下文与 hooks**

```powershell
git rm src/context/AuthContext.tsx src/context/SyncContext.tsx src/context/PHContext.tsx src/store/transferStore.ts src/utils/telemetry.ts
git rm src/hooks/useTranslator.ts src/hooks/useReplicaPull.ts src/hooks/useInboxDrainer.ts src/hooks/useOpenShareLink.ts src/hooks/useOpenBookLink.ts src/hooks/useOpenAnnotationLink.ts src/hooks/useClipUrlIngress.ts src/hooks/useAvailablePlans.ts src/hooks/useQuotaStats.ts src/hooks/useTransferQueue.ts src/hooks/useOPDSSubscriptions.ts
```

- [ ] **Step 2: 清理 Providers 入口**

`src/components/Providers.tsx` 删除 `AuthProvider`、`SyncProvider`、`CSPostHogProvider` 及其 import；`EnvProvider` 保留。

```powershell
rg -n "AuthProvider|SyncProvider|CSPostHogProvider|PHProvider|PostHog" src/components src/app src/context
```

- [ ] **Step 3: 删除遥测**

```powershell
rg -l "posthog|PostHog|telemetry|ReadingStatsTracker" src --glob '*.{ts,tsx}'
```

删除 `src/utils/telemetry.ts`（PostHog 专用，无本地统计逻辑）；`ReadingStatsTracker.tsx` 中删除 PostHog 上报与 sync 调用，保留本地阅读时长统计；`src/hooks/useMedianPageDurationSecs.ts` 保留；`src/app/error.tsx` 删除 Sentry/PostHog 初始化，保留本地错误展示。

- [ ] **Step 4: 清理 appService 云命令**

```powershell
rg -n "telemetry|sentry|posthog|sync|transfer|share|opds|oauth|deep-link" src/services/appService.ts src/services/nativeAppService.ts src/services/webAppService.ts src/services/bookService.ts
```

对每个命中：删除云命令注册与 import；`nativeAppService.ts` 保留文件系统、窗口、TTS、本地库命令。

- [ ] **Step 5: 验证引用收敛**

```powershell
rg -l "AuthContext|SyncContext|PHContext|useReplicaPull|useInboxDrainer|useOpenShareLink|useOpenBookLink|useOpenAnnotationLink|useClipUrlIngress|useAvailablePlans|useTransferQueue|useOPDSSubscriptions|transferStore|telemetry" src --glob '*.{ts,tsx}' > docs\offline-audit\task5-refs.txt
Get-Content docs\offline-audit\task5-refs.txt
```

按清单逐文件删除引用；若某文件只剩这些引用则整文件删除。

- [ ] **Step 6: 中间验证**

```powershell
pnpm lint 2>&1 | Out-File -Encoding utf8 docs\offline-audit\task5-errors.txt
Get-Content docs\offline-audit\task5-errors.txt | Select-Object -First 60
```

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor: remove auth, sync, telemetry contexts"
```

---

### Task 6: 移除平行阅读

**Files:**
- Delete: `src/store/parallelViewStore.ts`、`src/__tests__/store/parallel-view-store.test.ts`
- Modify: `src/app/reader/hooks/useBooksManager.ts`、`src/app/reader/components/sidebar/BookMenu.tsx`、`src/app/reader/components/BooksGrid.tsx`、`src/app/reader/components/ReaderContent.tsx`

**Interfaces:**
- Consumes: Task 5 无同步/遥测上下文
- Produces: 阅读器一次只打开一本书；无 Parallel Read 入口；相关测试删除

- [ ] **Step 1: 删除 store 与测试**

```powershell
git rm src/store/parallelViewStore.ts src/__tests__/store/parallel-view-store.test.ts
```

- [ ] **Step 2: 删除 BookMenu 入口**

`src/app/reader/components/sidebar/BookMenu.tsx` 中删除 `useParallelViewStore`、`openParallelView`、`handleSetParallel`、`handleUnsetParallel`、`Parallel Read` 菜单项与 `Enter/Exit Parallel Read` 项。

- [ ] **Step 3: 单书化 bookKeys**

`src/app/reader/hooks/useBooksManager.ts` 中删除 `appendBook`、`openParallelView`、`getNextBookKey` 与 parallel 相关逻辑；`setBookKeys` 只写入单个 key；`openBookInReader` 保持单书打开。

- [ ] **Step 4: 简化网格**

`BooksGrid.tsx` 与 `ReaderContent.tsx` 中删除多 bookKey 循环/网格模板分支，只渲染一个 `BookCell`/`FoliateViewer`；`src/utils/grid.ts` 若只剩单书逻辑则删除 `getGridTemplate` 的多分支，或整个文件删除并内联单格样式。

- [ ] **Step 5: 验证无残留**

```powershell
rg -n -i "parallel|openParallelView|setParallel|unsetParallel|appendBook" src --glob '*.{ts,tsx}'
pnpm lint 2>&1 | Out-File -Encoding utf8 docs\offline-audit\task6-errors.txt
```

期望：`rg` 无输出（除注释中历史说明外，如有则一并删除）。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor: remove parallel read feature"
```

---

### Task 7: 精简依赖

**Files:**
- Modify: `apps/readest-app/package.json`、`apps/readest-app/src-tauri/Cargo.toml`、`pnpm-lock.yaml`、`Cargo.lock`

**Interfaces:**
- Consumes: Task 2-6 已删除引用云模块的代码
- Produces: 依赖树中不再有云/联网包；`pnpm lint` 与 `cargo check` 通过

- [ ] **Step 1: 删除前端云依赖**

```powershell
cd apps\readest-app
pnpm remove @ai-sdk/openai-compatible @ai-sdk/react @assistant-ui/react @assistant-ui/react-ai-sdk @assistant-ui/react-markdown @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @choochmeque/tauri-plugin-sharekit-api @fabianlars/tauri-plugin-oauth @googleapis/androidpublisher @opennextjs/cloudflare @stripe/react-stripe-js @stripe/stripe-js @supabase/auth-ui-react @supabase/auth-ui-shared @supabase/supabase-js @tauri-apps/plugin-deep-link @tauri-apps/plugin-http @tauri-apps/plugin-updater @tauri-apps/plugin-websocket ai ai-sdk-ollama app-store-server-api aws4fetch google-auth-library isomorphic-ws posthog-js stripe ws wrangler
```

注意：`@serwist/next`、`@serwist/webpack-plugin` 与 `src/sw.ts` 一起在 Task 8 删除，避免本任务留下悬空 import。

- [ ] **Step 2: 删除前端 devDependencies 中的云/监控包**

```powershell
pnpm remove -D @sentry/cli @next/bundle-analyzer
```

`@next/bundle-analyzer` 非联网依赖，如后续还想用可恢复；默认移除以简化配置。

- [ ] **Step 3: 删除 Rust 云依赖**

编辑 `apps/readest-app/src-tauri/Cargo.toml`，删除以下条目：

```toml
reqwest
tauri-plugin-http
tauri-plugin-oauth
tauri-plugin-deep-link
tauri-plugin-sign-in-with-apple
tauri-plugin-websocket
tauri-plugin-updater
tauri-plugin-sharekit
discord-rich-presence
sentry
tauri-plugin-sentry
```

同时删除 `[target.'cfg(windows)'.dependencies]` 的 `winreg`（仅用于 OAuth 冷启动浏览器）。

- [ ] **Step 4: 删除 Rust 联网源码**

```powershell
git rm src-tauri/src/discord_rpc.rs src-tauri/src/nightly_update.rs src-tauri/src/sentry_config.rs src-tauri/src/spawn_fresh_browser.rs src-tauri/src/transfer_file.rs src-tauri/src/clip_url.rs
git rm -r src-tauri/src/macos/apple_auth.rs src-tauri/src/macos/safari_auth.rs 2>$null
```

`src-tauri/src/lib.rs` 删除对应 `mod` 与插件注册；`src-tauri/src/main.rs` 同步。`range_file.rs`、`epub_parser.rs`、`mobi_parser.rs`、`window_state.rs` 保留。

- [ ] **Step 5: 验证 Rust 编译**

```powershell
cd src-tauri
cargo check -p Readest
```

期望无 `reqwest`、`oauth`、`updater`、`websocket`、`sentry` 相关错误；如报错，按错误删除残留引用。

- [ ] **Step 6: 验证依赖安装并记录剩余错误**

```powershell
cd ..
pnpm install
pnpm lint 2>&1 | Out-File -Encoding utf8 ..\..\docs\offline-audit\task7-errors.txt
```

期望：错误只来自 `next.config.mjs` 的 `@opennextjs/cloudflare`、`@next/bundle-analyzer` 引用（Task 8 会清理）；`pnpm lint` 全量通过推迟到 Task 8 Step 7。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "chore: prune cloud dependencies from frontend and Rust shell"
```

---

### Task 8: Tauri 配置、CSP、字体与 PWA 本地化

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src/styles/fonts.ts`、`src/services/constants.ts`、`next.config.mjs`
- Delete: `src/sw.ts`、PWA 相关（若 `public/sw.js` 存在也删除）
- 可选新增：`public/fonts/` 下自托管字体（需许可证审核）

**Interfaces:**
- Consumes: Task 7 无云依赖
- Produces: CSP 只允许本地协议；无 updater/deep-link/OAuth/WebSocket 权限；无 CDN 字体；无 service worker

- [ ] **Step 1: 收紧 Tauri CSP**

`src-tauri/tauri.conf.json` 的 `app.security.csp` 替换为：

```json
"csp": {
  "default-src": "'self' 'unsafe-inline' blob: data: customprotocol: asset: http://asset.localhost http://rangefile.localhost ipc: http://ipc.localhost",
  "connect-src": "'self' blob: data: asset: http://asset.localhost http://rangefile.localhost ipc: http://ipc.localhost",
  "img-src": "'self' blob: data: asset: http://asset.localhost",
  "style-src": "'self' 'unsafe-inline' blob: asset: http://asset.localhost",
  "font-src": "'self' blob: data: asset: http://asset.localhost",
  "frame-src": "'self' blob: asset: http://asset.localhost",
  "script-src": "'self' 'unsafe-inline' 'unsafe-eval' data: blob: asset: http://asset.localhost"
}
```

同时：`bundle.createUpdaterArtifacts` 改为 `false`；删除 `plugins.updater` 与 `plugins.deep-link`。

- [ ] **Step 2: 清理 Tauri capabilities**

`src-tauri/capabilities/default.json` 中删除：

```text
http:default 及其中所有 allow url
websocket:default
oauth:allow-start
oauth:allow-cancel
sign-in-with-apple:default
deep-link:default
sharekit:default
sentry:default
allow-is-updater-disabled
allow-verify-update-signature
allow-install-nightly-update
allow-spawn-fresh-browser
allow-clip-url
```

保留 `fs:*`、`dialog:*`、`os:*`、`log:*`、`shell:*`、`process:*`、`clipboard-manager:*`、`biometric:*`、`haptics:*`、`turso:*`、`native-tts:*`、`native-bridge:*` 及自定义本地命令。

- [ ] **Step 3: 字体本地化**

```powershell
rg -n "fonts.googleapis|fonts.gstatic|cdn.jsdelivr|cdnjs.cloudflare|storage.readest|onlinewebfonts|FONT_BASE_URL|fontBaseUrl" src/styles/fonts.ts src/services/constants.ts src/services/runtimeConfig.ts
```

`src/styles/fonts.ts` 删除所有 `<link>`/`@font-face` 中的外部 URL；改为 `local("...")` 系统字体或 `public/fonts` 下自托管文件。自托管字体若需新增，从 npmmirror/官方源下载开源字体（Inter、Noto、LXGW WenKai 等），记录许可证到 `licenses/fonts/`。若某个 CJK 字体无法本地化，从字体列表中移除，保留系统字体回退。

- [ ] **Step 4: 移除 PWA/Service Worker**

```powershell
git rm src/sw.ts
Remove-Item public\sw.js -ErrorAction SilentlyContinue
pnpm remove @serwist/next @serwist/webpack-plugin
```

`next.config.mjs` 删除 `withSerwistInit` 包裹、`@serwist/next` import、`swSrc`/`swDest` 相关配置。

- [ ] **Step 5: 清理 next.config 云配置**

`next.config.mjs` 中删除：

```text
initOpenNextCloudflareForDev
productionBrowserSourceMaps 的 Sentry 注释与开关（设为 false）
serverExternalPackages: ['isows']
allowedDevOrigins: ['192.168.2.120']
```

保留 `output: 'export'`（Tauri 需要静态导出）。同时删除 `withBundleAnalyzer` 包裹与 `@next/bundle-analyzer` import，`next.config.mjs` 最终 `export default nextConfig;`。

- [ ] **Step 6: 清理环境文件**

`.env`、`.env.tauri`、`.env.tauri.example`、`.env.web`、`.env.web.example` 只保留：

```text
NEXT_PUBLIC_APP_PLATFORM=tauri
```

`src/services/runtimeConfig.ts` 中删除 `supabaseUrl`、`supabaseAnonKey`、`apiBaseUrl`、`objectStorageType`、`storageFixedQuota`、`translationFixedQuota`；`fontBaseUrl` 改为本地相对路径或删除。

- [ ] **Step 7: 验证无外部 URL**

```powershell
rg -n -i "https?://|wss?://" src src-tauri public --glob '!**/__tests__/**' --glob '!**/gen/**' --glob '!**/target/**' --glob '!**/.next/**'
```

期望无输出；若有命中，逐个替换为本地资源或删除。然后运行：

```powershell
pnpm lint
```

期望 `pnpm lint` 全部通过（承接 Task 7 遗留的 next.config 错误）。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "chore: lock Tauri to local-only CSP, fonts and PWA"
```

---

### Task 9: 离线防护测试与全量验证

**Files:**
- Create: `apps/readest-app/src/__tests__/offline-guard.test.ts`
- Create: `apps/readest-app/scripts/build-portable.ps1`
- Modify: `docs/offline-audit/offline-audit-report.txt`（生成）
- 验证：`pnpm lint`、`pnpm test`、`cargo clippy`、`cargo test`、`pnpm tauri build`

**Interfaces:**
- Consumes: Task 0-8 全部清理结果
- Produces: 可持续执行的"离线防护"测试；Windows 安装包

- [ ] **Step 1: 创建离线防护测试**

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const APP_ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['src', 'src-tauri', 'public'].map((d) => join(APP_ROOT, d));
const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next', 'out', 'target', 'gen']);
const FORBIDDEN_HOSTS = [
  'supabase',
  'posthog',
  'sentry',
  'stripe',
  'deepl',
  'wikipedia',
  'wiktionary',
  'readest.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'storage.readest.com',
  'cloudflarestorage.com',
  'onlinewebfonts.com',
  'openai.com',
  'ollama',
];
const FORBIDDEN_TOKENS = ['wss://', 'new WebSocket', "from 'ws'"];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(join(dir, entry.name)));
    } else if (/\.(ts|tsx|js|jsx|mjs|rs|json|html|css|toml)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('offline guard', () => {
  test('runtime sources contain no cloud hosts or protocols', () => {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const token of [...FORBIDDEN_HOSTS, ...FORBIDDEN_TOKENS]) {
          if (text.includes(token)) hits.push(`${file}: ${token}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test('parallel read feature is removed', () => {
    expect(existsSync(join(APP_ROOT, 'src', 'store', 'parallelViewStore.ts'))).toBe(false);
    expect(
      existsSync(join(APP_ROOT, 'src', '__tests__', 'store', 'parallel-view-store.test.ts')),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 运行离线防护测试**

```powershell
cd apps\readest-app
pnpm test -- --run src/__tests__/offline-guard.test.ts
```

期望全部 PASS。若失败，按命中文件回到对应 Task 清理后再跑。

- [ ] **Step 3: 全量前端验证**

```powershell
pnpm lint
pnpm test
pnpm build
```

期望全部通过，`out/` 重新生成。

- [ ] **Step 4: 全量 Rust 验证**

```powershell
cd src-tauri
cargo clippy -p Readest --no-deps -- -D warnings
cargo test -p Readest --lib
```

期望通过；若 clippy 报未使用依赖/死代码，按提示删除。

- [ ] **Step 5: 生成最终网络审计报告**

```powershell
cd ..\..
rg -n -i "https?://|wss?://" apps/readest-app/src apps/readest-app/src-tauri apps/readest-app/public --glob '!**/__tests__/**' --glob '!**/gen/**' --glob '!**/target/**' --glob '!**/.next/**' > docs\offline-audit\offline-audit-report.txt
```

期望报告为空文件（0 行）；若非空，逐条清理后重跑。

- [ ] **Step 6: 创建便携打包脚本**

创建 `apps/readest-app/scripts/build-portable.ps1`：

```powershell
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExeName = 'readest.exe'
)
$exe = Join-Path $Root "src-tauri\target\release\$ExeName"
if (-not (Test-Path $exe)) { throw "Release exe not found: $exe" }
$outDir = Join-Path $Root 'release\readest-local'
New-Item -ItemType Directory -Force $outDir | Out-Null
Copy-Item $exe (Join-Path $outDir ([System.IO.Path]::GetFileNameWithoutExtension($ExeName) + '-local.exe')) -Force
@(
  'Readest Local 便携版',
  '直接运行 exe，无需安装。',
  '需要系统已安装 Microsoft Edge WebView2 Runtime（Windows 11 自带）。',
  '数据默认保存在系统应用数据目录。'
) | Set-Content -Path (Join-Path $outDir 'README.txt') -Encoding utf8
Write-Output "Portable build created at $outDir"
```

- [ ] **Step 7: 构建便携版**

```powershell
cd apps\readest-app
pnpm tauri build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-portable.ps1
```

期望：`release\readest-local\readest-local.exe` 存在；不产生 NSIS/MSI 安装包；WebView2 依赖已在 README.txt 说明。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "test: add offline guard and full verification"
```

---

### Task 10: 文档与发布收尾

**Files:**
- Modify: `README.md`、`apps/readest-app/package.json`（name/productName 改为 `readest-local`）、`apps/readest-app/src-tauri/tauri.conf.json`（productName、identifier 改为本地名称）
- Create: `docs/offline-audit/README.md`（审计说明）

**Interfaces:**
- Consumes: Task 9 验证通过的产物
- Produces: 面向用户的离线版文档与最终提交

- [ ] **Step 1: 更新应用名称**

`apps/readest-app/package.json` 的 `name` 改为 `readest-local`；`src-tauri/tauri.conf.json` 的 `productName` 改为 `Readest Local`、`mainBinaryName` 改为 `readest-local`、`identifier` 改为 `com.local.readest`。

- [ ] **Step 2: 更新 README**

README 改为离线版说明：保留功能清单、构建命令（`pnpm install && pnpm tauri build`）、离线验收步骤、AGPL-3.0 声明。删除所有官网/Web/同步/翻译/支付相关介绍。

- [ ] **Step 3: 编写审计说明**

`docs/offline-audit/README.md` 说明：网络审计如何运行（`rg` 扫描 + `offline-guard.test.ts`）、审计报告位置、为什么 CSP 只允许本地协议。

- [ ] **Step 4: 重新构建验证改名后的便携版**

```powershell
cd apps\readest-app
pnpm tauri build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -ExeName readest-local.exe
```

期望：`release\readest-local\readest-local.exe` 存在且可运行。

- [ ] **Step 5: 最终检查**

```powershell
git status --short
git log --oneline -15
```

确认工作区干净、提交历史按任务编号清晰。

- [ ] **Step 6: 最终提交**

```powershell
git add -A
git commit -m "docs: finalize readest-local offline edition"
```

---

## 验收清单（用户手动执行）

1. 断开网络后从便携目录 `release\readest-local\readest-local.exe` 启动。
2. 导入 EPUB、PDF、TXT 各一本，确认能打开并阅读。
3. 验证滚动/翻页、字体/主题、全文搜索、高亮/笔记/书签。
4. 验证本地词典（导入 MDict 词典文件）与本地 TTS（系统语音）。
5. 验证备份/导出 zip 可正常生成和恢复。
6. 确认界面没有任何同步、翻译、AI、订阅、分享、更新入口。
7. 用防火墙/代理或任务管理器确认应用运行期间无网络连接尝试。
8. 确认无 `readest.com`、Supabase、PostHog、Sentry、Stripe 等外部域名流量。

## 风险与注意事项

- AGPL-3.0：本项目修改自 Readest，分发时必须保留 AGPL-3.0 并公开源码；本计划不改变许可证。
- 字体本地化是"暗网流量"最大来源之一，必须把 `fonts.ts` 与 CSP 一起清理，否则离线验收会失败。
- `pnpm test` 原有大量云服务测试（sync、stripe、send 等）会随 Task 2-5 删除；若删除后仍有引用导致失败，以 Task 5 的引用清单继续清理，不要保留云测试。
- Next.js 同时存在 `src/app` 与 `src/pages`；删除 `src/pages/api` 不影响 Tauri 入口，`src/pages/_app.tsx`、`_document.tsx` 保留。
- Tauri 的 `gen/` 目录是自动生成文件，网络扫描需跳过；`tauri build` 会重新生成。
- Rust 侧 `reqwest` 删除前先确认 `range_file.rs`、`epub_parser.rs` 没有使用；本计划中这三个文件保留。
- 便携版不捆绑 WebView2：目标机器需已安装 Microsoft Edge WebView2 Runtime（Windows 11 自带），`README.txt` 会注明。

## Self-Review

- 规格覆盖：目标（全离线、Windows、无平行阅读）由 Task 6/8/9 覆盖；保留功能由 Task 3/5/8 覆盖；云功能删除由 Task 1/2/4/5/7/8 覆盖；许可证由 Global Constraints 与 Task 10 覆盖。
- 占位符扫描：所有删除命令均给出精确路径；修改类步骤给出 `rg` 定位命令与处理规则；测试代码为完整可运行内容。
- 类型一致性：`offline-guard.test.ts` 中 `APP_ROOT = join(__dirname, '..', '..')` 对应测试文件位于 `apps/readest-app/src/__tests__/`，运行时位于 `apps/readest-app`，与 Task 9 Step 2 的运行目录一致。

## Execution Handoff

计划完成后提供两种执行方式：

1. **Subagent-Driven（推荐）**：每个 Task 由新 subagent 执行，完成后做两阶段审查，迭代快、上下文干净。
2. **Inline Execution**：在当前会话按 Task 批量执行，每个 checkpoint 由用户确认后再继续。
