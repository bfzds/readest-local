# Readest Review Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-08-31 代码复核确认的搜索硬上限、命令面板焦点、跨窗口陈旧锁、Annotator 监听器生命周期、验证证据和当前 lint 红线。

**Architecture:** 每个问题保持独立提交。前端缺陷在现有 service/component 边界内做最小修复；跨窗口锁继续使用 Tauri 应用数据目录中的独占锁文件，但增加“本进程启动前遗留锁”的安全恢复；Annotator 把 section 监听器登记与替换清理抽成一个小型、可单测的 registry。所有实现先由实施模型写失败测试，Luna 只负责独立运行计划中的验证命令并回传退出码和失败项。

**Tech Stack:** TypeScript 5.7、React 19、Vitest 4、Vitest Browser + Playwright、Next.js 16、Tauri 2、Rust 2021、pnpm 11。

**Spec:** `docs/reports/perf-debug-report-2026-08-31.md`

## Global Constraints

- 目标平台是 Tauri 桌面端；不为 web-only 场景增加优化或分支。
- 不升级依赖，不新增 npm/Rust crate；锁恢复只使用 `std` 和现有 Tauri API。
- 严格 test-first：每个行为修复先得到能稳定失败的最小测试，再改生产代码。
- Luna 只运行测试、记录工作目录、命令、耗时、退出码和失败项；不修改代码。
- 不使用 Codex 内置浏览器启动、访问或验证本地项目。
- 当前固定点为 `c928221`。实施时用项目脚本创建隔离 worktree：`pnpm worktree:new codex/review-findings-remediation`。
- 不覆盖当前工作区未提交的报告、`CLAUDE.md` 或用户文件；执行前先保存 `git status --short`。
- 当前已知基线：前端 5750 通过 / 10 跳过；Rust 57 通过；Biome 2 错误 + 1 warning；browser 242 通过 / 11 失败。
- 11 个 browser 失败尚未完成系统化根因诊断，不得在本批次中顺手修改相关组件或截图基线。
- 每个 Task 单独提交；一个 Task 未通过验收时只回滚该 Task，不回滚已经验证的其他提交。

---

## File Map

| 文件 | 职责 | 计划动作 |
|---|---|---|
| `apps/readest-app/src/services/librarySearchService.ts` | 搜索 service 的最终结果预算 | 每个 section 合并前重算剩余额度 |
| `apps/readest-app/src/__tests__/services/library-search-service.test.ts` | 搜索索引、worker 与硬上限回归 | 增加缓存索引多 section 超发测试 |
| `apps/readest-app/src/components/command-palette/CommandPalette.tsx` | 命令面板键盘与焦点陷阱 | 仅在焦点离开 dialog 后返焦 input |
| `apps/readest-app/src/__tests__/components/CommandPalette.test.tsx` | 命令面板 DOM 焦点回归 | 等待 RAF 后断言 Tab/Shift+Tab 最终焦点 |
| `apps/readest-app/src-tauri/src/library_lock.rs` | 跨 WebView 文件锁 | 抽出可测文件函数并恢复启动前遗留锁 |
| `apps/readest-app/src-tauri/src/lib.rs` | Tauri 启动入口 | 在窗口可保存前记录进程启动时间 |
| `apps/readest-app/src/services/nativeAppService.ts` | 前端锁 acquire/release 包装 | 不再静默吞掉 release 错误 |
| `apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts` | JS 保存串行化回归 | 用 barrier 证明 read-merge-write 顺序 |
| `apps/readest-app/src/app/reader/components/annotator/sectionListenerRegistry.ts` | section 文档与 cleanup 对应关系 | 新建可单测 registry |
| `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx` | section 输入监听器挂载 | 接入 registry，替换 section 时立即清理旧 doc |
| `apps/readest-app/src/__tests__/components/section-listener-registry.test.ts` | registry 生命周期测试 | 新建 |
| `apps/readest-app/src/utils/throttle.ts` | throttle 类型与运行时 | 用参数元组泛型移除 `any` |
| `docs/reports/revision-fix-report-2026-08-31.md` | 上一轮实施事实 | 修正 C-6 状态和验证证据 |
| `docs/reports/perf-debug-report-2026-08-31.md` | 本轮复核事实 | 在最终验证后追加修复状态 |
| `.claude/skills/perf-debug/SKILL.md` | 项目调试快照 | 只更新 SNAPSHOT 区 |
| `docs/reports/PERF-DEBUG-LATEST.md` | 最新报告指针 | 仅在生成新报告时更新 |

