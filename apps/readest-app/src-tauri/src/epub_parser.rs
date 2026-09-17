// Native EPUB import path (Q1).
//
// Scope after PR review: this command no longer extracts OPF metadata
// (title / author / identifier / language / refines chains / ONIX5 …).
// That graph-shaped XML processing belongs to foliate-js, which the JS
// bridge runs against the same OPF bytes that `parse_epub_full` already
// pre-fetches on the import path. Re-implementing it in Rust would
// silently diverge from the primary platform parser.
//
// What `parse_epub_metadata` still does on the import hot path:
//   - compute partialMD5 over the file (matches utils/md5.ts::partialMD5)
//   - read META-INF/container.xml -> rootfile (.opf)
//   - mini-parse the OPF *only* for cover resolution: collect manifest
//     items (id/href/media-type/properties) and the legacy
//     `<meta name="cover" content="...">` id. We deliberately do NOT
//     read any text content under `<metadata>` — title/author/etc. are
//     foliate's job.
//   - locate the cover image entry (manifest properties="cover-image"
//     first, then meta name="cover" -> manifest item id, then heuristic
//     name match)
//   - downscale the cover via the shared `maybe_resize_cover` helper
//     and return the raw bytes so the JS side can persist them through
//     the existing Books/<hash>/cover.<ext> path. Cover decode/resize
//     stays here because the `image` crate is materially faster than
//     the `createImageBitmap` + canvas round-trip on Android mid-tier
//     devices, and bulk imports actually exercise that.
//   - return the OPF zip path + raw bytes alongside the cover, so the
//     JS bridge can build a one-entry prefetch (synthetic container.xml
//     + OPF) and inject it into `DocumentLoader.open()`. Without this
//     piggy-back the import path would either (a) re-open the zip from
//     `parse_epub_full` to populate the prefetch, doing zip+md5+OPF
//     work twice, or (b) skip the prefetch and let foliate-js inflate
//     the OPF through zip.js. (a) was wasteful, (b) is correct but
//     wastes the OPF bytes we already have in hand. nav/ncx/sizes are
//     deliberately *not* returned here — foliate's `EPUB.init()` only
//     touches them for TOC/spine which the importer never reads, and
//     paying for them is an open-path concern (`parse_epub_full`).
//
// Returned to JS via the parse_epub_metadata Tauri command. The JS side
// continues to drive sectioned reading at runtime, so this module is
// import-only and never opened on the reader hot path.

use percent_encoding::percent_decode;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;
use zip::ZipArchive;

// Cover constants + helpers + RawCoverImage type are shared with `mobi_parser`
// via `parser_common`, so a single tweak (e.g. raising the thumbnail target)
// applies to every native importer.
use crate::parser_common::{compute_partial_md5, maybe_resize_cover, RawCoverImage};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedEpubMetadata {
    pub partial_md5: String,
    /// Pre-resized cover image bytes (after `maybe_resize_cover`), or
    /// `None` when the EPUB has no cover.
    pub cover: Option<Vec<u8>>,
    /// MIME of `cover` after the (optional) re-encode. Always paired
    /// with `cover` (both `Some` or both `None`). The JS side needs
    /// this to detect `image/svg+xml` on the `getCover()` blob and
    /// route through `svg2png` before the cover hits disk —
    /// `Books/<hash>/cover.<ext>` is otherwise a raw byte write that
    /// would skip that conversion and degrade SVG-only covers in the
    /// reader.
    pub cover_mime: Option<String>,
    /// OPF zip path (e.g. "OEBPS/content.opf"). Always populated.
    /// Forwarded to the JS bridge so it can build a synthetic
    /// META-INF/container.xml that points foliate-js at this path
    /// and serve the OPF bytes from an in-memory cache.
    pub opf_path: String,
    /// Raw OPF bytes. Always populated — we already read these for
    /// cover resolution, so propagating them is essentially free and
    /// lets the importer skip a zip.js inflate of the OPF.
    pub opf_bytes: Vec<u8>,
    /// 正文非空白字符数（解压每个 linear spine 文档、去标签后统计）。
    /// 供「导入的这本可能是库里某本的旧版本」确认框做零成本对比——两侧都不能
    /// 为了并排一个数字去现场解析整本书。解压失败或没有任何正文文档时为 None。
    pub text_length: Option<u64>,
    /// 目录条目数：有自带目录时是它的条目数，否则退回 linear spine 文档数。
    pub section_count: Option<usize>,
    /// 自带目录（EPUB3 nav 优先，没有则 NCX）。扁平列表 + 层级，标签保留原文，
    /// JS 侧不解析任何文件就能把两边的章节目录并排展示。
    pub toc: Vec<EpubTocEntry>,
}

/// 目录里的一条：标签 + 层级（0 为顶层）。刻意不带上 href/CFI——确认框只做
/// "多了还是少了、顺序对不对"这种结构级对比，不需要定位能力，而 href 两侧口径
/// 不一致（foliate 会做 href 解码与分组）时反而会造出假差异。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EpubTocEntry {
    pub label: String,
    pub depth: usize,
}

