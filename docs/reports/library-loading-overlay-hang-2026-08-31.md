# 书库"一直卡在加载"问题诊断报告

- 日期:2026-08-31
- 环境:`pnpm tauri dev`(dev 构建,webdriver 版复现)
- 结论:**数据与 IPC 全部正常,书实际已在后台渲染成功;问题是一个全屏"加载中..."遮罩未被关闭,盖住了书库。**

---

## 一、问题现象

1. `pnpm tauri dev` 启动后,书库页一直显示全屏"加载中..."遮罩,看不到任何书。
2. 多次启动均复现(04:04 / 04:06 两次真实启动 + webdriver 复现实例)。
3. 后台/日志**无报错、无崩溃、无异常退出**,前台进程 CPU 极低,看起来就是"静默卡住"。

## 二、真相:书其实加载成功了

逐项实测(webdriver 直连 tauri 4445 端口):

| 检查项 | 结果 |
| --- | --- |
| `library.json` | 399 条可读,78 本有效(deletedAt 过滤后),无损坏 |
| Rust IPC(get_exe_dir / fs stat / read_text / read_dir) | **全部 5~12ms 秒回,无死锁、无 pending** |
| `getAppService()` → `NativeAppService.init()` | 插桩验证跑到底:`init done` |
| `initLibrary`(loadSettings → loadLibraryBooks → setLibrary) | 完整跑完,读回 399 条 |
| 首次启动 JS 是否有崩溃 | 无 |
| DOM 书网格(`.bookshelf-items`) | **渲染出书**(Virtuoso 视口项,如 "帕乌克" 等书名) |
| 全屏遮罩 | `.fixed.inset-0.z-50 ... <Spinner loading/>` **常驻** |

**决定性实验**:用 webdriver 把全屏遮罩从 DOM 中移除(style.display=none)后,书库书籍立即露出。→ **书一直在,只是被遮罩挡住。**

## 三、根因

`apps/readest-app/src/app/library/page.tsx` 的 `initLibrary` effect(约 723~816 行):

- effect 依赖 `libraryInitKey`(由 URL `searchParams` 派生)。URL 规范化/导航变化会**多次触发这个 effect**。
- 该 effect 每一轮开头都**无条件**创建 `setTimeout(() => setLoading(true), 500)`(`hasCachedLibrary=false` 时,line 734)。
- 每一轮在 await 之后都有 `if (stale()) return;` 提前退出分支(740/744/766/772/778/785/789 多处)。
- **提前退出的轮次:①不清除自己创建的 `loadingTimeout`,②不会把 `loading` 恢复为 false**。
- effect 的 cleanup 也没有 `clearTimeout(loadingTimeout)`。
- 多轮 effect 并发/交错执行后,只要有"被触发但 stale 提前退出"的一轮存在,`loading` 就被 `setTimeout` 置为 true 且**无人再关回 false** → 全屏遮罩常驻,且对应那轮的 React 提交把遮罩盖在最上层。

插桩实测(每轮标记):
```
B got appService → [S1 提前退出]
B got appService → [S1 提前退出]
C loadSettings → D → [S2 提前退出]
E loadLibraryBooks 399 → [S4 提前退出]
F→G openWith=false → [S5][S7] → setLibrary(399) → N 完成
```
→ initLibrary 被并发触发多轮,多数轮提前退出,loading 状态失控。

### 关键代码位置

- `page.tsx:733-734` — `const loadingTimeout = hasCachedLibrary ? null : setTimeout(() => setLoading(true), 500);`
- `page.tsx:740~789` — 多处 `if (stale()) return;` 提前退出(不清 timeout、不恢复 loading)
- `page.tsx:806-812` — effect cleanup(只做 `libraryInitGeneration += 1`,未 `clearTimeout`)
- `page.tsx:1802-1821` — `{loading && <div className='fixed inset-0 z-50 ...'>...<Spinner loading/>}` 全屏遮罩渲染

## 四、与最近提交的关系

- **最相关:C-1 / C-2(书库 URL 同步:规范化单写通道,参数顺序变化不再触发重复导航)**。改动作用于 URL/searchParams 与导航,正是会导致 `libraryInitKey` 变化、initLibrary 被反复触发的那一层。
- **次要可疑:P-2(书库渲染扇出:BookshelfItem 用稳定 Set + memo)**,同样属于启动加载/渲染路径的新改动。
- 时间线吻合"某次更新后开始出现"。

## 五、修复建议(未改动代码)

最小修复方向:

1. **stale 提前退出前恢复 loading**:每个 `if (stale()) return;` 分支先 `if (loadingTimeout) clearTimeout(loadingTimeout); setLoading(false);` 再 return;或统一抽一个 `bail()`。
2. **effect cleanup 增加清理**:cleanup 里 `if (loadingTimeout) clearTimeout(loadingTimeout);`。
3. **消除多轮触发源头**(治本):确认 `libraryInitKey`/URL 规范化在启动时是否发生了不该有的重复导航;若 C-1/C-2 仍有尾巴,一并修正。

## 六、影响范围

- 仅影响书库页启动的首屏体验(遮罩挡住书库,无法点击)。
- 不涉及真实数据损坏、不涉及文件读写、不涉及 IPC/Rust 层;不影响已打开的书籍与后续功能。
- 安装版(release)**待验证是否同样复现**(诊断基于 dev/webdriver,若发布版无 HMR/导航差异可能不出现)。