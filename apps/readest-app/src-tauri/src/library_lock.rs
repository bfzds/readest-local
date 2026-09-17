// B-7 复核：跨窗口 library 保存串行化锁。
//
// 两个独立 WebView（书库页 + 阅读页）各自持有 JS 内存快照，`saveLibraryBooks`
// 的"读磁盘 → LWW 合并 → 原子写回"若并发交错会互相覆盖较新的字段。JS 侧
// 模块级 mutex 无法跨 WebView 共享，这里用应用数据目录下一个独占创建的锁
// 文件做跨窗口互斥：create_new 成功 = 拿锁；失败 = 另一窗口在保存，等待轮询。
// 释放只允许锁文件的持有者（token 写死在文件内容里，release/renew 都要校验）。
//
// 存活判定 = 持有者租约（2026-09-17 改）：锁的新鲜度只能由持有者的 JS 通过
// `renew_library_lock` 续期来维持，续期间隔 3s。原先由 Rust 后台线程自己每 3s
// 触碰 mtime，与持有者的生命周期完全解耦——一旦那次保存在 JS 侧结束（或释放
// 失败、WebView 销毁）而心跳线程还活着，两条陈旧判据都不成立，锁就永远"新鲜"，
// 全应用所有保存只能等超时失败（实测：15:56 一次删除后的保存写完两个文件后
// 没释放锁，之后 20 分钟内每次保存都等 5s 超时）。
//
// 陈旧回收两条路：① mtime 早于本进程启动（崩溃遗留，可立即收走）；
// ② mtime 年龄超过 LOCK_STALE_AFTER_MS（持有者已停止续期 = JS 侧已结束、
// WebView 销毁或释放失败）。阈值必须显著大于续期间隔：临界区内 JS 只做
// JSON 序列化与两次写盘（毫秒级），续期回调不会饿死，所以 30s 足以区分
// "持有者还在"与"持有者已亡"，又不会让死锁长期占位。
//
// 失败可观测：获取/续期/释放/回收各写一行到应用数据目录的 `library.lock.log`
// （尽力而为，超过上限截断）。此前这类故障只出现在 WebView 控制台里，排查时
// 只能靠反解 token 时间与文件 mtime。

use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(test)]
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::Manager;

const LOCK_FILENAME: &str = "library.lock";
const LOCK_LOG_FILENAME: &str = "library.lock.log";
const POLL_INTERVAL_MS: u64 = 100;
/// 锁文件 mtime 超过该年龄视为陈旧（持有者已停止续期 = 已亡）。
/// 必须显著大于 JS 侧续期间隔（3s），否则临界区内的一次 GC/长任务就会误判。
pub const LOCK_STALE_AFTER_MS: u64 = 30_000;
/// 释放失败时的重试退避（Windows 下 AV/索引器短暂占用文件是常见原因）。
const RELEASE_RETRY_BACKOFF_MS: [u64; 3] = [30, 120, 300];
/// 日志上限，超过即截断重写（只保留最近一次会话的记录）。
const LOCK_LOG_MAX_BYTES: u64 = 512 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLock {
    pub path: PathBuf,
    pub token: String,
}

fn lock_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(LOCK_FILENAME, BaseDirectory::AppData)
        .map_err(|e| format!("resolve library lock path: {e}"))
}

