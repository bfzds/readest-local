use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
use walkdir::WalkDir;

#[derive(serde::Serialize)]
pub struct ScannedFile {
    pub path: String,
    pub size: u64,
}

#[tauri::command]
pub async fn read_dir(
    app: AppHandle,
    path: String,
    recursive: bool,
    extensions: Vec<String>,
) -> Result<Vec<ScannedFile>, String> {
    let scope = app.fs_scope();
    let path_buf = std::path::PathBuf::from(&path);

    // RF2: 仅依 fs_scope 校验。此前 `!contains("Readest")` 会把任何路径字符串
    // 含 "Readest" 子串的目录（如 C:\xx\MyReadestData\...）直接放行、绕过
    // scope。当前 capabilities 的 fs:read-all 已使 scope 全开，移除后功能不受
    // 影响；未来若收紧权限也不会再被子串绕过。
    if !scope.is_allowed(&path_buf) {
        return Err("Permission denied: Path not in filesystem scope".to_string());
    }

    // The walk stats every matching file; on a large watched folder that is
    // thousands of syscalls. A sync command would run them inline on the IPC
    // dispatch thread and freeze the UI on every focus-triggered scan
    // (issue #5494) — offload to the blocking pool like the parsers do.
    tauri::async_runtime::spawn_blocking(move || read_dir_sync(&path, recursive, &extensions))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn read_dir_sync(
    path: &str,
    recursive: bool,
    extensions: &[String],
) -> Result<Vec<ScannedFile>, String> {
    let path_buf = std::path::PathBuf::from(path);
    let mut files = Vec::new();

    let normalized_extensions: Vec<String> =
        extensions.iter().map(|ext| ext.to_lowercase()).collect();
    // 通配放行（空列表或含 "*"）只判一次，避免每文件重复 contains 判断。
    let accepts_all_extensions =
        normalized_extensions.is_empty() || normalized_extensions.contains(&"*".to_string());

    if recursive {
        for entry_result in WalkDir::new(path).into_iter() {
            match entry_result {
                Ok(entry) => {
                    if entry.file_type().is_file() {
                        // 复用目录项自带的 metadata，避免对同一路径再开一次。
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        if ext_matches(entry.path(), &normalized_extensions, accepts_all_extensions)
                        {
                            files.push(ScannedFile {
                                path: entry.path().to_string_lossy().to_string(),
                                size,
                            });
                        }
                    }
                }
                Err(e) => {
                    log::warn!("RUST: Skipping file due to error: {}", e);
                }
            }
        }
    } else {
        match std::fs::read_dir(&path_buf) {
            Ok(entries) => {
                for entry_result in entries {
                    match entry_result {
                        Ok(entry) => {
                            // 一次 metadata 同时完成"是否文件"判定与取 size，取代原先
                            // `path.is_file()` stat + `fs::metadata` stat 的两次。
                            // DirEntry::metadata() 跟随符号链接，语义与原 is_file() 一致。
                            if let Ok(meta) = entry.metadata() {
                                if meta.is_file()
                                    && ext_matches(
                                        &entry.path(),
                                        &normalized_extensions,
                                        accepts_all_extensions,
                                    )
                                {
                                    files.push(ScannedFile {
                                        path: entry.path().to_string_lossy().to_string(),
                                        size: meta.len(),
                                    });
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("RUST: Skipping entry due to error: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                return Err(format!("Failed to read directory: {}", e));
            }
        }
    }

    Ok(files)
}

fn ext_matches(path: &Path, normalized_extensions: &[String], accepts_all: bool) -> bool {
    if accepts_all {
        return true;
    }
    path.extension()
        .map(|ext| normalized_extensions.contains(&ext.to_string_lossy().to_lowercase()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("readest-scanner-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn non_recursive_filters_by_extension() {
        let dir = temp_dir("nonrec");
        fs::write(dir.join("a.txt"), "abc").unwrap();
        fs::write(dir.join("b.epub"), "def").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("c.txt"), "xyz").unwrap();
        let files = read_dir_sync(dir.to_str().unwrap(), false, &["txt".to_string()]).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("a.txt"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recursive_includes_nested_files() {
        let dir = temp_dir("rec");
        fs::write(dir.join("a.txt"), "abc").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("b.txt"), "def").unwrap();
        let files = read_dir_sync(dir.to_str().unwrap(), true, &["txt".to_string()]).unwrap();
        assert_eq!(files.len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wildcard_accepts_all_extensions() {
        let dir = temp_dir("wild");
        fs::write(dir.join("a.txt"), "abc").unwrap();
        fs::write(dir.join("b.pdf"), "def").unwrap();
        for ext in [vec!["*".to_string()], vec![]] {
            let files = read_dir_sync(dir.to_str().unwrap(), false, &ext).unwrap();
            assert_eq!(files.len(), 2);
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