---

### Task 0: 建立实施基线和保护边界

**Files:**
- Read: `apps/readest-app/package.json`
- Read: `apps/readest-app/.claude/rules/test-first.md`
- Read: `apps/readest-app/.claude/rules/verification.md`
- Read: `docs/reports/perf-debug-report-2026-08-31.md`

**Interfaces:**
- Consumes: 当前 worktree、依赖缓存和 `c928221` 基线。
- Produces: 一份只存在于任务日志中的基线记录；不修改文件、不提交。

- [ ] **Step 1: 创建隔离 worktree**

Run from repository root:

```powershell
pnpm worktree:new codex/review-findings-remediation
```

Expected: 命令退出码 0；新 worktree 已初始化子模块、依赖和 `.env`。

- [ ] **Step 2: 记录固定点和工作区状态**

Run:

```powershell
git rev-parse --short HEAD
git status --short --branch
```

Expected: HEAD 可解析；开始编码前无意外生产代码改动。若 HEAD 不是 `c928221`，记录新 HEAD，并重新核对本计划中的行号和符号。

- [ ] **Step 3: 由 Luna 复制基线测试**

Working directory: `apps/readest-app`

```powershell
pnpm test -- run
pnpm lint
pnpm fmt:check
pnpm clippy:check
pnpm test:rust
pnpm test:browser
```

Expected baseline:

- `pnpm test -- run`: 5750 通过、10 跳过，退出码 0。
- `pnpm lint`: 仅 `src/utils/throttle.ts:5,14` 两个 `noExplicitAny` 错误和既有 mdict warning。
- Rust 三项退出码 0，57 个 Rust 单测通过。
- browser 保持 242 通过、11 失败；失败集合不能扩大。

- [ ] **Step 4: 基线漂移处理**

若失败集合与上表不同，停止实现。主模型先判断是环境漂移、HEAD 漂移还是新回归；不得把新增失败标成“既有问题”。

---

### Task 1: 修复缓存索引路径的搜索硬上限

**Files:**
- Modify: `apps/readest-app/src/services/librarySearchService.ts:767-810`
- Modify: `apps/readest-app/src/__tests__/services/library-search-service.test.ts:604-630`

**Interfaces:**
- Consumes: `bookMatches`、`totalMatches`、`MAX_BOOK_SEARCH_RESULTS`、`MAX_TOTAL_SEARCH_RESULTS`。
- Produces: 每个 section 合并前重新计算的 `remaining`；任何 worker 超发都不能让单本或全库结果越界。

- [ ] **Step 1: 写缓存索引多 section 超发失败测试**

在 `Task5 service hard cap` describe 中新增异步测试。先执行一次真实搜索建立 `search.db`，第二次搜索才 mock worker，从而确定走缓存索引路径：

```ts
it('缓存索引批内多个 section 超发时仍按当前剩余额度截断', async () => {
  const book = makeBook('indexed-over', 'Indexed Over');
  const file = makeFile('# A\nseed\n\n# B\nseed\n\n# C\nseed');
  const service = makeService(new Map([['indexed-over', file]]));
  const session = createLibrarySearchSession(service);

  for await (const _event of searchLibraryBooks(service, [book], 'seed', { config, session })) {
    // 首次搜索只负责建立持久索引。
  }

  vi.spyOn(session.searchWorker, 'searchBatch').mockImplementation(async (sections) =>
    sections.map((section, index) => ({
      sectionKey: section.sectionKey,
      matches: Array.from({ length: index === 0 ? 300 : 800 }, (_, offset) => ({
        start: offset,
        end: offset + 1,
        runs: [],
      })),
      truncated: true,
    })),
  );

  const events = [];
  for await (const event of searchLibraryBooks(service, [book], 'x', {
    config: { ...config, mode: 'fuzzy' },
    session,
  })) {
    events.push(event);
  }

  const total = events
    .filter((event) => event.type === 'result')
    .reduce((sum, event) => sum + event.result.subitems.length, 0);
  expect(service.loadBookContent).toHaveBeenCalledTimes(1);
  expect(total).toBe(500);
  expect(events.at(-1)).toMatchObject({ type: 'completed', matchCount: 500, truncated: true });
  await session.close();
});
```

- [ ] **Step 2: 运行测试并确认红灯**

