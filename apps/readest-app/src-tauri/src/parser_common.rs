// Shared helpers for the native import fast-path.
//
// Both the EPUB parser (`epub_parser`) and the MOBI/AZW/AZW3 parser
// (`mobi_parser`) need to:
//   - compute the same `partialMD5` over the input file as `utils/md5.ts`,
//     so the on-disk `Books/<hash>/...` layout stays stable regardless of
//     which parser produced the entry,
//   - clamp oversized cover artwork to the library-grid thumbnail size,
//     re-encoding as JPEG q85 when downscaling actually fires.
//
// Keeping these in a single module avoids drift between the two import
// paths (a divergent partialMD5 implementation would silently re-import
// every existing book under a new hash on the first run after a change).
//
// `RawCoverImage` is the IPC-shaped struct returned to JS as a byte array
// + MIME pair; the JS bridges (`tauriEpubBridge.ts`, `tauriMobiBridge.ts`)
// turn it back into a `Uint8Array` before persisting through the existing
// `Books/<hash>/cover.<ext>` path.

use glob::Pattern;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, GenericImageView};
use md5::{Digest, Md5};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::path::BaseDirectory;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// 校验并解析一个传给 parser 命令的文件路径。任何一步不满足即拒绝：
///   1. 非空；
///   2. 可 canonicalize（拒绝不存在的路径与可疑符号链接）；
///   3. 是普通文件（拒绝目录、设备等）；
///   4. 在 `fs_scope` 允许范围内（dialog 授权、persisted scope、显式 scope）。
///
/// 通过后返回规范化路径，供后续 `File::open` / 哈希读取。
///
/// Windows 注意：`canonicalize()` 对含非 ASCII 或超长路径会返回 `\\?\C:\...`
/// 的 verbatim 形态，与 scope pattern（`C:\...`）不匹配；匹配前先剥前缀。
pub fn validate_scoped_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty path".to_string());
    }
    let path = PathBuf::from(raw);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve path {raw:?}: {e}"))?;
    let for_scope = strip_windows_verbatim(&canonical);
    if !is_regular_file(&for_scope) {
        return Err(format!("path is not a regular file: {canonical:?}"));
    }
    if scope_allows(app, &for_scope) {
        Ok(canonical)
    } else {
        log::warn!(
            "validate_scoped_file rejected path (not in app dirs / fs_scope): {}",
            for_scope.to_string_lossy()
        );
        Err(format!("path not allowed by fs scope: {canonical:?}"))
    }
}

/// 判断路径是否在允许范围内。允许来源（任一命中即可）：
///   1. 标准应用数据目录（AppData/AppConfig/AppCache）下的路径 —— 覆盖
///      已导入书库存（$APPDATA/Readest/...）、配置与封面等正常数据；
///      S-1/S-2：不再自动放行系统 Temp —— 那里可能残留其他程序的普通文件，
///      parser 不应成为无授权读取入口；确需的临时产物走 fs_scope 显式授权。
///   2. runtime `fs_scope`（dialog 授权、persisted scope、拖放、显式 allow）
///      —— 覆盖用户经系统文件选择器导入的外部书库/文件；
///   3. `webdriver` feature 下，开发测试用 fixture 目录（`**/__tests__/**`）。
///
/// Windows verbatim 兜底：`canonicalize()` 对含非 ASCII/超长路径返回 `\\?\`
/// 前缀，tauri 的 Path 级 `is_allowed` 会失配；这里统一剥前缀、按 `/` 分隔
/// 做字符串级 glob 比对。
fn scope_allows(app: &AppHandle, for_scope: &Path) -> bool {
    // 1) 标准应用数据目录前缀。
    for base in [
        BaseDirectory::AppData,
        BaseDirectory::AppConfig,
        BaseDirectory::AppCache,
    ] {
        if let Ok(dir) = app.path().resolve("", base) {
            if for_scope.starts_with(strip_windows_verbatim(&dir)) {
                return true;
            }
        }
    }

    // 2) runtime fs_scope（dialog 授权 + persisted + 显式 allow）。
    let scope = app.fs_scope();
    if scope.is_allowed(for_scope) {
        return true;
    }
    let normalized = for_scope.to_string_lossy().replace('\\', "/");
    let glob_matches = |patterns: &HashSet<Pattern>| {
        patterns.iter().any(|p| {
            glob::Pattern::new(&p.as_str().replace('\\', "/")).is_ok_and(|g| g.matches(&normalized))
        })
    };
    if glob_matches(&scope.forbidden_patterns()) {
        return false;
    }
    if glob_matches(&scope.allowed_patterns()) {
        return true;
    }

    // 3) 仅开发测试构建：webdriver 测试需要读取仓库 fixtures。
    #[cfg(feature = "webdriver")]
    {
        if normalized.contains("/__tests__/") {
            return true;
        }
    }

    false
}

fn is_regular_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// 去掉 Windows verbatim 路径前缀 `\\?\`，仅用于 scope 匹配。
fn strip_windows_verbatim(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => path.to_path_buf(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_path_buf()
    }
}

