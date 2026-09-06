// B-7 复核：跨窗口 library 保存串行化锁。
//
// 两个独立 WebView（书库页 + 阅读页）各自持有 JS 内存快照，`saveLibraryBooks`
// 的"读磁盘 → LWW 合并 → 原子写回"若并发交错会互相覆盖较新的字段。JS 侧
// 模块级 mutex 无法跨 WebView 共享，这里用应用数据目录下一个独占创建的锁
// 文件做跨窗口互斥：create_new 成功 = 拿锁；失败 = 另一窗口在保存，等待轮询。
// 释放只允许锁文件的持有者（token 写死在文件内容里，release 时校验）。
//
// 毒锁防护（心跳 + 陈旧回收）：持锁方由后台线程每 3s 重写 token 触碰 mtime。
// 判定陈旧走两条路——① mtime 早于本进程启动（崩溃遗留，可立即收走）；
// ② mtime 年龄超过 LOCK_STALE_AFTER_MS（持锁 WebView 中途死亡、心跳停止，
// 锁变成"本进程内的新鲜死锁"——这正是旧实现里 release 永远不会到来、
// 其余窗口全部保存超时的毒锁场景）。心跳间隔（3s）远小于陈旧阈值（10s），
// 活着的持锁方永远不会被误判；阈值又大于获取超时（JS 侧 5s），首次超时后
// 下一次保存即可回收死锁。
//
// 心跳线程写回前以不创建的方式打开锁文件：文件已消失（释放/被回收）即退出，
// 绝不重建死锁。

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::Manager;

const LOCK_FILENAME: &str = "library.lock";
const POLL_INTERVAL_MS: u64 = 100;
/// 锁文件 mtime 超过该年龄视为陈旧（心跳停止 = 持锁方已死）。
pub const LOCK_STALE_AFTER_MS: u64 = 10_000;
/// 心跳间隔：远小于陈旧阈值，保证活锁不被误判。
const HEARTBEAT_INTERVAL_MS: u64 = 3_000;

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

fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("tok-{:x}-{:x}", nanos, pid ^ (nanos << 32))
}

// 本进程启动时间：用于区分"启动前遗留锁"（崩溃残留，可安全收走）与
// "本进程启动后创建的锁"（走心跳年龄判定）。
static PROCESS_STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

pub fn initialize_process_start() {
    let _ = PROCESS_STARTED_AT.set(SystemTime::now());
}

fn process_started_at() -> SystemTime {
    *PROCESS_STARTED_AT.get_or_init(SystemTime::now)
}

/// 陈旧判定的纯核心：mtime 早于进程启动（崩溃遗留），或年龄超过阈值
/// （心跳停止 = 持锁方已死）。两者任一成立即可安全收走。
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

/// 持锁方心跳：每 interval 重写一次 token 触碰 mtime。文件消失（已释放或
/// 被回收）即退出；绝不以 create 方式重建锁文件，否则回收后死锁会复活。
fn spawn_heartbeat(lock_path: PathBuf, token: String, interval: Duration) {
    thread::spawn(move || loop {
        thread::sleep(interval);
        let file = OpenOptions::new().write(true).open(&lock_path);
        match file {
            Ok(mut file) => {
                if file.write_all(token.as_bytes()).is_err() {
                    return;
                }
                let _ = file.flush();
            }
            Err(_) => return,
        }
    });
}

/// 单次尝试独占创建锁文件。成功返回 `Ok(Some(lock))`（并按需启动心跳）；
/// 锁被占用且不陈旧返回 `Ok(None)`；陈旧锁先挪开重试；其他 IO 错误为 `Err`。
fn try_acquire_once(
    lock_path: &Path,
    started_at: SystemTime,
    stale_after: Duration,
    heartbeat_interval: Option<Duration>,
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
                if let Some(interval) = heartbeat_interval {
                    spawn_heartbeat(lock_path.to_path_buf(), token.clone(), interval);
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
        if let Some(lock) = try_acquire_once(
            lock_path,
            started_at,
            stale_after,
            Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS)),
        )? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err("library save lock timeout: another window is saving".to_string());
        }
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}

/// 释放锁：只有锁文件内容与 token 匹配的持有者才允许删除。
fn release_lock_file(lock_path: &Path, token: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(lock_path).map_err(|e| format!("read lock: {e}"))?;
    if content.trim() != token {
        return Err("library lock owned by another token; refusing to release".to_string());
    }
    std::fs::remove_file(lock_path).map_err(|e| format!("remove lock: {e}"))
}

/// 独占获取锁（async：轮询等待不再阻塞主线程）。陈旧锁（崩溃遗留或心跳
/// 停止超阈值）自动回收；活锁绝不抢占，等待至超时返回错误。
#[tauri::command]
pub async fn acquire_library_lock(
    app: tauri::AppHandle,
    timeout_ms: u64,
) -> Result<LibraryLock, String> {
    let path = lock_path(&app)?;
    let started_at = process_started_at();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(lock) = try_acquire_once(
            &path,
            started_at,
            Duration::from_millis(LOCK_STALE_AFTER_MS),
            Some(Duration::from_millis(HEARTBEAT_INTERVAL_MS)),
        )? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err("library save lock timeout: another window is saving".to_string());
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// 释放锁：只有持有者（文件内容与 token 匹配）才允许删除。
#[tauri::command]
pub fn release_library_lock(lock_path: String, token: String) -> Result<(), String> {
    release_lock_file(&PathBuf::from(lock_path), &token)
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
        // 模拟持锁 WebView 死亡：无心跳（None），锁在进程启动后创建且
        // mtime 停止刷新。超过陈旧阈值后下一次获取必须回收成功。
        let holder = try_acquire_once(&path, now, Duration::from_millis(200), None)
            .unwrap()
            .expect("first acquire must succeed");
        thread::sleep(Duration::from_millis(300));

        let lock = acquire_lock_file(&path, 100, now, Duration::from_millis(200)).unwrap();
        assert_ne!(lock.token, holder.token);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), lock.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn heartbeat_keeps_live_lock_unstealable() {
        let dir = unique_test_dir("heartbeat");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        let now = SystemTime::now();
        // 心跳间隔 50ms << 陈旧阈值 300ms：持锁方活着，锁永远新鲜。
        let holder = try_acquire_once(
            &path,
            now,
            Duration::from_millis(300),
            Some(Duration::from_millis(50)),
        )
        .unwrap()
        .expect("first acquire must succeed");
        thread::sleep(Duration::from_millis(500));

        let error = acquire_lock_file(&path, 100, now, Duration::from_millis(300))
            .err()
            .expect("heartbeat-refreshed lock must NOT be stolen");
        assert!(error.contains("timeout"));

        // 持锁方释放（锁文件消失，心跳线程随之退出）后可立即获取。
        release_lock_file(&path, &holder.token).unwrap();
        let next = acquire_lock_file(&path, 100, now, Duration::from_millis(300)).unwrap();
        assert_ne!(next.token, holder.token);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