```powershell
pnpm test -- run src/__tests__/services/library-search-service.test.ts -t "缓存索引批内多个 section"
```

Expected: FAIL；修复前总数大于 500。若测试没有走缓存路径，先检查 `loadBookContent` 调用次数，不能修改期望值掩盖路径错误。

- [ ] **Step 3: 在每个 section 合并前重算预算**

保留批次开始前的快速退出检查，但把实际 slice 额度放进内层循环：

```ts
const batchRemaining = Math.min(
  MAX_BOOK_SEARCH_RESULTS - bookMatches,
  MAX_TOTAL_SEARCH_RESULTS - totalMatches,
);
if (batchRemaining <= 0) {
  bookTruncated = true;
  break;
}

const batch = sections.slice(offset, offset + SEARCH_WORKER_BATCH_SIZE);
const outcomes = await matchSectionsBatch(
  book,
  batch.map((section) => ({
    sectionIndex: section.idx,
    text: section.text,
    locale,
  })),
);
for (let i = 0; i < batch.length; i++) {
  const remaining = Math.min(
    MAX_BOOK_SEARCH_RESULTS - bookMatches,
    MAX_TOTAL_SEARCH_RESULTS - totalMatches,
  );
  if (remaining <= 0) {
    bookTruncated = true;
    break;
  }
  const capped = outcomes[i]!.matches.slice(0, remaining);
  // 保留现有 toSubitems、计数、yield 和 truncated 逻辑。
}
```

不得只修改 worker 的 `limit`；service 必须保留最终防御性截断。
同时更新 `matchSectionsBatch` 上方“批内塞满上限”的注释，明确 worker 共享预算是第一层限制，service 逐 section 重算是最终硬边界。

- [ ] **Step 4: 运行搜索专项测试**

```powershell
pnpm test -- run src/__tests__/services/library-search-service.test.ts
```

Expected: 文件内全部通过；新增用例总数严格等于 500。

- [ ] **Step 5: 运行性能基准，确认没有异常放大**

```powershell
pnpm bench library-search --no-record
```

Expected: 退出码 0。记录机器、每个规模的数值；本修复是结果集合并逻辑，不应让无命中扫描产生数量级退化。

- [ ] **Step 6: 提交 Task 1**

```powershell
git add apps/readest-app/src/services/librarySearchService.ts apps/readest-app/src/__tests__/services/library-search-service.test.ts
git commit -m "fix: enforce indexed search result budget per section"
```

---

### Task 2: 修复 CommandPalette 的 RAF 返焦竞争

**Files:**
- Modify: `apps/readest-app/src/components/command-palette/CommandPalette.tsx:188-197`
- Modify: `apps/readest-app/src/__tests__/components/CommandPalette.test.tsx:72-85,148-201`

**Interfaces:**
- Consumes: `inputRef`、dialog DOM、`document.activeElement`。
- Produces: 焦点仍在 dialog 内时尊重 Tab 目标；焦点离开 dialog 或落到 body 时才返焦 input。

- [ ] **Step 1: 把 Tab 测试改成等待 RAF 的真实最终状态**

增加测试 helper：

```ts
const nextAnimationFrame = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
```

把现有 Tab 用例改成 `async`，第一次 Tab 和 Shift+Tab 后都等待 RAF：

```ts
fireEvent.keyDown(dialog, { key: 'Tab' });
await nextAnimationFrame();
expect(document.activeElement).toBe(screen.getByLabelText('Clear search'));

input.focus();
fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
await nextAnimationFrame();
expect(document.activeElement).toBe(optionOf('B1'));
```

保留原有“点击外部后返焦 input”测试，确保修复没有删除页面快捷键保护。

- [ ] **Step 2: 运行测试并确认红灯**

```powershell
pnpm test -- run src/__tests__/components/CommandPalette.test.tsx -t "Tab/Shift+Tab"
```

Expected: FAIL；等待 RAF 后焦点回到 input。

- [ ] **Step 3: 仅在焦点离开 dialog 时返焦**

把 `onBlur` 的 RAF 回调改为检查最近的 dialog：

```tsx
onBlur={() => {
  if (!isOpen || !document.hasFocus()) return;
  requestAnimationFrame(() => {
    const input = inputRef.current;
    const dialog = input?.closest<HTMLElement>('[role="dialog"]');
    if (input && dialog && !dialog.contains(document.activeElement)) {
      input.focus();
    }
  });
}}
```

