# 项目约定：构建/清理与便携版数据（readest-local）

## 构建缓存清理规则

**可安全删除**（均为可重建的构建产物）：
- `target/` — Rust/Cargo 编译产物
- `apps/readest-app/.next/` — Next.js 构建缓存
- `apps/readest-app/out/` — 静态导出

**切勿随缓存删除**：
- `apps/readest-app/release/` — **便携版成品目录**。其下 `release/readest-local/` 的 exe **同目录**存放 `settings.json` 与 `Readest/` 子目录，这些是**用户数据**（书库、字体、主题、布局），删除 = 不可逆丢数据。便携版数据与安装版数据（`%APPDATA%\com.local.readest\Readest`）相互独立，删除 release/ 不影响安装版。

## 操作约束

- 清理前先用 `du -sh` 逐一确认目标内容；对任何可能含用户数据/成品产物的目录，先向用户确认且不直接 `rm -rf`。
- 便携版重建：运行根目录 `打包便携版.bat`（先 `pnpm tauri build --no-bundle` 编译，再组装到 release/readest-local/）。
- 2026-08-23 教训：因把 release/ 当纯缓存误删，可能连带便携版 exe 同目录用户数据。