#[tauri::command]
pub async fn parse_epub_metadata(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<ParsedEpubMetadata, String> {
    let path = crate::parser_common::validate_scoped_file(&app, &file_path)?;
    // The body is CPU+IO bound: zip central-directory parse, OPF parse,
    // cover decode/resize/encode. We must NOT run that on the Tauri
    // async runtime worker (the IPC dispatch thread), because then four
    // concurrent JS `invoke()`s queue up serially on a single worker.
    // Offload to the blocking pool, where they truly run in parallel.
    tauri::async_runtime::spawn_blocking(move || parse_epub_metadata_sync(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn parse_epub_metadata_sync(path: &Path) -> Result<ParsedEpubMetadata, String> {
    let partial_md5 = compute_partial_md5(path).map_err(|e| format!("partial_md5 failed: {e}"))?;

    let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("zip open failed: {e}"))?;

    let opf_path = read_rootfile_path(&mut zip).map_err(|e| format!("container.xml: {e}"))?;

    let opf_bytes =
        read_zip_entry(&mut zip, &opf_path).map_err(|e| format!("read opf {opf_path}: {e}"))?;
    // Mini-parse the OPF for cover resolution only: we need the manifest
    // (id → href/media-type/properties) and the legacy
    // `<meta name="cover">` id. Metadata extraction is intentionally not
    // done here — foliate-js is the single source of truth for OPF
    // metadata across platforms, and it parses the same `opf_bytes` that
    // `parse_epub_full` returns on the import hot path.
    let cover_inputs =
        parse_opf_cover_inputs(&opf_bytes).map_err(|e| format!("parse opf cover inputs: {e}"))?;

    let cover_zip_path =
        resolve_cover_path(&cover_inputs.manifest, &cover_inputs.cover_id, &opf_path)
            .or_else(|| find_undeclared_cover_entry(&zip));

    // Inline resize on the import hot path: at our target size (long edge
    // <= 512px, Triangle filter, JPEG q85) a release build keeps per-book
    // overhead well within budget, and avoiding a second on-disk pass keeps
    // the library grid sharp the moment import finishes. spawn_blocking
    // above already gives the 4 concurrent JS workers true parallelism.
    let (cover, cover_mime) = match cover_zip_path.as_deref() {
        Some(cover_path) => match read_zip_entry(&mut zip, cover_path) {
            Ok(bytes) => {
                let mime_hint = guess_image_mime(cover_path);
                let (out_bytes, out_mime) = maybe_resize_cover(bytes, mime_hint);
                (Some(out_bytes), Some(out_mime))
            }
            Err(_) => (None, None),
        },
        None => (None, None),
    };

    // 目录 + 正文规模。这两个值是"导入的这本可能是库里某本的旧版本"确认框的
    // 主要依据，必须在这里顺带算出：确认框打开时不得再解析任何文件，而导入
    // 路径本来就已经在读这个 zip 了。
    let spine = parse_opf_spine(&opf_bytes);
    let toc = match spine.nav_href.as_deref() {
        Some(path) => read_zip_entry(&mut zip, &resolve_relative(&opf_path, path))
            .map(|bytes| parse_nav_toc(&bytes))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let toc = if toc.is_empty() {
        spine
            .ncx_href
            .as_deref()
            .and_then(|path| read_zip_entry(&mut zip, &resolve_relative(&opf_path, path)).ok())
            .map(|bytes| parse_ncx_toc(&bytes))
            .unwrap_or_default()
    } else {
        toc
    };
    let measured = measure_spine_text(&mut zip, &opf_path, &spine.docs, spine.nav_href.as_deref());
    let text_length = measured.map(|(length, _)| length);
    // 有自带目录就报目录条目数（两侧才可比：旧侧的数来自它自己的目录缓存）；
    // 没有目录时退回**算过字数的那些**文档数，至少还能比"正文被切成了几份"。
    // 这里必须用 measure 的计数而不是 spine.docs.len()：后者把 nav 也算进去了。
    let section_count = if !toc.is_empty() {
        Some(toc.len())
    } else {
        measured.map(|(_, counted)| counted)
    };

    Ok(ParsedEpubMetadata {
        partial_md5,
        cover,
        cover_mime,
        opf_path,
        opf_bytes,
        text_length,
        section_count,
        toc,
    })
}

/// Extract the *original* (un-resized) cover bytes from an EPUB. Used by the
/// optional Android lock-screen wallpaper feature, where the user explicitly
/// asked for the full-resolution image rather than the on-disk thumbnail.
///
/// Returns the raw image bytes plus the MIME guessed from the manifest path.
/// If the EPUB has no cover this returns `Err`.
#[tauri::command]
pub async fn extract_epub_cover_full(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<RawCoverImage, String> {
    let path = crate::parser_common::validate_scoped_file(&app, &file_path)?;
    tauri::async_runtime::spawn_blocking(move || extract_epub_cover_full_sync(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn extract_epub_cover_full_sync(path: &Path) -> Result<RawCoverImage, String> {
    let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("zip open failed: {e}"))?;
    let opf_path = read_rootfile_path(&mut zip).map_err(|e| format!("container.xml: {e}"))?;
    let opf_bytes =
        read_zip_entry(&mut zip, &opf_path).map_err(|e| format!("read opf {opf_path}: {e}"))?;
    let cover_inputs =
        parse_opf_cover_inputs(&opf_bytes).map_err(|e| format!("parse opf cover inputs: {e}"))?;
    let cover_zip_path =
        resolve_cover_path(&cover_inputs.manifest, &cover_inputs.cover_id, &opf_path)
            .or_else(|| find_undeclared_cover_entry(&zip))
            .ok_or_else(|| "no cover image in epub".to_string())?;
    let bytes = read_zip_entry(&mut zip, &cover_zip_path)
        .map_err(|e| format!("read cover {cover_zip_path}: {e}"))?;
    let mime = guess_image_mime(&cover_zip_path).to_string();
    Ok(RawCoverImage { bytes, mime })
}

// ---------------------------------------------------------------------------
// parse_epub_full: open hot path (replaces zip.js + foliate EPUB.init() prelude)
//
// On Tauri, the original JS-side `DocumentLoader.open()` for EPUB files spends
// ~1.5-1.7 s on:
//   1. @zip.js/zip.js BlobReader + ZipReader central-directory parse over the
//      whole file (the iOS WebView is markedly slower than Rust's `zip` crate
//      at this for large books);
//   2. unzip + read of META-INF/container.xml, the OPF, and the nav/ncx file;
//   3. DOMParser + parseNav/parseNCX in WebView XML stack.
//
// `parse_epub_full` collapses (1) and (2) into a single Rust call: it opens
// the zip once on the blocking pool, returns the OPF bytes, the nav/ncx bytes,
// the resolved nav/ncx zip paths, and the uncompressed-size of every manifest
// item keyed by its OPF-relative href. The JS side then:
//   - hands those bytes straight to foliate-js (DOMParser + Resources +
//     parseNav/parseNCX) — *no* re-implementation of CFI, TOC, or manifest
//     resolution happens in Rust, so cache compatibility (BookNav,
//     annotations, reading progress) is preserved bit-for-bit;
//   - looks up `getSize(href)` from the returned size map instead of opening
//     the zip again from JS;
//   - retains @zip.js/zip.js *only* for lazy `loadText`/`loadBlob` of section
//     bodies at runtime (the unavoidable WebView-side work — we can't shovel
//     each section over IPC without paying per-call overhead).
//
// Notes:
//   - We deliberately do NOT compute spine CFIs or build the TOC tree in
//     Rust. foliate-js's `CFI.fromElements` and `parseNav`/`parseNCX` walk
//     the live DOM with subtle filtering rules (cfi-inert, NodeFilter, etc.)
//     that we want to keep as the single source of truth across cache
//     versions. The OPF (and toc.ncx / nav.xhtml) is small XML — re-parsing
//     it once in the WebView is cheap; what was expensive was *finding* it
//     and unzipping it.
//   - Encryption isn't handled here (yet). Encrypted EPUBs fall back to the
//     foliate-js path; in practice Readest's EPUBs aren't encrypted.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedEpubFull {
    /// partialMD5 — same algorithm as `parse_epub_metadata`. Returned here so
    /// open-hot-path callers don't need a second IPC round-trip just to hash.
    pub partial_md5: String,
    /// OPF zip path (e.g. "OEBPS/content.opf"). foliate-js needs this to
    /// resolve relative hrefs in the manifest.
    pub opf_path: String,
    /// Raw OPF bytes (XML). The JS side parses this with DOMParser and feeds
    /// it to foliate-js's `Resources` class — keeping CFI / manifest /
    /// metadata semantics 1:1 with the existing JS path.
    pub opf_bytes: Vec<u8>,
    /// Resolved nav.xhtml zip path, if the manifest declares
    /// `properties="nav"`. `None` when only an NCX or no TOC is present.
    pub nav_path: Option<String>,
    /// Raw nav.xhtml bytes when `nav_path` is `Some`.
    pub nav_bytes: Option<Vec<u8>>,
    /// Resolved toc.ncx zip path. Looked up via `<spine toc="...">` first,
    /// falling back to the first manifest item with media-type
    /// `application/x-dtbncx+xml`.
    pub ncx_path: Option<String>,
    /// Raw toc.ncx bytes when `ncx_path` is `Some`.
    pub ncx_bytes: Option<Vec<u8>>,
    /// Map: OPF-resolved href (e.g. "OEBPS/text/chapter1.xhtml") →
    /// uncompressedSize from the zip central directory. JS uses this for
    /// `getSize(item.href)` without re-opening the zip.
    pub sizes: std::collections::HashMap<String, u64>,
}

#[tauri::command]
pub async fn parse_epub_full(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<ParsedEpubFull, String> {
    let path = crate::parser_common::validate_scoped_file(&app, &file_path)?;
    // Same threading rationale as parse_epub_metadata — keep IPC dispatch off
    // the CPU-bound zip/parse work so concurrent opens stay parallel.
    tauri::async_runtime::spawn_blocking(move || parse_epub_full_sync(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn parse_epub_full_sync(path: &Path) -> Result<ParsedEpubFull, String> {
    let partial_md5 = compute_partial_md5(path).map_err(|e| format!("partial_md5 failed: {e}"))?;

    let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("zip open failed: {e}"))?;

    let opf_path = read_rootfile_path(&mut zip).map_err(|e| format!("container.xml: {e}"))?;

    let opf_bytes =
        read_zip_entry(&mut zip, &opf_path).map_err(|e| format!("read opf {opf_path}: {e}"))?;

    // Locate the nav and ncx targets without committing to a full OPF parse.
    // We need just three things from the OPF:
    //   - <manifest><item properties="...nav..."/> → href (EPUB3 nav doc)
    //   - <spine toc="ncx-id"> → href via manifest[id]
    //   - fallback: first <item media-type="application/x-dtbncx+xml"/>
    // A streaming pass with quick-xml gives us all three in one go and stays
    // O(OPF size) — measured at <1 ms even on big OPFs.
    let LocatedTocSources { nav_href, ncx_href } =
        locate_toc_sources(&opf_bytes).map_err(|e| format!("locate toc: {e}"))?;

    let nav_path = nav_href.map(|h| resolve_relative(&opf_path, &h));
    let ncx_path = ncx_href.map(|h| resolve_relative(&opf_path, &h));

    // Soft-fail on read errors: a missing nav/ncx doc isn't fatal; foliate-js
    // will fall back to NCX or to an empty TOC.
    let nav_bytes = nav_path
        .as_deref()
        .and_then(|p| read_zip_entry(&mut zip, p).ok());

    let ncx_bytes = ncx_path
        .as_deref()
        .and_then(|p| read_zip_entry(&mut zip, p).ok());

    // Build the size map from the central directory. We key by zip path
    // (OPF-relative href, normalized via resolve_relative on the JS side).
    // Walking the central directory in Rust is essentially free here — the
    // entries() iterator pulls from the cached metadata, no decompression.
    let mut sizes: std::collections::HashMap<String, u64> =
        std::collections::HashMap::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = match zip.by_index_raw(i) {
            Ok(e) => e,
            // by_index_raw can fail on encrypted entries; skip silently.
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        sizes.insert(entry.name().to_string(), entry.size());
    }

    Ok(ParsedEpubFull {
        partial_md5,
        opf_path,
        opf_bytes,
        nav_path,
        nav_bytes,
        ncx_path,
        ncx_bytes,
        sizes,
    })
}

/// Hrefs found in the OPF, *as written* (not yet resolved against opf_path).
struct LocatedTocSources {
    nav_href: Option<String>,
    ncx_href: Option<String>,
}

/// Single-pass streaming scan of the OPF bytes to extract the nav document
/// href and the NCX href. Mirrors foliate-js Resources logic:
///
///   - nav: first manifest <item> whose `properties` contains the token "nav"
///   - ncx: <spine toc="..."> resolves to manifest[id]; otherwise the first
///     manifest <item> with media-type application/x-dtbncx+xml
fn locate_toc_sources(opf_bytes: &[u8]) -> Result<LocatedTocSources, String> {
    // We collect manifest items by id in a small map and remember the
    // <spine toc="..."> attribute (if any). We also short-circuit nav_href
    // as soon as we find a "nav" property.
    use std::collections::HashMap;

    let normalized = strip_xml_bom(opf_bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    // `<item ... />` and `<item ...></item>` are equivalent XML, but quick-xml
    // reports the first as Empty and the second as Start + End. Expanding
    // empty elements collapses both onto the Start/End path so publishers who
    // serialise with explicit closing tags aren't silently skipped (#5455).
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();

    #[derive(Default, Clone)]
    struct Item {
        href: String,
        media_type: String,
        properties: String,
    }

    let mut manifest: HashMap<String, Item> = HashMap::new();
    let mut spine_toc_id: Option<String> = None;
    let mut nav_href: Option<String> = None;
    let mut in_manifest = false;
    let mut in_spine = false;

    let process_item = |attrs: &[(Vec<u8>, Vec<u8>)],
                        manifest: &mut HashMap<String, Item>,
                        nav_href: &mut Option<String>| {
        let mut id = String::new();
        let mut item = Item::default();
        for (k, v) in attrs {
            match k.as_slice() {
                b"id" => id = String::from_utf8_lossy(v).into_owned(),
                b"href" => item.href = String::from_utf8_lossy(v).into_owned(),
                b"media-type" => item.media_type = String::from_utf8_lossy(v).into_owned(),
                b"properties" => item.properties = String::from_utf8_lossy(v).into_owned(),
                _ => {}
            }
        }
        if nav_href.is_none()
            && item.properties.split_ascii_whitespace().any(|p| p == "nav")
            && !item.href.is_empty()
        {
            *nav_href = Some(item.href.clone());
        }
        if !id.is_empty() {
            manifest.insert(id, item);
        }
    };

    let process_spine = |attrs: &[(Vec<u8>, Vec<u8>)], spine_toc_id: &mut Option<String>| {
        for (k, v) in attrs {
            if k.as_slice() == b"toc" {
                *spine_toc_id = Some(String::from_utf8_lossy(v).into_owned());
                break;
            }
        }
    };

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = true;
                } else if name == b"spine" {
                    in_spine = true;
                    let attrs: Vec<(Vec<u8>, Vec<u8>)> = e
                        .attributes()
                        .flatten()
                        .map(|a| (a.key.as_ref().to_vec(), a.value.into_owned()))
                        .collect();
                    process_spine(&attrs, &mut spine_toc_id);
                } else if in_manifest && name == b"item" {
                    let attrs: Vec<(Vec<u8>, Vec<u8>)> = e
                        .attributes()
                        .flatten()
                        .map(|a| (a.key.as_ref().to_vec(), a.value.into_owned()))
                        .collect();
                    process_item(&attrs, &mut manifest, &mut nav_href);
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = false;
                } else if name == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xml: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let _ = in_spine; // suppress unused (kept for symmetry / future use)

    // Resolve NCX:
    //   1. <spine toc="id"> → manifest[id].href
    //   2. fallback: any item with the NCX media-type
    let ncx_href = spine_toc_id
        .as_ref()
        .and_then(|id| manifest.get(id))
        .map(|it| it.href.clone())
        .or_else(|| {
            manifest
                .values()
                .find(|it| it.media_type == "application/x-dtbncx+xml")
                .map(|it| it.href.clone())
        });

    Ok(LocatedTocSources { nav_href, ncx_href })
}

// `maybe_resize_cover` is now defined in `parser_common`; the description
// below is retained here for navigation from EPUB-side call sites.
//
// Decode `bytes`, and:
//   - if max(width, height) <= COVER_MAX_LONG_EDGE, return the original
//     bytes verbatim (no decode/re-encode round-trip — preserves quality
//     and avoids needlessly re-compressing already-small covers, which
//     was point 2 of the user's brief);
//   - otherwise, resize so the long edge equals COVER_MAX_LONG_EDGE
//     (COVER_RESIZE_FILTER, aspect ratio preserved) and re-encode as
//     JPEG at COVER_JPEG_QUALITY.
//
// On any decode/encode failure we fall back to the original bytes + the
// caller-provided MIME so a malformed (but viewable) cover still makes it
// to disk.

// ---------------------------------------------------------------------------
// partial_md5: matches utils/md5.ts::partialMD5
//   step = 1024, size = 1024
//   for i in -1..=10:
//     start = step << (2*i)  (clamped to file end - size)
//     read 1024 bytes; feed into md5 incrementally
//
// (`compute_partial_md5` is now defined in `parser_common`; the comment
// block above is retained here for navigation from EPUB-side call sites.)
// ---------------------------------------------------------------------------

fn read_zip_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, path: &str) -> Result<Vec<u8>, String> {
    // Two-pass lookup, mirroring what epub-rs does (archive.rs) and what
    // foliate-js does on the JS side: many EPUBs declare manifest hrefs that
    // are percent-encoded (e.g. "Text/My%20Chapter.xhtml" or CJK %E4%BB%96)
    // while the zip itself stores the raw decoded bytes — or vice versa.
    // We try the literal path first (the common case), then fall back to a
    // percent-decoded variant if it differs.
    if let Ok(bytes) = read_by_name(zip, path) {
        return Ok(bytes);
    }
    let decoded = percent_decode(path.as_bytes()).decode_utf8_lossy();
    if decoded.as_ref() != path {
        if let Ok(bytes) = read_by_name(zip, decoded.as_ref()) {
            return Ok(bytes);
        }
    }
    Err(format!("entry {path}: not found"))
}

fn read_by_name<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut entry = zip
        .by_name(name)
        .map_err(|e| format!("entry {name}: {e}"))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {name}: {e}"))?;
    Ok(buf)
}

fn read_rootfile_path<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<String, String> {
    let bytes = read_zip_entry(zip, "META-INF/container.xml")?;
    let normalized = strip_xml_bom(&bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if local_name_eq(e.name().as_ref(), b"rootfile") {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            return Ok(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xml: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Err("rootfile not found".into())
}

// ---------------------------------------------------------------------------
// OPF parsing — *cover-only* slice
//
// We deliberately do NOT walk `<metadata>` text content here. The full
// set of OPF metadata semantics (refines chains, marc-relator role
// bucketing, language maps, EPUB3 `belongs-to-collection`, ONIX5
// codelists, …) belongs to foliate-js, which the JS bridge invokes on
// the OPF bytes pre-fetched by `parse_epub_full`. The Rust side only
// walks the `<manifest>` (so it can pick a cover entry) and the legacy
// `<meta name="cover" content="..."/>` shorthand; everything else is
// ignored by design.
// ---------------------------------------------------------------------------
#[derive(Debug, Default)]
struct ManifestItem {
    href: String,
    media_type: String,
    properties: String,
}

/// Subset of the OPF that's relevant to cover resolution. Populated by
/// `parse_opf_cover_inputs` and consumed by `resolve_cover_path`.
#[derive(Debug, Default)]
struct OpfCoverInputs {
    /// id → manifest item. Needed for the `<meta name="cover" content="id">`
    /// legacy shorthand and for the `properties="cover-image"` lookup.
    manifest: std::collections::HashMap<String, ManifestItem>,
    /// Value of the legacy `<meta name="cover" content="...">` element, if
    /// present. EPUB2 publishers used this to point at the cover manifest
    /// item by id.
    cover_id: Option<String>,
}

/// Streaming pass over the OPF that picks out only the bits needed for
/// cover resolution. Skips `<metadata>` text content entirely (we don't
/// want partial / divergent metadata leaking into the import path).
fn parse_opf_cover_inputs(bytes: &[u8]) -> Result<OpfCoverInputs, String> {
    let normalized = strip_xml_bom(bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    // See `locate_toc_sources`: expand `<item/>` / `<meta/>` into Start + End
    // so publishers that emit explicit closing tags parse identically (#5455).
    reader.config_mut().expand_empty_elements = true;
    let mut out = OpfCoverInputs::default();
    let mut buf = Vec::new();

    let mut in_metadata = false;
    let mut in_manifest = false;

    let process_manifest_item =
        |attrs: &[(Vec<u8>, Vec<u8>)],
         manifest: &mut std::collections::HashMap<String, ManifestItem>| {
            let mut id = String::new();
            let mut item = ManifestItem::default();
            for (k, v) in attrs {
                match k.as_slice() {
                    b"id" => id = String::from_utf8_lossy(v).into_owned(),
                    b"href" => item.href = String::from_utf8_lossy(v).into_owned(),
                    b"media-type" => item.media_type = String::from_utf8_lossy(v).into_owned(),
                    b"properties" => item.properties = String::from_utf8_lossy(v).into_owned(),
                    _ => {}
                }
            }
            if !id.is_empty() {
                manifest.insert(id, item);
            }
        };

    let process_meta_cover = |attrs: &[(Vec<u8>, Vec<u8>)], cover_id: &mut Option<String>| {
        // Only the legacy OPF2 `<meta name="cover" content="<id>"/>` form is
        // relevant — EPUB3 `<meta property=...>` carries metadata like
        // dcterms:* that we leave to foliate-js.
        let mut name = None::<&[u8]>;
        let mut content = None::<&[u8]>;
        for (k, v) in attrs {
            match k.as_slice() {
                b"name" => name = Some(v.as_slice()),
                b"content" => content = Some(v.as_slice()),
                _ => {}
            }
        }
        if let (Some(n), Some(c)) = (name, content) {
            if n.eq_ignore_ascii_case(b"cover") && cover_id.is_none() && !c.is_empty() {
                *cover_id = Some(String::from_utf8_lossy(c).into_owned());
            }
        }
    };

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"metadata" {
                    in_metadata = true;
                } else if name == b"manifest" {
                    in_manifest = true;
                } else if (in_manifest && name == b"item") || (in_metadata && name == b"meta") {
                    let attrs: Vec<(Vec<u8>, Vec<u8>)> = e
                        .attributes()
                        .flatten()
                        .map(|a| (a.key.as_ref().to_vec(), a.value.into_owned()))
                        .collect();
                    if name == b"item" {
                        process_manifest_item(&attrs, &mut out.manifest);
                    } else {
                        process_meta_cover(&attrs, &mut out.cover_id);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"metadata" {
                    in_metadata = false;
                } else if name == b"manifest" {
                    in_manifest = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xml: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Spine + TOC + 正文规模 — 版本对比用的结构级事实
//
// 同样是"顺带"：导入路径本来就打开了这个 zip、读过了 OPF。产出只有三样——
// linear spine 文档（用于统计正文）、自带目录（nav / NCX 的标签与层级）、
// 正文非空白字符数。刻意不做 DOM、不做 CFI、不做 href 规范化：这些属于
// foliate-js，重复实现只会和阅读器侧的口径分叉。
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct SpineDoc {
    /// Manifest href，原样保留（未拼 OPF 目录）。
    href: String,
}

#[derive(Debug, Default)]
struct OpfSpine {
    docs: Vec<SpineDoc>,
    /// `<item properties="nav">` 的 href（EPUB3 导航文档）。
    nav_href: Option<String>,
    /// `application/x-dtbncx+xml` manifest item 的 href（EPUB2 目录）。
    ncx_href: Option<String>,
}

/// 单次流式遍历 OPF：收集 manifest 与 spine。`<spine>` 只取 `linear != "no"`
/// 的条目——非线性的文档不在阅读顺序里，算进"正文规模"会把两侧都算歪。
fn parse_opf_spine(bytes: &[u8]) -> OpfSpine {
    let normalized = strip_xml_bom(bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();

    let mut manifest: Vec<(String, String, String)> = Vec::new(); // (id, href, properties)
    let mut media_types: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut idrefs: Vec<(String, bool)> = Vec::new(); // (idref, linear)
    let mut in_manifest = false;
    let mut in_spine = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = true;
                } else if name == b"spine" {
                    in_spine = true;
                } else if in_manifest && name == b"item" {
                    let mut id = String::new();
                    let mut href = String::new();
                    let mut properties = String::new();
                    let mut media_type = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"id" => id = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"href" => href = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"properties" => {
                                properties = String::from_utf8_lossy(&attr.value).into_owned()
                            }
                            b"media-type" => {
                                media_type = String::from_utf8_lossy(&attr.value).into_owned()
                            }
                            _ => {}
                        }
                    }
                    if !media_type.is_empty() {
                        media_types.insert(id.clone(), media_type);
                    }
                    manifest.push((id, href, properties));
                } else if in_spine && name == b"itemref" {
                    let mut idref = String::new();
                    let mut linear = true;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"idref" => idref = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"linear" => linear = !attr.value.eq_ignore_ascii_case(b"no"),
                            _ => {}
                        }
                    }
                    if !idref.is_empty() {
                        idrefs.push((idref, linear));
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = false;
                } else if name == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let mut docs = Vec::new();
    for (idref, linear) in &idrefs {
        if !*linear {
            continue;
        }
        let Some((_, href, _)) = manifest.iter().find(|(id, _, _)| id == idref) else {
            continue;
        };
        // 只把 XHTML/HTML 文档算进正文规模：spine 里偶尔混进 SVG 章节或
        // 图片页，解压它们既慢又没有字数可言。
        if !media_types
            .get(idref)
            .map(|mt| is_text_document(mt))
            .unwrap_or(false)
        {
            continue;
        }
        docs.push(SpineDoc { href: href.clone() });
    }

    let nav_href = manifest
        .iter()
        .find(|(_, _, props)| props.split_ascii_whitespace().any(|p| p == "nav"))
        .map(|(_, href, _)| href.clone());
    let ncx_href = manifest
        .iter()
        .find(|(id, _, _)| {
            media_types
                .get(id)
                .map(|mt| mt == "application/x-dtbncx+xml")
                .unwrap_or(false)
        })
        .map(|(_, href, _)| href.clone());

    OpfSpine {
        docs,
        nav_href,
        ncx_href,
    }
}

fn is_text_document(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/xhtml+xml" | "text/html" | "application/x-dtbook+xml"
    )
}

/// 解压每个 spine 文档并统计正文非空白字符数。任何一个文档读失败都跳过；
/// 一个都读不到时返回 None（"未记录"比一个骗人的 0 好）。
///
/// `nav_href` 是 EPUB3 导航文档：它允许被列在 spine 里，但那是目录页不是正文，
/// 链接文字不能算字数（与已排除的 `<title>` 同一类口径）。
/// 返回 (正文非空白字符数, 计入正文的文档数)——文档数排除 nav，与字数同一口径。
fn measure_spine_text<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    opf_path: &str,
    docs: &[SpineDoc],
    nav_href: Option<&str>,
) -> Option<(u64, usize)> {
    if docs.is_empty() {
        return None;
    }
    let nav_path = nav_href.map(|href| resolve_relative(opf_path, href));
    let mut total: u64 = 0;
    let mut counted: usize = 0;
    let mut read_any = false;
    for doc in docs {
        let path = resolve_relative(opf_path, &doc.href);
        if nav_path.as_deref() == Some(path.as_str()) {
            continue;
        }
        let Ok(bytes) = read_zip_entry(zip, &path) else {
            continue;
        };
        read_any = true;
        counted += 1;
        // 与 parse_opf_spine / parse_nav_toc / parse_ncx_toc 一致地先归一 BOM：
        // UTF-16 的 XHTML 每个字符后面跟一个 NUL，那些 NUL 不是空白符、会被照数，
        // 字数大约翻倍（EPUB 规范允许 UTF-16）；UTF-8 的 BOM 则多算 1。
        total += count_non_whitespace_text(&String::from_utf8_lossy(&strip_xml_bom(&bytes)));
    }
    if read_any {
        Some((total, counted))
    } else {
        None
    }
}

/// 数一段标记文本里的非空白字符：跳过标签、注释、`<script>`/`<style>` 内容，
/// 每个实体引用（`&amp;` 这类）算一个字符。不做实体解码表——对"两侧比字数"
/// 这件事，`&` 与 `&amp;` 的差别远小于它带来的解析复杂度。
fn count_non_whitespace_text(html: &str) -> u64 {
    let chars: Vec<char> = html.chars().collect();
    let mut count: u64 = 0;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            if chars[i..].starts_with(&['<', '!', '-', '-']) {
                let mut j = i + 4;
                while j + 2 < chars.len()
                    && !(chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>')
                {
                    j += 1;
                }
                i = (j + 3).min(chars.len());
                continue;
            }
            let head: String = chars[i..(i + 8).min(chars.len())].iter().collect();
            let head = head.to_ascii_lowercase();
            // script / style / head 的内容都不是正文：连同闭合标签一起跳过。
            // head 一起跳过是为了 `<title>`——它是元数据，把它算进"正文字数"
            // 会让两侧的字数都凭空多出书名那几十个字。
            // 取标签名本身再比对，别用前缀匹配：`<header>` 也会被 `<head` 前缀命中，
            // 那时后面的 `</head` 查找会把正文整段吞掉。
            let tag_name: String = head
                .chars()
                .skip(1)
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            let skip_to = match tag_name.as_str() {
                "script" => Some("</script"),
                "style" => Some("</style"),
                "head" => Some("</head"),
                _ => None,
            };
            // 标签可能带属性，属性值里也可能出现 '>'，按引号状态找真正的结束。
            let mut j = i + 1;
            let mut quote: Option<char> = None;
            while j < chars.len() {
                match quote {
                    Some(q) => {
                        if chars[j] == q {
                            quote = None;
                        }
                    }
                    None => {
                        if chars[j] == '"' || chars[j] == '\'' {
                            quote = Some(chars[j]);
                        } else if chars[j] == '>' {
                            break;
                        }
                    }
                }
                j += 1;
            }
            i = (j + 1).min(chars.len());
            if let Some(close) = skip_to {
                if let Some(pos) = find_ascii_case_insensitive(&chars, i, close) {
                    i = pos;
                }
            }
            continue;
        }
        if c == '&' {
            // 实体引用算一个字符；找不到 ';' 或超出合理长度就当作普通的 '&'。
            let mut j = i + 1;
            let mut terminated = false;
            while j < chars.len() && j - i <= 32 {
                let ch = chars[j];
                if ch == ';' {
                    terminated = true;
                    break;
                }
                if ch.is_whitespace() || ch == '<' || ch == '&' {
                    break;
                }
                j += 1;
            }
            if terminated {
                count += 1;
                i = j + 1;
                continue;
            }
        }
        if !c.is_whitespace() {
            count += 1;
        }
        i += 1;
    }
    count
}

/// 不分配字符串的 ASCII 大小写无关查找。`count_non_whitespace_text` 要为每个
/// `<script>` 找闭合标签，而整章内容可能上百 KB——每次 `to_lowercase()` 一份
/// 副本会让一本带几十段脚本的书白白分配掉几十兆。
fn find_ascii_case_insensitive(chars: &[char], from: usize, needle: &str) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || chars.len() < needle.len() {
        return None;
    }
    let last_start = chars.len() - needle.len();
    let mut i = from;
    'outer: while i <= last_start {
        for (offset, expected) in needle.iter().enumerate() {
            if chars[i + offset].to_ascii_lowercase() != *expected {
                i += 1;
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// EPUB3 导航文档里的 `<nav epub:type="toc">` → 扁平条目列表。
fn parse_nav_toc(bytes: &[u8]) -> Vec<EpubTocEntry> {
    let normalized = strip_xml_bom(bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();
    let mut entries = Vec::new();
    let mut in_toc_nav = false;
    let mut nav_depth = 0usize;
    let mut list_depth = 0usize;
    let mut capturing = false;
    let mut label = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"nav" {
                    nav_depth += 1;
                    // epub:type 的前缀可以是任意的（`epub:type` / `type`），
                    // 只看本地名即可。
                    in_toc_nav = e.attributes().flatten().any(|attr| {
                        local_name_eq(attr.key.as_ref(), b"type")
                            && String::from_utf8_lossy(&attr.value)
                                .split_ascii_whitespace()
                                .any(|t| t == "toc")
                    });
                } else if name == b"ol" && in_toc_nav {
                    list_depth += 1;
                } else if name == b"a" && in_toc_nav {
                    capturing = true;
                    label.clear();
                }
            }
            Ok(Event::Text(t)) if capturing => {
                label.push_str(&String::from_utf8_lossy(t.as_ref()));
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"a" && capturing {
                    capturing = false;
                    let label = label.trim().to_string();
                    if !label.is_empty() {
                        entries.push(EpubTocEntry {
                            label,
                            depth: list_depth.saturating_sub(1),
                        });
                    }
                } else if name == b"ol" && in_toc_nav {
                    list_depth = list_depth.saturating_sub(1);
                } else if name == b"nav" {
                    nav_depth = nav_depth.saturating_sub(1);
                    if nav_depth == 0 {
                        in_toc_nav = false;
                        list_depth = 0;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    entries
}

/// EPUB2 `toc.ncx` 的 `<navMap>` → 扁平条目列表（`navPoint` 嵌套即层级）。
fn parse_ncx_toc(bytes: &[u8]) -> Vec<EpubTocEntry> {
    let normalized = strip_xml_bom(bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();
    let mut entries = Vec::new();
    let mut point_depth = 0usize;
    let mut in_label = false;
    let mut capturing = false;
    let mut label = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if local_name_eq_ignore_ascii_case(e.name().as_ref(), b"navpoint") {
                    point_depth += 1;
                } else if local_name_eq_ignore_ascii_case(e.name().as_ref(), b"navlabel") {
                    in_label = true;
                } else if in_label && local_name_eq_ignore_ascii_case(e.name().as_ref(), b"text") {
                    capturing = true;
                    label.clear();
                }
            }
            Ok(Event::Text(t)) if capturing => {
                label.push_str(&String::from_utf8_lossy(t.as_ref()));
            }
            Ok(Event::End(e)) => {
                if capturing && local_name_eq_ignore_ascii_case(e.name().as_ref(), b"text") {
                    capturing = false;
                } else if local_name_eq_ignore_ascii_case(e.name().as_ref(), b"navlabel") {
                    in_label = false;
                    let text = label.trim().to_string();
                    if !text.is_empty() {
                        entries.push(EpubTocEntry {
                            label: text,
                            depth: point_depth.saturating_sub(1),
                        });
                    }
                    label.clear();
                } else if local_name_eq_ignore_ascii_case(e.name().as_ref(), b"navpoint") {
                    point_depth = point_depth.saturating_sub(1);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    entries
}

// ---------------------------------------------------------------------------
// Cover resolution
// ---------------------------------------------------------------------------
fn resolve_cover_path(
    manifest: &std::collections::HashMap<String, ManifestItem>,
    cover_id: &Option<String>,
    opf_path: &str,
) -> Option<String> {
    // 1) properties="cover-image" (EPUB3)
    for item in manifest.values() {
        if item
            .properties
            .split_ascii_whitespace()
            .any(|p| p == "cover-image")
        {
            return Some(resolve_relative(opf_path, &item.href));
        }
    }
    // 2) <meta name="cover" content="<id>"/> -> manifest[id] (EPUB2)
    if let Some(id) = cover_id {
        if let Some(item) = manifest.get(id) {
            return Some(resolve_relative(opf_path, &item.href));
        }
    }
    // 3) Heuristic: image item whose id/href contains "cover".
    //
    // Two-pass strategy:
    //   pass 1 (preferred): raster images only (skip image/svg+xml, since SVG
    //                       items are usually the cover *page* wrapping a real
    //                       raster, not the cover image itself); also skip any
    //                       item carrying the `nav` property as a defensive
    //                       guard (spec puts `nav` on xhtml, but properties is
    //                       a token list and we don't want to ever pick it).
    //   pass 2 (fallback): if pass 1 found nothing (e.g. the EPUB only ships
    //                      SVG covers), allow SVG so we don't lose covers on
    //                      odd-but-valid EPUBs. `nav` is still excluded.
    fn pick(
        manifest: &std::collections::HashMap<String, ManifestItem>,
        allow_svg: bool,
    ) -> Option<&ManifestItem> {
        let mut best: Option<&ManifestItem> = None;
        for item in manifest.values() {
            if !item.media_type.starts_with("image/") {
                continue;
            }
            if !allow_svg && item.media_type == "image/svg+xml" {
                continue;
            }
            if item.properties.split_ascii_whitespace().any(|p| p == "nav") {
                continue;
            }
            let href_l = item.href.to_ascii_lowercase();
            if href_l.contains("cover") {
                return Some(item);
            }
            if best.is_none() {
                best = Some(item);
            }
        }
        best
    }

    let chosen = pick(manifest, false).or_else(|| pick(manifest, true));
    chosen.map(|item| resolve_relative(opf_path, &item.href))
}

/// Whether a container entry name ends in `cover`/`couv` (the French
/// spelling) plus an image extension, e.g. `cover.jpg`, `Images/Cover.PNG`,
/// `couv.jpeg`. Mirrors `UNDECLARED_COVER_RE` in foliate-js's `epub.js` so
/// both parsers surface the same image.
fn is_undeclared_cover_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some((stem, ext)) = lower.rsplit_once('.') else {
        return false;
    };
    if !matches!(ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg") {
        return false;
    }
    stem.ends_with("cover") || stem.ends_with("couv")
}

/// Last-ditch cover lookup for EPUBs where `resolve_cover_path` came up
/// empty: scan the container's own entry names. Some EPUBs ship the cover
/// image without ever declaring it (no `cover-image` property, no
/// `<meta name="cover">` target, no manifest item), which leaves every
/// manifest-driven lookup empty even though the image is in the zip.
/// Entries are walked in central-directory order, so the first match wins.
fn find_undeclared_cover_entry<R: Read + Seek>(zip: &ZipArchive<R>) -> Option<String> {
    (0..zip.len())
        .filter_map(|i| zip.name_for_index(i))
        .find(|name| is_undeclared_cover_name(name))
        .map(str::to_string)
}

fn resolve_relative(opf_path: &str, href: &str) -> String {
    // Strip query/fragment that occasionally appear in manifest hrefs.
    let href = href.split(['?', '#']).next().unwrap_or(href);
    let dir = match opf_path.rfind('/') {
        Some(idx) => &opf_path[..idx],
        None => "",
    };
    let joined = if dir.is_empty() {
        href.to_string()
    } else {
        format!("{dir}/{href}")
    };
    normalize_zip_path(&joined)
}

fn normalize_zip_path(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

fn guess_image_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        // Default for .jpg / .jpeg and any other extension; the JS importer
        // also assumes JPEG when the manifest media-type is missing/unknown.
        "image/jpeg"
    }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/// Normalize the byte payload of an XML document for `quick-xml`:
///
///   - strip a leading UTF-8 BOM (EF BB BF) — quick-xml otherwise emits a
///     spurious `Text` event before the prolog and some declarations fail
///     to parse;
///   - if the document begins with a UTF-16 BOM (FE FF or FF FE), transcode
///     to UTF-8 lossily so the rest of our pipeline can keep treating bytes
///     as UTF-8. Real-world EPUBs are very rarely UTF-16 but a handful of
///     publisher tools (notably old Adobe InDesign exports) still emit it.
///
/// Returns a `Cow` so the common (UTF-8, no BOM) case stays zero-copy.
fn strip_xml_bom(bytes: &[u8]) -> Cow<'_, [u8]> {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return Cow::Borrowed(&bytes[3..]);
    }
    if bytes.len() >= 2 {
        let big_endian = bytes[0] == 0xFE && bytes[1] == 0xFF;
        let little_endian = bytes[0] == 0xFF && bytes[1] == 0xFE;
        if big_endian || little_endian {
            let body = &bytes[2..];
            // chunks_exact silently drops a trailing odd byte, which is what
            // we want — a malformed UTF-16 stream still produces a best-
            // effort UTF-8 transcoding rather than failing the whole import.
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| {
                    if big_endian {
                        u16::from_be_bytes([c[0], c[1]])
                    } else {
                        u16::from_le_bytes([c[0], c[1]])
                    }
                })
                .collect();
            let s = String::from_utf16_lossy(&units);
            return Cow::Owned(s.into_bytes());
        }
    }
    Cow::Borrowed(bytes)
}

fn local_name(qname: &[u8]) -> &[u8] {
    match qname.iter().rposition(|b| *b == b':') {
        Some(idx) => &qname[idx + 1..],
        None => qname,
    }
}

fn local_name_eq(qname: &[u8], local: &[u8]) -> bool {
    local_name(qname) == local
}

/// 大小写无关的本地名比较。NCX 的元素名是驼峰（`navPoint` / `navLabel`），而
/// OPF/XHTML 全是小写——同一份代码要认两种拼写。
fn local_name_eq_ignore_ascii_case(qname: &[u8], local: &[u8]) -> bool {
    local_name(qname).eq_ignore_ascii_case(local)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Pulled in here (rather than at module scope) because the production
    // code now consumes the cover-resize / partial-md5 helpers through
    // `parser_common`; the tests still need `image::*`, `Cursor`, `Md5`
    // and friends to synthesise fixtures and cross-check the hash.
    use crate::parser_common::COVER_MAX_LONG_EDGE;
    use image::GenericImageView;
    use md5::{Digest, Md5};
    use std::collections::HashMap;
    use std::io::Cursor;

    #[test]
    fn parse_opf_cover_inputs_extracts_manifest_and_legacy_cover_id() {
        // Cover-only invariants: the mini-parser pulls out the manifest
        // items (with id/href/media-type/properties) and the OPF2 legacy
        // `<meta name="cover" content="...">` shorthand. Everything else
        // under `<metadata>` (title/author/dates/calibre:* etc.) is left
        // entirely to foliate-js on the JS side.
        let xml = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Great Gatsby</dc:title>
    <dc:creator>F. Scott Fitzgerald</dc:creator>
    <meta name="cover" content="cover-img"/>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
</package>"#;
        let inputs = parse_opf_cover_inputs(xml).expect("opf parses");
        assert_eq!(inputs.cover_id.as_deref(), Some("cover-img"));
        assert_eq!(inputs.manifest.len(), 3);
        let cover = inputs.manifest.get("cover-img").expect("cover entry");
        assert_eq!(cover.href, "images/cover.jpg");
        assert_eq!(cover.media_type, "image/jpeg");
        assert!(cover.properties.is_empty());
        let nav = inputs.manifest.get("nav").expect("nav entry");
        assert_eq!(nav.properties, "nav");
    }

    #[test]
    fn parse_opf_cover_inputs_ignores_metadata_text_content() {
        // Smoke test: rich `<metadata>` content (refines chains, EPUB3
        // property meta, calibre legacy entries) must not throw and must
        // produce no spurious cover_id when there's no `name="cover"`.
        let xml = br##"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title id="t">Book</dc:title>
    <meta refines="#t" property="title-type">main</meta>
    <meta property="belongs-to-collection" id="c1">My Series</meta>
    <meta refines="#c1" property="collection-type">series</meta>
    <meta refines="#c1" property="group-position">3</meta>
    <meta name="calibre:series" content="My Series"/>
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>"##;
        let inputs = parse_opf_cover_inputs(xml).expect("opf parses");
        assert!(inputs.cover_id.is_none());
        assert_eq!(inputs.manifest.len(), 1);
    }

    #[test]
    fn parse_opf_cover_inputs_handles_expanded_item_and_meta_tags() {
        // Issue #5455: some OPDS servers serialise the OPF with explicit
        // closing tags (`<item ...></item>`, `<meta ...></meta>`) instead of
        // self-closing ones. quick-xml reports those as Start + End rather
        // than Empty, and the cover-input scan must treat both forms alike.
        let xml = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Expanded Tags</dc:title>
    <meta content="cover-image" name="cover"></meta>
  </metadata>
  <manifest>
    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image">
    </item>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"></item>
  </manifest>
</package>"#;
        let inputs = parse_opf_cover_inputs(xml).expect("opf parses");
        assert_eq!(inputs.cover_id.as_deref(), Some("cover-image"));
        assert_eq!(inputs.manifest.len(), 2);
        let cover = inputs.manifest.get("cover-image").expect("cover entry");
        assert_eq!(cover.href, "images/cover.jpg");
        assert_eq!(cover.media_type, "image/jpeg");
        assert_eq!(cover.properties, "cover-image");
        let p = resolve_cover_path(&inputs.manifest, &inputs.cover_id, "OEBPS/content.opf")
            .expect("cover resolves");
        assert_eq!(p, "OEBPS/images/cover.jpg");
    }

    #[test]
    fn locate_toc_sources_handles_expanded_item_tags() {
        // Same serialisation quirk as #5455 on the open hot path: nav / ncx
        // discovery walks the manifest too, so expanded `<item></item>`
        // entries must still yield the nav document and the NCX.
        let xml = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"></item>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"></item>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"></item>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"></itemref>
  </spine>
</package>"#;
        let located = locate_toc_sources(xml).expect("opf parses");
        assert_eq!(located.nav_href.as_deref(), Some("nav.xhtml"));
        assert_eq!(located.ncx_href.as_deref(), Some("toc.ncx"));
    }

    #[test]
    fn locate_toc_sources_handles_self_closing_manifest() {
        // Degenerate but valid: an empty self-closing `<manifest/>` must not
        // leave the scan believing it is still inside a manifest (which would
        // let later stray `<item>` elements leak in).
        let xml = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest/>
  <spine/>
</package>"#;
        let located = locate_toc_sources(xml).expect("opf parses");
        assert!(located.nav_href.is_none());
        assert!(located.ncx_href.is_none());
    }

    #[test]
    fn cover_resolution_prefers_epub3_properties() {
        let mut manifest = HashMap::new();
        manifest.insert(
            "img1".into(),
            ManifestItem {
                href: "img/foo.jpg".into(),
                media_type: "image/jpeg".into(),
                properties: "cover-image".into(),
            },
        );
        manifest.insert(
            "img2".into(),
            ManifestItem {
                href: "img/bar.jpg".into(),
                media_type: "image/jpeg".into(),
                properties: String::new(),
            },
        );
        let p = resolve_cover_path(&manifest, &None, "OEBPS/content.opf").unwrap();
        assert_eq!(p, "OEBPS/img/foo.jpg");
    }

    #[test]
    fn cover_resolution_falls_back_to_meta_cover() {
        let mut manifest = HashMap::new();
        manifest.insert(
            "cov".into(),
            ManifestItem {
                href: "images/c.png".into(),
                media_type: "image/png".into(),
                properties: String::new(),
            },
        );
        manifest.insert(
            "other".into(),
            ManifestItem {
                href: "images/o.png".into(),
                media_type: "image/png".into(),
                properties: String::new(),
            },
        );
        let p = resolve_cover_path(&manifest, &Some("cov".into()), "content.opf").unwrap();
        assert_eq!(p, "images/c.png");
    }

    #[test]
    fn cover_heuristic_skips_svg_when_raster_available() {
        // Without `properties=cover-image` and without `<meta name=cover>`, an
        // SVG sitting next to a JPEG must NOT be picked: SVGs in EPUBs are
        // typically the cover *page* (a wrapper xhtml/svg), not the actual
        // cover image.
        let mut manifest = HashMap::new();
        manifest.insert(
            "cov-svg".into(),
            ManifestItem {
                href: "images/cover.svg".into(),
                media_type: "image/svg+xml".into(),
                properties: String::new(),
            },
        );
        manifest.insert(
            "cov-jpg".into(),
            ManifestItem {
                href: "images/cover.jpg".into(),
                media_type: "image/jpeg".into(),
                properties: String::new(),
            },
        );
        let p = resolve_cover_path(&manifest, &None, "OEBPS/content.opf").unwrap();
        assert_eq!(p, "OEBPS/images/cover.jpg");
    }

    #[test]
    fn cover_heuristic_falls_back_to_svg_when_only_svg_present() {
        // Edge-case EPUBs that ship only an SVG cover must still resolve a
        // cover path — pass-2 of the heuristic re-runs with SVG allowed.
        let mut manifest = HashMap::new();
        manifest.insert(
            "cov-svg".into(),
            ManifestItem {
                href: "images/cover.svg".into(),
                media_type: "image/svg+xml".into(),
                properties: String::new(),
            },
        );
        manifest.insert(
            "ch1".into(),
            ManifestItem {
                href: "text/ch1.xhtml".into(),
                media_type: "application/xhtml+xml".into(),
                properties: String::new(),
            },
        );
        let p = resolve_cover_path(&manifest, &None, "OEBPS/content.opf").unwrap();
        assert_eq!(p, "OEBPS/images/cover.svg");
    }

    #[test]
    fn cover_heuristic_skips_items_with_nav_property() {
        // Defensive: even though `nav` belongs on xhtml per spec, properties
        // is a token list and we never want to pick a nav-tagged item as a
        // cover. The non-nav image must win.
        let mut manifest = HashMap::new();
        manifest.insert(
            "weird-nav".into(),
            ManifestItem {
                href: "images/cover.jpg".into(),
                media_type: "image/jpeg".into(),
                properties: "nav".into(),
            },
        );
        manifest.insert(
            "real".into(),
            ManifestItem {
                href: "images/other.jpg".into(),
                media_type: "image/jpeg".into(),
                properties: String::new(),
            },
        );
        let p = resolve_cover_path(&manifest, &None, "OEBPS/content.opf").unwrap();
        assert_eq!(p, "OEBPS/images/other.jpg");
    }

    #[test]
    fn undeclared_cover_matches_cover_named_entries() {
        // Names the JS-side `UNDECLARED_COVER_RE` matches too.
        assert!(is_undeclared_cover_name("cover.jpg"));
        assert!(is_undeclared_cover_name("OEBPS/images/Cover.PNG"));
        assert!(is_undeclared_cover_name("couv.jpeg"));
        assert!(is_undeclared_cover_name("book-cover.webp"));
        assert!(is_undeclared_cover_name("cover.svg"));
        // ...and names it doesn't: unrelated images, non-images, and stems
        // that merely start with "cover".
        assert!(!is_undeclared_cover_name("images/rat.jpg"));
        assert!(!is_undeclared_cover_name("cover.xhtml"));
        assert!(!is_undeclared_cover_name("covers.jpg"));
        assert!(!is_undeclared_cover_name("cover"));
    }

    #[test]
    fn undeclared_cover_picks_first_matching_zip_entry() {
        use std::io::Write;
        let build = |names: &[&str]| {
            let mut buf = Vec::<u8>::new();
            {
                let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
                let opts = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored);
                for name in names {
                    w.start_file(*name, opts).unwrap();
                    w.write_all(b"x").unwrap();
                }
                w.finish().unwrap();
            }
            ZipArchive::new(Cursor::new(buf)).unwrap()
        };

        let zip = build(&["mimetype", "start.xhtml", "cover.jpg", "back-cover.jpg"]);
        assert_eq!(
            find_undeclared_cover_entry(&zip),
            Some("cover.jpg".to_string())
        );

        let zip = build(&["mimetype", "images/rat.jpg"]);
        assert_eq!(find_undeclared_cover_entry(&zip), None);
    }

    #[test]
    fn normalize_zip_path_strips_dotdot() {
        assert_eq!(normalize_zip_path("OEBPS/../images/x.png"), "images/x.png");
        assert_eq!(normalize_zip_path("OEBPS/./x.png"), "OEBPS/x.png");
        assert_eq!(normalize_zip_path("a//b/c"), "a/b/c");
    }

    #[test]
    fn resolve_relative_handles_query_and_fragment() {
        let p = resolve_relative("OEBPS/content.opf", "images/c.png?foo=1#bar");
        assert_eq!(p, "OEBPS/images/c.png");
    }

    #[test]
    fn guess_image_mime_known_types() {
        assert_eq!(guess_image_mime("a.PNG"), "image/png");
        assert_eq!(guess_image_mime("a.jpg"), "image/jpeg");
        assert_eq!(guess_image_mime("a.JPEG"), "image/jpeg");
        assert_eq!(guess_image_mime("a.webp"), "image/webp");
        assert_eq!(guess_image_mime("a.gif"), "image/gif");
        assert_eq!(guess_image_mime("a.svg"), "image/svg+xml");
        assert_eq!(guess_image_mime("a"), "image/jpeg");
    }

    #[test]
    fn local_name_strips_namespace() {
        assert_eq!(local_name(b"dc:title"), b"title");
        assert_eq!(local_name(b"title"), b"title");
        assert_eq!(local_name(b"a:b:c"), b"c");
    }

    #[test]
    fn partial_md5_short_file_matches_js_reference() {
        // For a tiny 11-byte file the JS reference behaves as follows:
        //   i = -1: rawShift = 1024 << -2 -> 1024 << 30 (JS masks operand
        //           to 5 bits, then truncates to i32, yielding 0)
        //           start = min(11, 0) = 0, end = min(1024, 11) = 11 -> read
        //   i = 0:  rawShift = 1024, start = min(11, 1024) = 11 -> break
        // So the resulting hash is md5("hello world").
        let dir = std::env::temp_dir();
        let path = dir.join("readest-epub-parser-test.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let hash = compute_partial_md5(&path).unwrap();
        // Pre-computed: md5("hello world") = 5eb63bbbe01eeed093cb22bb8f5acdc3
        assert_eq!(hash, "5eb63bbbe01eeed093cb22bb8f5acdc3");
        let _ = std::fs::remove_file(path);
    }

    fn make_test_png(width: u32, height: u32) -> Vec<u8> {
        // Build a tiny in-memory PNG with a 2x2 checker pattern, then scale
        // up via image::DynamicImage to get the requested size. This avoids
        // pulling extra fixture files into the repo.
        let mut img = image::RgbImage::new(width, height);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let on = ((x / 4) + (y / 4)) % 2 == 0;
            *px = if on {
                image::Rgb([200, 50, 50])
            } else {
                image::Rgb([20, 20, 200])
            };
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn maybe_resize_cover_keeps_small_image_unchanged() {
        // 256x256 < 512: no decode/re-encode, byte-identical, MIME passthrough.
        let png = make_test_png(256, 256);
        let original = png.clone();
        let (out, mime) = maybe_resize_cover(png, "image/png");
        assert_eq!(out, original, "small images must be returned verbatim");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn maybe_resize_cover_keeps_image_at_threshold() {
        // 512x512 == threshold: still passes through.
        let png = make_test_png(512, 512);
        let original = png.clone();
        let (out, mime) = maybe_resize_cover(png, "image/jpeg");
        assert_eq!(out, original);
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn maybe_resize_cover_downscales_large_image() {
        // 1500x1000: long edge 1500 -> 512, short edge proportional.
        // After encoding we re-decode to assert the dimensions and MIME.
        let png = make_test_png(1500, 1000);
        let (out, mime) = maybe_resize_cover(png, "image/png");
        assert_eq!(mime, "image/jpeg");
        let decoded = image::load_from_memory(&out).expect("re-decodes");
        let (w, h) = decoded.dimensions();
        assert!(w <= COVER_MAX_LONG_EDGE && h <= COVER_MAX_LONG_EDGE);
        assert!(
            w == COVER_MAX_LONG_EDGE || h == COVER_MAX_LONG_EDGE,
            "long edge should hit 512 exactly, got ({w},{h})"
        );
        // Aspect ratio (3:2) should be preserved within rounding tolerance.
        let ratio = w as f64 / h as f64;
        assert!((ratio - 1.5).abs() < 0.02, "aspect ratio drifted: {ratio}");
        // Re-encoded JPEG should be drastically smaller than the source PNG.
        assert!(
            out.len() < 200 * 1024,
            "expected <200 KiB, got {}",
            out.len()
        );
    }

    #[test]
    fn maybe_resize_cover_preserves_aspect_for_tall_image() {
        // 800x2000 (aspect 0.4): tall edge -> 512, width ~205.
        let png = make_test_png(800, 2000);
        let (out, mime) = maybe_resize_cover(png, "image/png");
        assert_eq!(mime, "image/jpeg");
        let (w, h) = image::load_from_memory(&out).unwrap().dimensions();
        assert_eq!(h, COVER_MAX_LONG_EDGE);
        assert!(w < h, "tall image should stay tall");
        let ratio = w as f64 / h as f64;
        assert!((ratio - 0.4).abs() < 0.02, "aspect drifted: {ratio}");
    }

    #[test]
    fn maybe_resize_cover_returns_input_on_decode_failure() {
        // Garbage bytes are not a valid image; we should fall back to the
        // original blob + the caller-supplied MIME rather than panic.
        let junk = b"not an image".to_vec();
        let (out, mime) = maybe_resize_cover(junk.clone(), "image/png");
        assert_eq!(out, junk);
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn strip_xml_bom_handles_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"<root/>");
        let stripped = strip_xml_bom(&bytes);
        assert_eq!(stripped.as_ref(), b"<root/>");
    }

    #[test]
    fn strip_xml_bom_passthrough_when_no_bom() {
        let bytes = b"<root/>";
        let stripped = strip_xml_bom(bytes);
        // Cow::Borrowed → no allocation, same pointer.
        assert!(matches!(stripped, Cow::Borrowed(_)));
        assert_eq!(stripped.as_ref(), b"<root/>");
    }

    #[test]
    fn strip_xml_bom_decodes_utf16_le() {
        // "<a/>" in UTF-16 little-endian, with FF FE BOM.
        let mut bytes = vec![0xFF, 0xFE];
        for ch in "<a/>".encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let stripped = strip_xml_bom(&bytes);
        assert_eq!(stripped.as_ref(), b"<a/>");
    }

    #[test]
    fn strip_xml_bom_decodes_utf16_be() {
        // "<a/>" in UTF-16 big-endian, with FE FF BOM.
        let mut bytes = vec![0xFE, 0xFF];
        for ch in "<a/>".encode_utf16() {
            bytes.extend_from_slice(&ch.to_be_bytes());
        }
        let stripped = strip_xml_bom(&bytes);
        assert_eq!(stripped.as_ref(), b"<a/>");
    }

    #[test]
    fn parse_opf_cover_inputs_tolerates_utf8_bom() {
        // Real-world EPUBs from some Windows toolchains ship the OPF with a
        // UTF-8 BOM; without strip_xml_bom quick-xml emits a stray Text
        // event before the prolog and downstream parsing fails. Smoke
        // test: parse must succeed and recover the manifest cover entry.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>BOM Book</dc:title>
    <meta name="cover" content="cv"/>
  </metadata>
  <manifest>
    <item id="cv" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
</package>"#,
        );
        let inputs = parse_opf_cover_inputs(&bytes).expect("opf parses through BOM");
        assert_eq!(inputs.cover_id.as_deref(), Some("cv"));
        assert!(inputs.manifest.contains_key("cv"));
    }

    #[test]
    fn read_zip_entry_falls_back_to_percent_decoded_name() {
        use std::io::Write;
        // Build an in-memory zip whose entry name is the *decoded* form
        // ("a b.txt"), then ask read_zip_entry for the *encoded* form
        // ("a%20b.txt"). The fallback path must locate the entry.
        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("a b.txt", opts).unwrap();
            w.write_all(b"hello").unwrap();
            w.finish().unwrap();
        }
        let mut zip = ZipArchive::new(Cursor::new(buf)).unwrap();
        let bytes = read_zip_entry(&mut zip, "a%20b.txt").expect("falls back to decoded");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn read_zip_entry_returns_error_when_not_found_either_way() {
        use std::io::Write;
        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("real.txt", opts).unwrap();
            w.write_all(b"hi").unwrap();
            w.finish().unwrap();
        }
        let mut zip = ZipArchive::new(Cursor::new(buf)).unwrap();
        assert!(read_zip_entry(&mut zip, "missing.txt").is_err());
    }

    #[test]
    fn partial_md5_medium_file_uses_step_windows() {
        // For a >2 KiB file the i = 0 iteration reads bytes [1024..2048],
        // and (assuming the file is shorter than 16 KiB) i = 2 sees
        // start=16384 >= file.size and breaks. Verify Rust matches that.
        let dir = std::env::temp_dir();
        let path = dir.join("readest-epub-parser-test-medium.bin");
        let mut data = Vec::with_capacity(2048);
        for i in 0..2048u32 {
            data.push((i & 0xff) as u8);
        }
        std::fs::write(&path, &data).unwrap();
        let hash = compute_partial_md5(&path).unwrap();
        // i=-1 -> shift=30, 1024 << 30 (i32 overflow -> negative) -> we treat
        //          as 0; start=0, read [0..1024).
        // i=0 -> shift=0, start=1024, read [1024..2048).
        // i=1 -> shift=2, start=4096 >= 2048, break.
        let mut expected = Md5::new();
        expected.update(&data[0..1024]);
        expected.update(&data[1024..2048]);
        let expected_hash = format!("{:x}", expected.finalize());
        assert_eq!(hash, expected_hash);
        // Cross-validated against `node` running the JS reference algorithm
        // on the identical buffer: ranges = [[0,1024],[1024,2048]],
        // md5 = 1576a94d6cb334dd126cb1c27f19e0f2.
        assert_eq!(hash, "1576a94d6cb334dd126cb1c27f19e0f2");
        let _ = std::fs::remove_file(path);
    }

    // ------------------------------------------------------------------
    // Spine / TOC / 正文规模 — 版本对比弹窗的结构级事实
    // ------------------------------------------------------------------

    const SPINE_OPF: &[u8] = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="plate" href="images/plate.svg" media-type="image/svg+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="plate"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>"#;

    #[test]
    fn parse_opf_spine_keeps_reading_order_and_skips_non_linear_and_media() {
        let spine = parse_opf_spine(SPINE_OPF);
        // 只有 linear 的 XHTML 文档算正文：非线性的 notes 与 SVG plate 都要剔除，
        // 否则"正文被切成几份"这个数字两侧就对不上。
        let hrefs: Vec<&str> = spine.docs.iter().map(|d| d.href.as_str()).collect();
        assert_eq!(hrefs, vec!["text/ch1.xhtml", "text/ch2.xhtml"]);
        assert_eq!(spine.nav_href.as_deref(), Some("nav.xhtml"));
        assert_eq!(spine.ncx_href.as_deref(), Some("toc.ncx"));
    }

    #[test]
    fn parse_nav_toc_reads_labels_and_depth() {
        // 中文标签只能走 &str，byte string 字面量不接受非 ASCII。
        let nav = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="landmarks"><ol><li><a href="text/ch1.xhtml">Start</a></li></ol></nav>
    <nav epub:type="toc">
      <ol>
        <li><a href="text/ch1.xhtml">第一章 起点</a>
          <ol><li><a href="text/ch1.xhtml#s1">第一节</a></li></ol>
        </li>
        <li><a href="text/ch2.xhtml">第二章</a></li>
      </ol>
    </nav>
  </body>
</html>"#;
        let entries = parse_nav_toc(nav.as_bytes());
        let labels: Vec<&str> = entries.iter().map(|e| e.label.as_str()).collect();
        // landmarks 不是目录，不能混进来。
        assert_eq!(labels, vec!["第一章 起点", "第一节", "第二章"]);
        let depths: Vec<usize> = entries.iter().map(|e| e.depth).collect();
        assert_eq!(depths, vec![0, 1, 0]);
    }

    #[test]
    fn parse_ncx_toc_reads_labels_and_depth() {
        let ncx = br#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/>
      <navPoint id="n1-1"><navLabel><text>Section A</text></navLabel><content src="ch1.xhtml#a"/></navPoint>
    </navPoint>
    <navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>"#;
        let entries = parse_ncx_toc(ncx);
        let labels: Vec<&str> = entries.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, vec!["Chapter One", "Section A", "Chapter Two"]);
        let depths: Vec<usize> = entries.iter().map(|e| e.depth).collect();
        assert_eq!(depths, vec![0, 1, 0]);
    }

    #[test]
    fn count_non_whitespace_text_ignores_markup_scripts_and_entities() {
        let html = "<html><head><title>T</title><style>p{color:red}</style>\
<script>var x = 1 &amp; 2;</script></head>\
<body><!-- 注释里的字不算 --><p>Hello &amp; 世界</p><p>   </p></body></html>";
        // 正文只有 "Hello & 世界"：Hello(5) + &(1) + 世界(2) = 8。标题/样式/
        // 脚本/注释一律不计，实体引用按一个字符算。
        assert_eq!(count_non_whitespace_text(html), 8);
    }

    #[test]
    fn count_non_whitespace_text_does_not_mistake_header_for_head() {
        // 按标签名比对：`<header>` 与 `<head` 前缀相同，前缀匹配会从 `<header>`
        // 一路跳到 `</head`，把夹在中间的真实正文吞掉。
        let html = "<header>甲</header><head><title>T</title></head>乙";
        assert_eq!(count_non_whitespace_text(html), 2);
    }

    #[test]
    fn count_non_whitespace_text_handles_quoted_angle_brackets_in_attributes() {
        // 属性值里的 '>' 不是标签结束，按引号状态跳过的实现必须认出来。
        assert_eq!(
            count_non_whitespace_text(r#"<img alt="a > b" src="x.png"/>ab"#),
            2
        );
    }

    #[test]
    fn parse_epub_metadata_reports_text_length_and_toc() {
        // 端到端：合成一个最小 EPUB，确认导入路径顺带带回了字数、章节数与目录，
        // 且目录数（2 个 navPoint）优先于"正文文档数"这个退路。
        use std::io::Write;
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>"#;
        let ncx = br#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>One</text></navLabel><content src="ch1.xhtml"/></navPoint>
  <navPoint id="n2"><navLabel><text>Two</text></navLabel><content src="ch1.xhtml#x"/></navPoint>
</navMap></ncx>"#;
        let container = br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
        let ch1 = "<html><body><p>一二三</p><p>abcd ef</p></body></html>";

        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in [
                ("META-INF/container.xml", container.to_vec()),
                ("OEBPS/content.opf", opf.to_vec()),
                ("OEBPS/toc.ncx", ncx.to_vec()),
                ("OEBPS/ch1.xhtml", ch1.as_bytes().to_vec()),
            ] {
                w.start_file(name, opts).expect("start");
                w.write_all(&body).expect("write");
            }
            w.finish().expect("finish");
        }
        let dir = std::env::temp_dir();
        let path = dir.join(format!("readest-epub-measure-{}.epub", std::process::id()));
        std::fs::write(&path, &buf).expect("write epub");

        let parsed = parse_epub_metadata_sync(&path).expect("parses");

        // 一二三(3) + abcd(4) + ef(2) = 9 个非空白字符。
        assert_eq!(parsed.text_length, Some(9));
        assert_eq!(parsed.section_count, Some(2));
        assert_eq!(
            parsed
                .toc
                .iter()
                .map(|e| e.label.as_str())
                .collect::<Vec<_>>(),
            vec!["One", "Two"]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parse_epub_metadata_excludes_the_nav_document_and_tolerates_a_bom() {
        // EPUB3 允许把 nav.xhtml 列进 spine，它是目录页不是正文；UTF-8 BOM 也不该
        // 多算一个字符。正文只有"一二三"3 个非空白字符。
        use std::io::Write;
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="nav"/><itemref idref="ch1"/></spine>
</package>"#;
        let container = br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
        let nav = r#"<html><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">目录里的一长串字</a></li></ol></nav></body></html>"#;
        let mut ch1 = vec![0xEFu8, 0xBB, 0xBF];
        ch1.extend_from_slice("<html><body><p>一二三</p></body></html>".as_bytes());

        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in [
                ("META-INF/container.xml", container.to_vec()),
                ("content.opf", opf.to_vec()),
                ("nav.xhtml", nav.as_bytes().to_vec()),
                ("ch1.xhtml", ch1),
            ] {
                w.start_file(name, opts).expect("start");
                w.write_all(&body).expect("write");
            }
            w.finish().expect("finish");
        }
        let dir = std::env::temp_dir();
        let path = dir.join(format!("readest-epub-nav-bom-{}.epub", std::process::id()));
        std::fs::write(&path, &buf).expect("write epub");

        let parsed = parse_epub_metadata_sync(&path).expect("parses");

        assert_eq!(parsed.text_length, Some(3));
        // 这个用例有可用目录，section_count 走的是"目录条目数"那一支（下面一行）。
        assert_eq!(parsed.toc.len(), 1);
        assert_eq!(parsed.section_count, Some(1));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parse_epub_metadata_section_fallback_excludes_the_nav_document() {
        // nav 列进 spine、但里面没有可用的目录条目（这里只有 landmarks）→ 目录为
        // 空 → section_count 退回"算过字数的文档数"。这一步必须排除 nav，否则
        // "正文被切成几份"会被目录页顶多一份。此前用 spine.docs.len() 时这里是 3。
        use std::io::Write;
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="nav"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>"#;
        let container = br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
        // 只有 landmarks：不是目录，parse_nav_toc 一个条目都不产出。
        let nav = r#"<html><body><nav epub:type="landmarks"><ol><li><a href="ch1.xhtml">正文</a></li></ol></nav></body></html>"#;

        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in [
                ("META-INF/container.xml", container.to_vec()),
                ("content.opf", opf.to_vec()),
                ("nav.xhtml", nav.as_bytes().to_vec()),
                (
                    "ch1.xhtml",
                    "<html><body><p>一二三</p></body></html>"
                        .as_bytes()
                        .to_vec(),
                ),
                (
                    "ch2.xhtml",
                    "<html><body><p>四五</p></body></html>".as_bytes().to_vec(),
                ),
            ] {
                w.start_file(name, opts).expect("start");
                w.write_all(&body).expect("write");
            }
            w.finish().expect("finish");
        }
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "readest-epub-nav-fallback-{}.epub",
            std::process::id()
        ));
        std::fs::write(&path, &buf).expect("write epub");

        let parsed = parse_epub_metadata_sync(&path).expect("parses");

        assert!(parsed.toc.is_empty());
        // 正文只有 ch1 的"一二三"与 ch2 的"四五"，nav 的链接文字与它本身都不计入。
        assert_eq!(parsed.text_length, Some(5));
        assert_eq!(parsed.section_count, Some(2));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parse_epub_metadata_survives_an_epub_without_any_text_document() {
        // 退化文件不能把导入打挂：没有正文时就报 None（弹窗显示"未记录"），
        // 但封面/哈希这些必需字段照旧返回。
        use std::io::Write;
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="cover" href="c.jpg" media-type="image/jpeg"/></manifest>
  <spine/>
</package>"#;
        let container = br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
        let mut buf = Vec::<u8>::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in [
                ("META-INF/container.xml", container.to_vec()),
                ("content.opf", opf.to_vec()),
            ] {
                w.start_file(name, opts).expect("start");
                w.write_all(&body).expect("write");
            }
            w.finish().expect("finish");
        }
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "readest-epub-degenerate-{}.epub",
            std::process::id()
        ));
        std::fs::write(&path, &buf).expect("write epub");

        let parsed = parse_epub_metadata_sync(&path).expect("parses");
        assert_eq!(parsed.text_length, None);
        assert_eq!(parsed.section_count, None);
        assert!(parsed.toc.is_empty());
        assert!(!parsed.partial_md5.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