不得通过删除 `onBlur`、删除 `preventDefault()` 或放宽测试来规避竞争。

- [ ] **Step 4: 运行组件测试**

```powershell
pnpm test -- run src/__tests__/components/CommandPalette.test.tsx
```

Expected: Tab 循环和外部返焦两类测试都通过。

- [ ] **Step 5: 运行 browser 基线并做桌面键盘验收**

先运行现有 browser 套件，确认失败集合没有新增 CommandPalette 项：

```powershell
pnpm test:browser
```

Expected: 失败集合不超过既有 5 文件 / 11 用例，且没有 CommandPalette 失败。

随后运行 `pnpm tauri:dev:test`，由人工在可见桌面窗口执行一次键盘矩阵并记录结果：

1. 打开命令面板并输入能产生至少两个结果的查询。
2. 连续按 Tab，焦点顺序必须是 input → clear → 第一个结果 → 第二个结果。
3. 从 input 按 Shift+Tab，焦点必须落到最后一个结果。
4. 点击 dialog 外部后，焦点必须回到 input；方向键不得传给阅读页。

- [ ] **Step 6: 提交 Task 2**

```powershell
git add apps/readest-app/src/components/command-palette/CommandPalette.tsx apps/readest-app/src/__tests__/components/CommandPalette.test.tsx
git commit -m "fix: preserve command palette tab focus after blur"
```

---

### Task 3: 恢复启动前遗留的 library.lock，并补足锁测试

**Files:**
- Modify: `apps/readest-app/src-tauri/src/library_lock.rs:12-100`
- Modify: `apps/readest-app/src-tauri/src/lib.rs:190-191`
- Modify: `apps/readest-app/src/services/nativeAppService.ts:780-803`
- Modify: `apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts:16-81`

**Interfaces:**
- Consumes: `library.lock` 路径、当前进程启动时间、owner token、5000ms 前端等待上限。
- Produces: `initialize_process_start()`；可单测的 `acquire_lock_file()`；启动前遗留锁可恢复，当前进程创建的新鲜锁绝不被抢占。

- [ ] **Step 1: 先写 Rust 文件级失败测试**

把命令内部文件操作抽成接受 `&Path` 和 `SystemTime` 的私有函数后，先增加测试目录 helper：

```rust
fn unique_test_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "readest-library-lock-{label}-{}-{}",
        std::process::id(),
        new_token()
    ))
}
```

再写以下测试：

```rust
#[test]
fn removes_lock_that_predates_process_start() {
    let dir = unique_test_dir("stale");
    let path = dir.join(LOCK_FILENAME);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, "old-owner").unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let process_started_at = modified + Duration::from_secs(1);

    let lock = acquire_lock_file(&path, 100, process_started_at).unwrap();
    assert_ne!(lock.token, "old-owner");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), lock.token);

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn never_steals_lock_created_after_process_start() {
    let dir = unique_test_dir("fresh");
    let path = dir.join(LOCK_FILENAME);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, "live-owner").unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let process_started_at = modified
        .checked_sub(Duration::from_secs(1))
        .unwrap_or(UNIX_EPOCH);

    let error = acquire_lock_file(&path, 10, process_started_at)
        .err()
        .expect("fresh lock must time out");
    assert!(error.contains("timeout"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "live-owner");

    std::fs::remove_dir_all(dir).unwrap();
}
```

`unique_test_dir` 使用 `std::env::temp_dir()`、当前 pid 和 `new_token()` 生成目录；测试自己只删除自己创建的目录。

- [ ] **Step 2: 写错误 token 和正确 token 释放测试**

```rust
#[test]
fn release_requires_matching_token() {
    let dir = unique_test_dir("release");
    let path = dir.join(LOCK_FILENAME);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, "owner").unwrap();

    assert!(release_lock_file(&path, "other").is_err());
    assert!(path.exists());
    release_lock_file(&path, "owner").unwrap();
    assert!(!path.exists());

    std::fs::remove_dir_all(dir).unwrap();
}
```

- [ ] **Step 3: 运行 Rust 测试并确认红灯**

```powershell
cargo test -p Readest --lib library_lock -- --nocapture
```

Expected: 新 helper 尚未实现，编译或断言失败。

- [ ] **Step 4: 实现进程启动时间和安全陈旧锁恢复**

在 `library_lock.rs` 增加：

