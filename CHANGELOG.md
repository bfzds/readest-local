# 更新日志（Changelog）

本文件基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0) 格式维护。本仓库为个人 fork，tag 采用 `cef-preview-*` 形式的日期快照，**不遵循语义化版本（SemVer）**。

## [Unreleased]

### Fixed

- **EPUB 虚拟目录：nav.json 污染的结构性免疫**。虚拟目录条目是用户数据（存 `Books/{hash}/config.json`），绝不应进入缓存文件 nav.json；此前止血只靠「nav 计算前剥离」的调用顺序，且生产环境命中缓存时永不重写，历史污染无法自愈，一旦虚拟目录不再应用就会以幽灵重复条目暴露。现改为三处出入口结构性拒绝：`computeBookNav` 入口过滤（剥离顺序不再是正确性前提）、`isBookNavCacheCurrent` 对含 CFI-href/负 id 条目的缓存判失效（下次打开即重算并回写干净缓存）、`saveBookNav` 写盘前过滤。
- **EPUB 虚拟目录：书名条目不再永久高亮**。单 section 书里指向整个正文文件的书名条目（无锚点、可导航跨度占全书 ≥90%）没有章节粒度，此前只要在读书就会被 foliate 的目录进度恒命中而永久点亮；现按「可导航跨度占比」将其排除出「当前章节」高亮（条目仍在列表中显示，点击跳转、侧栏滚动定位与自动展开不受影响）。

[Unreleased]: https://github.com/bfzds/readest-local/compare/cef-preview-20260906-2...readest-local