/// Cover thumbnail target. Sized for the library grid (~250-300px @2x)
/// and the reader-sidebar / detail-view rows (which are smaller still).
/// Anything whose long edge is already at or below this stays untouched —
/// no decode/re-encode, original bytes are kept verbatim. Anything larger
/// is downscaled with [`COVER_RESIZE_FILTER`] and re-encoded as JPEG q85.
pub const COVER_MAX_LONG_EDGE: u32 = 512;
pub const COVER_JPEG_QUALITY: u8 = 85;
// RF7: 解压炸弹防护——封面解码前的尺寸上限。超过则不解码、保留原始字节，
// 避免对超大像素图（如 10000×10000）全量解码占用无界内存/时间。
pub const MAX_COVER_DECODE_DIMENSION: u32 = 8192;

/// Resampling filter used to downscale covers. We deliberately use
/// `Triangle` (4-tap bilinear-ish) instead of `Lanczos3` (36-tap): at the
/// 512px-thumbnail scale the visual difference is imperceptible, but
/// Triangle is ~5-8x faster on a debug build (and ~3-5x faster on release)
/// because it touches far fewer source pixels per output pixel. Cover
/// thumbnails are displayed at <=300px in the UI, so any sharpening
/// advantage Lanczos3 would have is moot.
pub const COVER_RESIZE_FILTER: FilterType = FilterType::Triangle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCoverImage {
    /// Raw image bytes (serde will encode this as a JS array; the JS side
    /// converts it back to a Uint8Array before writing to disk).
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Decode `bytes`, and if the long edge exceeds [`COVER_MAX_LONG_EDGE`],
/// resize ([`COVER_RESIZE_FILTER`], aspect ratio preserved) and re-encode
/// as JPEG at [`COVER_JPEG_QUALITY`].
///
/// On any decode/encode failure we fall back to the original bytes + the
/// caller-provided MIME so a malformed (but viewable) cover still makes it
/// to disk. `hint_mime` is informative only — `image::load_from_memory`
/// sniffs the actual format from the magic bytes, so misclaimed MIMEs in
/// the source container don't trip us up.
pub fn maybe_resize_cover(bytes: Vec<u8>, hint_mime: &str) -> (Vec<u8>, String) {
    // RF7: 解码前先用 ImageReader 只读图像头（不分配像素）检查尺寸，超限直接
    // 返回原始字节，防止解压炸弹（恶意超大封面）导致无界内存/时间消耗。
    if let Ok(reader) = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format() {
        if let Ok((w, h)) = reader.into_dimensions() {
            if w.max(h) > MAX_COVER_DECODE_DIMENSION {
                return (bytes, hint_mime.to_string());
            }
        }
    }
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(_) => return (bytes, hint_mime.to_string()),
    };
    let (w, h) = img.dimensions();
    if w.max(h) <= COVER_MAX_LONG_EDGE {
        return (bytes, hint_mime.to_string());
    }
    let resized = img.resize(
        COVER_MAX_LONG_EDGE,
        COVER_MAX_LONG_EDGE,
        COVER_RESIZE_FILTER,
    );
    let rgb = resized.to_rgb8();

    let mut out = Vec::with_capacity(64 * 1024);
    {
        let mut encoder = JpegEncoder::new_with_quality(Cursor::new(&mut out), COVER_JPEG_QUALITY);
        if encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .is_err()
        {
            return (bytes, hint_mime.to_string());
        }
    }
    (out, "image/jpeg".to_string())
}

/// Mirror of `utils/md5.ts::partialMD5`:
///
/// ```ts
///   step = 1024, size = 1024
///   for i in -1..=10:
///     start = min(file.size, step << (2*i))   // JS 32-bit shift
///     end   = min(start + size, file.size)
///     if start >= file.size: break
///     hash file[start..end]
/// ```
///
/// JS bit-shift operands are masked to their low 5 bits, so `1024 << -2`
/// actually means `1024 << 30`, which is far larger than any reasonable
/// file. That makes the very first iteration (`i = -1`) immediately break
/// for files smaller than ~1 `GiB`, leaving the hasher empty -> md5 of "" =
/// d41d8cd9... We must reproduce that behaviour bit-for-bit so existing
/// on-disk hashes (`Books/<hash>/...`) keep matching.
pub fn compute_partial_md5(path: &Path) -> std::io::Result<String> {
    const STEP: u32 = 1024;
    const CHUNK: u64 = 1024;

    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();

    let mut hasher = Md5::new();
    let mut buf = vec![0u8; CHUNK as usize];

    for i in -1i32..=10 {
        // JS evaluates `step << (2*i)` as a 32-bit shift, where the operand is
        // implicitly masked to its low 5 bits. So `1024 << -2` is the same as
        // `1024 << 30`, which overflows i32 to 0 (the high bits are dropped).
        // For i = 0..=4 the shift is 0..=8 and stays within i32; for i >= 5
        // the result overflows to 0 again. We mirror that with wrapping_shl.
        let shift_amount = ((2 * i) as u32) & 31;
        let shifted = (STEP as i32).wrapping_shl(shift_amount);
        // Negative i32 results coerce to 0 here. JS's Math.min would surface
        // the negative value, but the subsequent `start >= file.size` check
        // would skip the read; clamping to 0 gives the same observable
        // hash for non-empty files while avoiding negative seek offsets.
        let raw = shifted.max(0) as u64;
        let start = std::cmp::min(file_len, raw);
        if start >= file_len {
            break;
        }
        let end = std::cmp::min(start + CHUNK, file_len);
        let to_read = (end - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        let slice = &mut buf[..to_read];
        file.read_exact(slice)?;
        hasher.update(&slice[..]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}