```rust
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PROCESS_STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

pub fn initialize_process_start() {
    let _ = PROCESS_STARTED_AT.set(SystemTime::now());
}

fn process_started_at() -> SystemTime {
    *PROCESS_STARTED_AT.get_or_init(SystemTime::now)
}

fn predates_process_start(path: &Path, started_at: SystemTime) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|modified| modified < started_at)
        .unwrap_or(false)
}
```

把现有循环移入：

```rust
fn acquire_lock_file(
    lock_path: &Path,
    timeout_ms: u64,
    started_at: SystemTime,
) -> Result<LibraryLock, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let token = new_token();
        match OpenOptions::new().write(true).create_new(true).open(lock_path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(token.as_bytes()) {
                    let _ = std::fs::remove_file(lock_path);
                    return Err(format!("write library lock token: {error}"));
                }
                return Ok(LibraryLock { path: lock_path.to_path_buf(), token });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if predates_process_start(lock_path, started_at) {
                    let stale_path = lock_path.with_extension(format!("stale-{}", new_token()));
                    match std::fs::rename(lock_path, &stale_path) {
                        Ok(()) => {
                            let _ = std::fs::remove_file(stale_path);
                            continue;
                        }
                        Err(rename_error)
                            if rename_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            continue;
                        }
                        Err(_) => {}
                    }
                }
            }
            Err(error) => return Err(format!("create library lock: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("library save lock timeout: another window is saving".to_string());
        }
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS as u64));
    }
}
```

命令包装只负责解析路径：

```rust
pub fn acquire_library_lock(app: tauri::AppHandle, timeout_ms: u64) -> Result<LibraryLock, String> {
    acquire_lock_file(&lock_path(&app)?, timeout_ms, process_started_at())
}
```

在 `lib.rs` 的 `run()` 第一行初始化，必须早于任何 WebView 保存行为：

```rust
pub fn run() {
    library_lock::initialize_process_start();
    let builder = tauri::Builder::default();
    // existing builder chain
}
```

- [ ] **Step 5: 抽出可测试 release helper**

```rust
fn release_lock_file(lock_path: &Path, token: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(lock_path).map_err(|e| format!("read lock: {e}"))?;
    if content.trim() != token {
        return Err("library lock owned by another token; refusing to release".to_string());
    }
    std::fs::remove_file(lock_path).map_err(|e| format!("remove lock: {e}"))
}
```

Tauri command 将字符串路径转换为 `Path` 后调用 helper。

- [ ] **Step 6: 让前端 release 失败可见但不覆盖保存结果**

`releaseLibraryLock` 不再内部 `.catch(() => {})`：

```ts
override async releaseLibraryLock(lock: LibraryLock): Promise<void> {
  await invoke('release_library_lock', { lockPath: lock.path, token: lock.token });
}
```

`saveLibraryBooks` 的 finally 记录错误，不能静默，也不能把已经成功的 library 保存改成失败：

```ts
} finally {
  if (lock) {
    try {
      await this.releaseLibraryLock(lock);
    } catch (error) {
      console.error('Failed to release library save lock:', error);
    }
  }
}
```

- [ ] **Step 7: 用 barrier 加强 JS 并发测试**

给 `MemSaveService` 增加可控 barrier，使窗口 A 在 read 后停住，窗口 B 已发起但不能进入 read；释放 A 后再验证 B 读到 A 的写入：

```ts
let releaseFirstWrite!: () => void;
const firstWriteGate = new Promise<void>((resolve) => {
  releaseFirstWrite = resolve;
});
let writes = 0;

protected override fs = {
  readFile: async (): Promise<unknown> => this.mem,
  writeFile: async (_path: string, _base: unknown, data: string): Promise<void> => {
    writes += 1;
    if (writes === 1) await firstWriteGate;
    this.mem = data;
  },
} as unknown as FileSystem;
```

测试先启动 A，再启动 B；在释放 gate 前断言 `writes === 1`，释放后等待两者完成并断言 B 的 LWW 结果保留。

- [ ] **Step 8: 运行锁专项验证**

```powershell
pnpm test -- run src/__tests__/services/library-save-concurrency.test.ts
pnpm fmt:check
pnpm clippy:check
pnpm test:rust
```

Expected: 全部退出码 0；Rust 现有 57 条基础上增加新锁测试。

- [ ] **Step 9: 提交 Task 3**

```powershell
git add apps/readest-app/src-tauri/src/library_lock.rs apps/readest-app/src-tauri/src/lib.rs apps/readest-app/src/services/nativeAppService.ts apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts
git commit -m "fix: recover stale library save locks after restart"
```

