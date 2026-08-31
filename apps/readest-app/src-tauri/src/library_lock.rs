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
use std::path::PathBuf;
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

/// 独占创建锁文件。已有新鲜锁时轮询等待，超时返回可识别错误。
#[tauri::command]
pub fn acquire_library_lock(app: tauri::AppHandle, timeout_ms: u64) -> Result<LibraryLock, String> {
    let lock_path = lock_path(&app)?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let token = new_token();
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                if file.write_all(token.as_bytes()).is_err() {
                    // 写 token 失败：删锁重试，避免留下无 owner 的死锁。
                    let _ = std::fs::remove_file(&lock_path);
                } else {
                    return Ok(LibraryLock {
                        path: lock_path,
                        token,
                    });
                }
            }
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err("library save lock timeout: another window is saving".to_string());
                }
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS as u64));
            }
        }
    }
}

/// 释放锁：只有持有者（文件内容与 token 匹配）才允许删除。
#[tauri::command]
pub fn release_library_lock(lock_path: String, token: String) -> Result<(), String> {
    let content = std::fs::read_to_string(&lock_path).map_err(|e| format!("read lock: {e}"))?;
    if content.trim() != token {
        return Err("library lock owned by another token; refusing to release".to_string());
    }
    std::fs::remove_file(&lock_path).map_err(|e| format!("remove lock: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_unique_and_nonempty() {
        let a = new_token();
        let b = new_token();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }
}