/// 锁事件日志：尽力而为，任何失败都吞掉（诊断设施绝不影响保存本身）。
fn log_lock_event(app: &tauri::AppHandle, event: &str) {
    let Ok(path) = app
        .path()
        .resolve(LOCK_LOG_FILENAME, BaseDirectory::AppData)
    else {
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{stamp}] pid={} {event}\n", std::process::id());
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOCK_LOG_MAX_BYTES {
        let _ = std::fs::write(&path, b"");
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("tok-{:x}-{:x}", nanos, pid ^ (nanos << 32))
}

// 本进程启动时间：用于区分"启动前遗留锁"（崩溃残留，可安全收走）与
// "本进程启动后创建的锁"（走租约年龄判定）。
static PROCESS_STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

pub fn initialize_process_start() {
    let _ = PROCESS_STARTED_AT.set(SystemTime::now());
}

fn process_started_at() -> SystemTime {
    *PROCESS_STARTED_AT.get_or_init(SystemTime::now)
}

/// 陈旧判定的纯核心：mtime 早于进程启动（崩溃遗留），或年龄超过阈值
/// （持有者停止续期 = 已亡）。两者任一成立即可安全收走。
fn is_stale_mtime(
    modified: SystemTime,
    now: SystemTime,
    started_at: SystemTime,
    stale_after: Duration,
) -> bool {
    if modified < started_at {
        return true;
    }
    now.duration_since(modified)
        .map(|age| age > stale_after)
        .unwrap_or(false)
}

fn lock_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// 把 token 写进已存在的锁文件：先定位到 0，写完后把文件截到 token 长度，
/// 避免上一次更长内容留下尾巴（否则 token 比对会失败）。
fn write_token_in_place(file: &mut File, token: &str) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(token.as_bytes())?;
    file.set_len(token.len() as u64)?;
    file.flush()
}

/// 读锁文件内容（trim 后）。文件不存在返回 Err，调用方据此判断锁已释放/被回收。
fn read_lock_token(path: &Path) -> Result<String, String> {
    let mut content = String::new();
    OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|mut file| file.read_to_string(&mut content))
        .map_err(|e| format!("read lock: {e}"))?;
    Ok(content.trim().to_string())
}

/// 单次尝试独占创建锁文件。成功返回 `Ok(Some(lock))`；锁被占用且不陈旧返回
/// `Ok(None)`；陈旧锁先挪开重试；其他 IO 错误为 `Err`。
fn try_acquire_once(
    lock_path: &Path,
    started_at: SystemTime,
    stale_after: Duration,
) -> Result<Option<LibraryLock>, String> {
    for _ in 0..3 {
        let token = new_token();
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(token.as_bytes()) {
                    let _ = std::fs::remove_file(lock_path);
                    return Err(format!("write library lock token: {error}"));
                }
                return Ok(Some(LibraryLock {
                    path: lock_path.to_path_buf(),
                    token,
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = lock_mtime(lock_path)
                    .map(|modified| {
                        is_stale_mtime(modified, SystemTime::now(), started_at, stale_after)
                    })
                    .unwrap_or(false);
                if stale {
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
                return Ok(None);
            }
            Err(error) => return Err(format!("create library lock: {error}")),
        }
    }
    Ok(None)
}

/// 同步轮询获取（测试与非 async 调用方）。陈旧锁自动回收，新鲜锁等待至超时。
#[cfg(test)]
fn acquire_lock_file(
    lock_path: &Path,
    timeout_ms: u64,
    started_at: SystemTime,
    stale_after: Duration,
) -> Result<LibraryLock, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(lock) = try_acquire_once(lock_path, started_at, stale_after)? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err("library save lock timeout: another window is saving".to_string());
        }
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}

/// 续期的纯实现（测试用），与 `renew_library_lock` 命令同一逻辑。
#[cfg(test)]
fn renew_lock_file(lock_path: &Path, token: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("renew lock: lock file unavailable ({e})"))?;
    if read_lock_token(lock_path)? != token {
        return Err("renew lock: owned by another token".to_string());
    }
    write_token_in_place(&mut file, token).map_err(|e| format!("renew lock: {e}"))
}

/// 释放锁：只有锁文件内容与 token 匹配的持有者才允许删除。
fn release_lock_file(lock_path: &Path, token: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(lock_path).map_err(|e| format!("read lock: {e}"))?;
    if content.trim() != token {
        return Err("library lock owned by another token; refusing to release".to_string());
    }
    std::fs::remove_file(lock_path).map_err(|e| format!("remove lock: {e}"))
}