---

### Task 4: 让 Annotator 在 section 文档替换时立即清理旧监听器

**Files:**
- Create: `apps/readest-app/src/app/reader/components/annotator/sectionListenerRegistry.ts`
- Create: `apps/readest-app/src/__tests__/components/section-listener-registry.test.ts`
- Modify: `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx:340-435,587-598`

**Interfaces:**
- Consumes: section `index`、`Document`、为该 doc 创建的幂等 cleanup。
- Produces: `SectionListenerRegistry.replace(index, doc, cleanup)`、`disposeDocument(doc)`、`disposeAll()`。

- [ ] **Step 1: 写 registry 失败测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSectionListenerRegistry } from '@/app/reader/components/annotator/sectionListenerRegistry';

describe('section listener registry', () => {
  it('同一 index 替换 doc 时立即清理旧 doc', () => {
    const registry = createSectionListenerRegistry();
    const first = document.implementation.createHTMLDocument();
    const second = document.implementation.createHTMLDocument();
    const cleanupFirst = vi.fn();
    const cleanupSecond = vi.fn();

    expect(registry.replace(3, first, cleanupFirst)).toBe(true);
    expect(registry.replace(3, second, cleanupSecond)).toBe(true);
    expect(cleanupFirst).toHaveBeenCalledOnce();
    expect(cleanupSecond).not.toHaveBeenCalled();
  });

  it('同一 doc 重复 load 不重复注册', () => {
    const registry = createSectionListenerRegistry();
    const doc = document.implementation.createHTMLDocument();
    const cleanup = vi.fn();
    expect(registry.replace(1, doc, cleanup)).toBe(true);
    expect(registry.replace(1, doc, vi.fn())).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('disposeAll 只调用每个活动 cleanup 一次', () => {
    const registry = createSectionListenerRegistry();
    const cleanup = vi.fn();
    registry.replace(1, document.implementation.createHTMLDocument(), cleanup);
    registry.disposeAll();
    registry.disposeAll();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 运行测试并确认红灯**

```powershell
pnpm test -- run src/__tests__/components/section-listener-registry.test.ts
```

Expected: FAIL；模块尚不存在。

- [ ] **Step 3: 实现小型 registry**

```ts
export interface SectionListenerRegistry {
  replace: (index: number, doc: Document, cleanup: () => void) => boolean;
  disposeDocument: (doc: Document) => void;
  disposeAll: () => void;
}

export const createSectionListenerRegistry = (): SectionListenerRegistry => {
  const cleanupByDoc = new WeakMap<Document, () => void>();
  const docByIndex = new Map<number, Document>();
  const activeCleanups = new Set<() => void>();

  const disposeDocument = (doc: Document) => {
    const cleanup = cleanupByDoc.get(doc);
    if (!cleanup) return;
    cleanupByDoc.delete(doc);
    activeCleanups.delete(cleanup);
    cleanup();
    for (const [index, current] of docByIndex) {
      if (current === doc) docByIndex.delete(index);
    }
  };

  return {
    replace(index, doc, cleanup) {
      if (cleanupByDoc.has(doc)) return false;
      const previous = docByIndex.get(index);
      if (previous && previous !== doc) disposeDocument(previous);
      let disposed = false;
      const once = () => {
        if (disposed) return;
        disposed = true;
        cleanup();
      };
      cleanupByDoc.set(doc, once);
      activeCleanups.add(once);
      docByIndex.set(index, doc);
      return true;
    },
    disposeDocument,
    disposeAll() {
      for (const cleanup of [...activeCleanups]) cleanup();
      activeCleanups.clear();
      docByIndex.clear();
    },
  };
};
```

- [ ] **Step 4: 接入 Annotator**

用一个 ref 替换 `WeakSet` 和 cleanup 数组：

```ts
const sectionListenersRef = useRef(createSectionListenerRegistry());

useEffect(() => () => sectionListenersRef.current.disposeAll(), []);
```

`onLoad` 先构造所有具名 handler 和 `cleanup`，再登记；如果登记返回 `false`，不要重复 mount。为避免先 mount 后发现重复，流程必须改成：

1. `if (!doc) return`。
2. 构造 `disposers`、handler 和 cleanup。
3. 调用 `replace(index, doc, cleanup)`。
4. 仅当返回 `true` 时执行现有 `mount(...)` 列表。

由于 cleanup 需要拿到 mount 后填充的 `disposers`，其闭包可在 mount 前创建。不得保留旧 `attachedSectionDocsRef` 或 `sectionListenerCleanupsRef`。

- [ ] **Step 5: 增加文档 pagehide 主动清理**

在 mount 列表末尾给当前 doc 增加一次性 `pagehide`：

```ts
const handlePageHide = () => sectionListenersRef.current.disposeDocument(doc);
doc.defaultView?.addEventListener('pagehide', handlePageHide, { once: true });
disposers.push(() => doc.defaultView?.removeEventListener('pagehide', handlePageHide));
```

这条路径负责 index 尚未复用、但 iframe 已销毁的情况。

- [ ] **Step 6: 运行 registry 和 reader 回归**

```powershell
pnpm test -- run src/__tests__/components/section-listener-registry.test.ts
pnpm test -- run src/__tests__/components/reader
```

如果第二条路径不存在，用 `rg --files src/__tests__ | rg "reader|annotator"` 列出实际相关文件并逐个运行；不得把“没有测试文件”写成通过。

- [ ] **Step 7: 提交 Task 4**

```powershell
git add apps/readest-app/src/app/reader/components/annotator/sectionListenerRegistry.ts apps/readest-app/src/app/reader/components/annotator/Annotator.tsx apps/readest-app/src/__tests__/components/section-listener-registry.test.ts
git commit -m "fix: dispose annotator listeners when sections are replaced"
```

---

### Task 5: 清理 throttle 的两处 noExplicitAny 基线错误

**Files:**
- Modify: `apps/readest-app/src/utils/throttle.ts:5-18`
- Test: 现有 throttle 测试文件，通过 `rg -n "throttle" src/__tests__` 定位

**Interfaces:**
- Consumes: 任意参数元组 `TArgs` 和返回 `void | Promise<void>` 的函数。
- Produces: 无 `any` 的 `ThrottledFunction<TArgs>`；运行时行为不变。

- [ ] **Step 1: 确认当前 lint 红灯**

```powershell
pnpm exec biome lint src/utils/throttle.ts
```

Expected: `src/utils/throttle.ts:5,14` 两个 `noExplicitAny` 错误。

- [ ] **Step 2: 改为参数元组泛型**

```ts
export type ThrottledFunction<TArgs extends unknown[]> = ((...args: TArgs) => void) & {
  flush: () => void;
  cancel: () => void;
};

export const throttle = <TArgs extends unknown[]>(
  func: (...args: TArgs) => void | Promise<void>,
  delay: number,
  options: ThrottleOptions = { emitLast: true },
): ThrottledFunction<TArgs> => {
  let lastArgs: TArgs | null = null;
  // 其余运行时逻辑保持不变。
};
```

同步把内部 cast 从 `ThrottledFunction<T>` 改为 `ThrottledFunction<TArgs>`。不得用 `biome-ignore`、`unknown as any` 或降低 lint 规则。

- [ ] **Step 3: 运行类型、lint 和 throttle 回归**

```powershell
pnpm lint
pnpm test -- run -t "throttle"
```

Expected: `pnpm lint` 退出码 0，最多保留 mdict 既有 warning；throttle 的 flush/cancel/emitLast 测试全部通过。

- [ ] **Step 4: 提交 Task 5**

```powershell
git add apps/readest-app/src/utils/throttle.ts
git commit -m "fix: type throttle arguments without explicit any"
```

---

### Task 6: 修正状态报告并执行最终回归

**Files:**
- Modify: `docs/reports/revision-fix-report-2026-08-31.md:63-83`
- Modify: `docs/reports/perf-debug-report-2026-08-31.md`
- Modify: `.claude/skills/perf-debug/SKILL.md` (`SNAPSHOT-BEGIN/END` only)
- Modify: `docs/reports/PERF-DEBUG-LATEST.md` only if a new dated report is created

**Interfaces:**
- Consumes: 每个 Task 的提交 SHA、Luna 最终命令记录和真实退出码。
- Produces: 不夸大完成状态、可追溯到命令和提交的最终报告。

- [ ] **Step 1: 修正 C-6 状态语言**

把“已完成”改为只有在以下证据都存在时才成立：

- registry 三个单测通过。
- section 同 index 替换会调用旧 cleanup。
- pagehide 会清理当前 doc。
- 组件卸载 `disposeAll()` 幂等。

若真实桌面端长会话手工验收尚未执行，状态写成“代码与自动化修复完成，真机长会话验收待执行”，不能写“全部完成”。

- [ ] **Step 2: 由 Luna 运行完整验证矩阵**

Working directory: `apps/readest-app`

```powershell
pnpm test -- run
pnpm lint
pnpm fmt:check
pnpm clippy:check
pnpm test:rust
pnpm test:browser
pnpm bench library-search --no-record
```

Luna 回传格式必须包含：

```text
工作目录:
命令:
开始时间:
结束时间:
耗时:
退出码:
通过/跳过/失败数:
首个失败文件和首个关键错误:
```

- [ ] **Step 3: 判定最终验收**

必须同时满足：

- 前端单测无新增失败。
- `pnpm lint` 从退出码 1 变为 0。
- Rust fmt/clippy/test 全部退出码 0。
- browser 失败集合不超过既有 5 文件 / 11 用例；Task 2 的异步 RAF 焦点测试和桌面键盘矩阵必须通过。
- `library-search` benchmark 完成并记录数值；若相对同机基线变慢超过 10%，重新采样 3 次并比较中位数。

- [ ] **Step 4: 更新 perf-debug 快照**

报告基线块直接复制 Luna 的最终实测值。`.claude/skills/perf-debug/SKILL.md` 只改 `SNAPSHOT-BEGIN/END`：HEAD、最新报告、基线、当前优先级、已修和未修状态。不得改稳定层方法论。

- [ ] **Step 5: 提交文档证据**

```powershell
git add docs/reports/revision-fix-report-2026-08-31.md docs/reports/perf-debug-report-2026-08-31.md docs/reports/PERF-DEBUG-LATEST.md .claude/skills/perf-debug/SKILL.md
git commit -m "docs: record review finding remediation evidence"
```

只添加实际修改的文件；若指针未变，不把它加入提交。

---

## Independent Browser Failure Follow-up

本计划不猜测性修复当前 11 个 browser 失败。核心任务完成后，另开四个独立诊断任务，分别建立红灯反馈环：

1. `annotation-popup-layout` + `tts-auto-advance`：先验证共同的 `EnvProvider` 测试装配问题，命令只运行这两个文件。
2. `iframe-keyboard-selection`：固定 Chromium、viewport 和选区方向，记录 Selection anchor/focus 后再定位跨 section 行为。
3. `paginator-turn-styles`：分别强制有/无 ViewTransition API，确认失败属于 fallback 分支还是环境 mock。
4. `EditorView`：追踪确认动作到 `cancel` callback 的实际调用链，不与 EnvProvider 失败合并。

每组达到“单命令稳定复现 + 最小场景 + 3 个可证伪假设”后，再生成各自的修复计划。未经这一步，不更新截图、不放宽断言、不增加 timeout。

---

## Commit Order

1. `fix: enforce indexed search result budget per section`
2. `fix: preserve command palette tab focus after blur`
3. `fix: recover stale library save locks after restart`
4. `fix: dispose annotator listeners when sections are replaced`
5. `fix: type throttle arguments without explicit any`
6. `docs: record review finding remediation evidence`

## Rollback Rules

- 搜索 Task 回滚时只回滚 service 和对应测试，不影响 worker 或索引 schema。
- 焦点 Task 回滚时保留其他 CommandPalette 修复提交，不重置整个文件历史。
- 锁 Task 若在 Windows/macOS/Linux 任一平台出现误抢新鲜锁，立即回滚整个 Task 3；不得仅提高 timeout 掩盖。
- Annotator Task 若影响选中、长按、右键或固定版式，回滚 registry 接入提交；不删除原有事件处理函数。
- 文档提交只记录已经验证的事实；代码回滚后必须同步撤销对应“已修”状态。

## Definition of Done

- 5 个代码 Task 均有独立提交和先红后绿证据。
- 缓存索引多 section 超发最终严格为 500。
- CommandPalette 等待 RAF 后仍保持正确 Tab/Shift+Tab 落点。
- 上次异常退出留下的锁能在新进程首次保存时恢复，新进程创建后的锁不会被抢占。
- section 替换、pagehide 和组件卸载三条路径都能幂等清理监听器。
- `pnpm lint` 退出码 0；前端和 Rust 无新增失败。
- 报告包含 Luna 的工作目录、命令、耗时、退出码和失败清单，不把待手工验收项写成完成。
