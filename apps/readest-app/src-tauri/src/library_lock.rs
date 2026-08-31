// B-7 复核：跨窗口 library 保存串行化锁。
//
// 两个独立 WebView（书库页 + 阅读页）各自持有 JS 内存快照，`saveLibraryBooks`
// 的"读磁盘 → LWW 合并 → 原子写回"若并发交错会互相覆盖较新的字段。JS 侧
// 模块级 mutex 无法跨 WebView 共享，这里用应用数据目录下一个独占创建的锁
// 文件做跨窗口互斥：create_new 成功 = 拿锁；失败 = 另一窗口在保存，等待轮询。
// 释放只允许锁文件的持有者（token 写死在文件内容里，release 时校验）。
//
// 不静默抢占：等待超过 timeout 直接返回错误，绝不删除"新鲜"锁（可能属另一
// 窗口正在进行中的保存）。

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
const POLL_INTERVAL_MS: u128 = 100;

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
// "本进程启动后其他窗口正在使用的活锁"（绝不抢占）。
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

/// 独占创建锁文件；若锁文件陈旧（早于进程启动，崩溃遗留），先挪开后重试。
/// 新鲜锁（进程启动后创建，另一窗口正在保存）等待轮询至超时，绝不抢占。
fn acquire_lock_file(
    lock_path: &Path,
    timeout_ms: u64,
    started_at: SystemTime,
) -> Result<LibraryLock, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
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
                return Ok(LibraryLock {
                    path: lock_path.to_path_buf(),
                    token,
                });
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

/// 释放锁：只有锁文件内容与 token 匹配的持有者才允许删除。
fn release_lock_file(lock_path: &Path, token: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(lock_path).map_err(|e| format!("read lock: {e}"))?;
    if content.trim() != token {
        return Err("library lock owned by another token; refusing to release".to_string());
    }
    std::fs::remove_file(lock_path).map_err(|e| format!("remove lock: {e}"))
}

/// 独占创建锁文件；陈旧锁（启动前遗留）自动恢复，新鲜锁等待至超时。
#[tauri::command]
pub fn acquire_library_lock(app: tauri::AppHandle, timeout_ms: u64) -> Result<LibraryLock, String> {
    acquire_lock_file(&lock_path(&app)?, timeout_ms, process_started_at())
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
    fn removes_lock_that_predates_process_start() {
        let dir = unique_test_dir("stale");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILENAME);
        std::fs::write(&path, "old-owner").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let process_started_at = modified + Duration::from_secs(1);

        let lock = acquire_lock_file(&path, 100, process_started_at).unwrap();
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

        let error = acquire_lock_file(&path, 10, process_started_at)
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
}
