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

    if recursive {
        for entry_result in WalkDir::new(path).into_iter() {
            match entry_result {
                Ok(entry) => {
                    if entry.file_type().is_file() {
                        if let Some(scanned_file) =
                            process_file_entry(entry.path(), &normalized_extensions)
                        {
                            files.push(scanned_file);
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
                            let path = entry.path();
                            if path.is_file() {
                                if let Some(scanned_file) =
                                    process_file_entry(&path, &normalized_extensions)
                                {
                                    files.push(scanned_file);
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

fn process_file_entry(path: &Path, extensions: &[String]) -> Option<ScannedFile> {
    if extensions.is_empty() || extensions.contains(&"*".to_string()) {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        return Some(ScannedFile {
            path: path.to_string_lossy().to_string(),
            size,
        });
    } else if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        if extensions.contains(&ext_str) {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            return Some(ScannedFile {
                path: path.to_string_lossy().to_string(),
                size,
            });
        }
    }
    None
}