/// 独占获取锁（async：轮询等待不再阻塞主线程）。陈旧锁（崩溃遗留或租约过期）
/// 自动回收；活锁绝不抢占，等待至超时返回错误。
#[tauri::command]
pub async fn acquire_library_lock(
    app: tauri::AppHandle,
    timeout_ms: u64,
) -> Result<LibraryLock, String> {
    let path = lock_path(&app)?;
    let started_at = process_started_at();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let stale_after = Duration::from_millis(LOCK_STALE_AFTER_MS);
    loop {
        let before = lock_mtime(&path);
        if let Some(lock) = try_acquire_once(&path, started_at, stale_after)? {
            let reclaimed = matches!(before, Some(mtime) if is_stale_mtime(mtime, SystemTime::now(), started_at, stale_after));
            log_lock_event(
                &app,
                if reclaimed {
                    "acquire: ok (reclaimed stale lock)"
                } else {
                    "acquire: ok"
                },
            );
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            log_lock_event(&app, "acquire: timeout (another window is saving)");
            return Err("library save lock timeout: another window is saving".to_string());
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// 续期（租约）：持有者由 JS 每 3s 调用一次，重写 token 触碰 mtime。
/// 不以 create 方式打开——锁文件消失（已释放或被回收）即报错，绝不重建死锁；
/// 内容与 token 不符说明锁已被回收后他人接管，必须让持有者立刻知道。
#[tauri::command]
pub fn renew_library_lock(lock_path: String, token: String) -> Result<(), String> {
    let path = PathBuf::from(&lock_path);
    let mut file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| format!("renew lock: lock file unavailable ({e})"))?;
    let current = read_lock_token(&path)?;
    if current != token {
        return Err("renew lock: owned by another token".to_string());
    }
    write_token_in_place(&mut file, &token).map_err(|e| format!("renew lock: {e}"))
}

/// 释放锁：只有持有者（文件内容与 token 匹配）才允许删除。失败按退避重试
/// ——Windows 下 AV/索引器短时占用文件会让 remove 报 sharing violation。
/// 即便最终失败也不再是毒锁：租约无人续期，30s 后自动可回收。
#[tauri::command]
pub async fn release_library_lock(
    app: tauri::AppHandle,
    lock_path: String,
    token: String,
) -> Result<(), String> {
    let path = PathBuf::from(lock_path);
    let mut last_error = String::new();
    for (attempt, backoff) in RELEASE_RETRY_BACKOFF_MS.iter().enumerate() {
        match release_lock_file(&path, &token) {
            Ok(()) => {
                log_lock_event(&app, "release: ok");
                return Ok(());
            }
            Err(error) => {
                last_error = error;
                if attempt + 1 < RELEASE_RETRY_BACKOFF_MS.len() {
                    tokio::time::sleep(Duration::from_millis(*backoff)).await;
                }
            }
        }
    }
    log_lock_event(
        &app,
        &format!("release: failed after retries ({last_error}); lock will age out in {LOCK_STALE_AFTER_MS}ms"),
    );
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "readest-library-lock-{label}-{}-{}",
            std::process::id(),
            new_token()
        ))
    }

    #[test]
    fn token_is_unique_and_nonempty() {
        let a = new_token();
        let b = new_token();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }

    #[test]
    fn stale_mtime_rules() {
        let started = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let now = started + Duration::from_secs(30);
        // 早于进程启动：崩溃遗留，陈旧。
        assert!(is_stale_mtime(
            started - Duration::from_secs(5),
            now,
            started,
            Duration::from_secs(10)
        ));
        // 进程内新鲜：不陈旧。
        assert!(!is_stale_mtime(
            now - Duration::from_secs(5),
            now,
            started,
            Duration::from_secs(10)
        ));
        // 进程内但心跳停止超阈值：毒锁，陈旧。
        assert!(is_stale_mtime(
            now - Duration::from_secs(11),
            now,
            started,
            Duration::from_secs(10)
        ));
        // 恰好等于阈值：不陈旧。
        assert!(!is_stale_mtime(
            now - Duration::from_secs(10),
            now,
            started,
            Duration::from_secs(10)
        ));
    }

    #[test]
    fn removes_lock_that_predates_process_start() {
        let dir = unique_test_dir("stale");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        std::fs::write(&path, "old-owner").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let process_started_at = modified + Duration::from_secs(1);

        let lock =
            acquire_lock_file(&path, 100, process_started_at, Duration::from_secs(10)).unwrap();
        assert_ne!(lock.token, "old-owner");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), lock.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_steals_lock_created_after_process_start() {
        let dir = unique_test_dir("fresh");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        std::fs::write(&path, "live-owner").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let process_started_at = modified
            .checked_sub(Duration::from_secs(1))
            .unwrap_or(UNIX_EPOCH);

        let error = acquire_lock_file(&path, 10, process_started_at, Duration::from_secs(10))
            .err()
            .expect("fresh lock must time out");
        assert!(error.contains("timeout"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "live-owner");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn release_requires_matching_token() {
        let dir = unique_test_dir("release");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        std::fs::write(&path, "owner").unwrap();

        assert!(release_lock_file(&path, "other").is_err());
        assert!(path.exists());
        release_lock_file(&path, "owner").unwrap();
        assert!(!path.exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reclaims_dead_holder_lock_after_stale_age() {
        let dir = unique_test_dir("poison");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        let now = SystemTime::now();
        // 模拟持有者（WebView/JS）死亡：拿到锁后再也不续期，mtime 停止刷新。
        // 超过陈旧阈值后下一次获取必须回收成功——这正是 2026-09-17 真机上
        // "锁写完两个文件后没释放、之后所有保存都超时" 的那条路径。
        let holder = try_acquire_once(&path, now, Duration::from_millis(200))
            .unwrap()
            .expect("first acquire must succeed");
        thread::sleep(Duration::from_millis(300));

        let lock = acquire_lock_file(&path, 100, now, Duration::from_millis(200)).unwrap();
        assert_ne!(lock.token, holder.token);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), lock.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renewal_keeps_live_lock_unstealable() {
        let dir = unique_test_dir("renew");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        let now = SystemTime::now();
        // 陈旧阈值 300ms，持有者每 50ms 续期一次：锁永远新鲜，不该被抢。
        let holder = try_acquire_once(&path, now, Duration::from_millis(300))
            .unwrap()
            .expect("first acquire must succeed");
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(50));
            renew_lock_file(&path, &holder.token).unwrap();
        }

        let error = acquire_lock_file(&path, 100, now, Duration::from_millis(300))
            .err()
            .expect("renewed lock must NOT be stolen");
        assert!(error.contains("timeout"));

        // 持有者释放（锁文件消失）后可立即获取。
        release_lock_file(&path, &holder.token).unwrap();
        let next = acquire_lock_file(&path, 100, now, Duration::from_millis(300)).unwrap();
        assert_ne!(next.token, holder.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renewal_stops_after_holder_ends_so_lock_ages_out() {
        let dir = unique_test_dir("lease");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        let now = SystemTime::now();
        // 持有者续期一阵子后结束（等价于 JS 侧 finally 里 clearInterval）：
        // 之后无人触碰 mtime，超过阈值即被回收——释放失败不再是永久毒锁。
        let holder = try_acquire_once(&path, now, Duration::from_millis(300))
            .unwrap()
            .expect("first acquire must succeed");
        for _ in 0..4 {
            thread::sleep(Duration::from_millis(50));
            renew_lock_file(&path, &holder.token).unwrap();
        }
        thread::sleep(Duration::from_millis(400));

        let lock = acquire_lock_file(&path, 200, now, Duration::from_millis(300))
            .expect("lock must be reclaimable once the holder stopped renewing");
        assert_ne!(lock.token, holder.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renewal_requires_matching_token_and_never_recreates_a_released_lock() {
        let dir = unique_test_dir("renew-guard");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        let holder = try_acquire_once(&path, SystemTime::now(), Duration::from_secs(10))
            .unwrap()
            .expect("first acquire must succeed");

        assert!(renew_lock_file(&path, "someone-else").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), holder.token);

        release_lock_file(&path, &holder.token).unwrap();
        assert!(renew_lock_file(&path, &holder.token).is_err());
        assert!(!path.exists(), "续期绝不允许把已释放的锁重建出来");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
