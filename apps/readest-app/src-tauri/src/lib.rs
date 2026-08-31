#[cfg(target_os = "macos")]
#[macro_use]
extern crate cocoa;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

#[cfg(target_os = "windows")]
mod windows;

use tauri::utils::config::BackgroundThrottlingPolicy;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

#[cfg(desktop)]
use tauri::{Listener, Url};
mod dir_scanner;
mod epub_parser;
mod library_lock;
#[cfg(target_os = "macos")]
mod macos;
mod mobi_parser;
mod parser_common;
mod range_file;
#[cfg(desktop)]
mod window_state;
#[cfg(target_os = "windows")]
use tauri::webview::ScrollBarStyle;
use tauri::{command, Emitter, WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
fn allow_file_in_scopes(app: &AppHandle, files: Vec<PathBuf>) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    for file in &files {
        if let Err(e) = fs_scope.allow_file(file) {
            log::error!("Failed to allow file in fs_scope: {e}");
        } else {
            log::debug!("Allowed file in fs_scope: {file:?}");
        }
        if let Err(e) = asset_protocol_scope.allow_file(file) {
            log::error!("Failed to allow file in asset_protocol_scope: {e}");
        } else {
            log::debug!("Allowed file in asset_protocol_scope: {file:?}");
        }
    }
}

fn allow_dir_in_scopes(app: &AppHandle, dir: &PathBuf) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    if let Err(e) = fs_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in fs_scope: {e}");
    } else {
        log::info!("Allowed directory in fs_scope: {dir:?}");
    }
    if let Err(e) = asset_protocol_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in asset_protocol_scope: {e}");
    } else {
        log::info!("Allowed directory in asset_protocol_scope: {dir:?}");
    }
}

/// Frontend-callable shim around [`allow_file_in_scopes`] /
/// [`allow_dir_in_scopes`]. Used after dialog-based file/folder pickers
/// because the Tauri `dialog` plugin only auto-grants `fs_scope`, not
/// `asset_protocol_scope` — and our importer relies on the asset
/// protocol (`RemoteFile`) to read user-selected files. Without this,
/// importing a book from e.g. `~/Downloads/...` fails with
/// "asset protocol not configured to allow the path".
///
/// Granted scopes are persisted across app restarts thanks to
/// `tauri_plugin_persisted_scope`, so re-picking the same file isn't
/// required after the first allow call.
///
/// Security:
///
///   - On desktop, this command refuses to extend `asset_protocol_scope`
///     for any path that is not already allowed in `fs_scope`. The
///     `fs_scope` there is populated only by the Tauri `dialog` plugin
///     (when the user picks through the OS picker) or by
///     `tauri_plugin_persisted_scope` (which restores prior dialog
///     grants on startup). That gate constrains the command to
///     user-selected paths only — otherwise any frontend code
///     (including a future XSS via book content, OPDS HTML, dictionary
///     lookups, or a compromised dependency) could invoke it with an
///     arbitrary path like `/` or `~/.ssh` and gain persistent read
///     access to the entire user home directory via the asset
///     protocol.
#[command]
fn allow_paths_in_scopes(_app: AppHandle, _paths: Vec<String>, _is_directory: bool) {
    #[cfg(desktop)]
    {
        let fs_scope = _app.fs_scope();
        for raw in _paths {
            if raw.is_empty() {
                continue;
            }
            let path = PathBuf::from(&raw);
            if !fs_scope.is_allowed(&path) {
                log::warn!("allow_paths_in_scopes refused (path not in fs_scope): {path:?}");
                continue;
            }
            if _is_directory {
                allow_dir_in_scopes(&_app, &path);
            } else {
                allow_file_in_scopes(&_app, vec![path]);
            }
        }
    }
}

#[cfg(desktop)]
fn get_files_from_argv(argv: Vec<String>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    // NOTICE: `args` may include URL protocol (`your-app-protocol://`)
    // or arguments (`--`) if your app supports them.
    // files may also be passed as `file://path/to/file`
    for (_, maybe_file) in argv.iter().enumerate().skip(1) {
        // skip flags like -f or --flag
        if maybe_file.starts_with("-") {
            continue;
        }
        // handle `file://` path urls and skip other urls
        if let Ok(url) = Url::parse(maybe_file) {
            if let Ok(path) = url.to_file_path() {
                files.push(path);
            } else {
                files.push(PathBuf::from(maybe_file))
            }
        } else {
            files.push(PathBuf::from(maybe_file))
        }
    }
    files
}

#[cfg(desktop)]
fn set_window_open_with_files(app: &AppHandle, files: Vec<PathBuf>) {
    let files = files
        .into_iter()
        .map(|f| {
            let file = f
                .to_string_lossy()
                .replace("\\", "\\\\")
                .replace("\"", "\\\"");
            format!("\"{file}\"",)
        })
        .collect::<Vec<_>>()
        .join(",");
    if let Some(window) = app.get_webview_window("main") {
        let script = format!("window.OPEN_WITH_FILES = [{files}];");
        if let Err(e) = window.eval(&script) {
            eprintln!("Failed to set open files variable: {e}");
        }
    }
}

#[tauri::command]
fn get_environment_variable(name: &str) -> String {
    // S-4: 只暴露应用实际消费的变量（Gamescope 检测），拒绝任意 env 可读面。
    const ALLOWED: [&str; 2] = ["GAMESCOPE_WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP"];
    if !ALLOWED.contains(&name) {
        return String::new();
    }
    std::env::var(name).unwrap_or_default()
}

#[tauri::command]
fn get_executable_dir() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[derive(Clone, serde::Serialize)]
#[allow(dead_code)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("tantivy", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_environment_variable,
            get_executable_dir,
            allow_paths_in_scopes,
            dir_scanner::read_dir,
            epub_parser::parse_epub_metadata,
            epub_parser::extract_epub_cover_full,
            epub_parser::parse_epub_full,
            mobi_parser::parse_mobi_metadata,
            mobi_parser::extract_mobi_cover_full,
            library_lock::acquire_library_lock,
            library_lock::release_library_lock,
            #[cfg(target_os = "macos")]
            macos::traffic_light::set_traffic_lights,
            #[cfg(target_os = "macos")]
            macos::system_dictionary::show_lookup_popover,
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_device_info::init())
        .plugin(tauri_plugin_turso::init())
        .plugin(tauri_plugin_native_bridge::init())
        .plugin(tauri_plugin_native_tts::init())
        .plugin(tauri_plugin_webview_upgrade::init())
        // Serves local file byte-ranges to `RemoteFile` via `?path=&start=&end=`
        // (range-in-URL, not a `Range` header) so Android's WebView doesn't
        // re-apply the offset. Scope-gated by `asset_protocol_scope`.
        .register_asynchronous_uri_scheme_protocol(range_file::SCHEME, range_file::handle);

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .callback(move |app, argv, cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                let files = get_files_from_argv(argv.clone());
                if !files.is_empty() {
                    allow_file_in_scopes(app, files.clone());
                }
                app.emit("single-instance", SingleInstancePayload { args: argv, cwd })
                    .unwrap();
            })
            .dbus_id("com.bilingify.readest".to_owned())
            .build(),
    );

    // Strip invalid geometry from the saved window state before the
    // window-state plugin loads it, so a bad `.window-state.json` (e.g. the
    // Windows minimized `-32000` sentinel) can't crash WebView2 on launch.
    // See https://github.com/readest/readest/issues/4398.
    #[cfg(desktop)]
    let builder = builder.plugin(window_state::init());

    // Map every reader window onto a single "reader" state key so all book
    // windows share one remembered size/position — opening a second book no
    // longer restores a stale per-label size that differs from the first.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .map_label(|label| {
                if label.starts_with("reader") {
                    "reader"
                } else {
                    label
                }
            })
            .build(),
    );

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos::traffic_light::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos::window::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .setup(|#[allow(unused_variables)] app| {
            // When running with the webdriver feature (E2E/integration tests),
            // grant all default permissions to remote URLs (http://127.0.0.1:*)
            // so that Vitest browser-mode tests can call plugin commands.
            #[cfg(feature = "webdriver")]
            {
                use tauri::Manager;
                app.add_capability(include_str!("../capabilities-extra/webdriver.json"))?;
            }
            #[cfg(desktop)]
            {
                let files = get_files_from_argv(std::env::args().collect());
                if !files.is_empty() {
                    let app_handle = app.handle().clone();
                    allow_file_in_scopes(&app_handle, files.clone());
                    app.listen("window-ready", move |_| {
                        println!("Window is ready, proceeding to handle files.");
                        set_window_open_with_files(&app_handle, files.clone());
                    });
                }
            }

            #[cfg(desktop)]
            {
                allow_dir_in_scopes(app.handle(), &PathBuf::from(get_executable_dir()));
            }

            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_cli::init())?;
            }

            let is_eink = false;

            let cli_access = true;

            #[cfg(target_os = "linux")]
            let is_appimage = std::env::var("APPIMAGE").is_ok()
                || std::env::current_exe()
                    .map(|path| path.to_string_lossy().contains("/tmp/.mount_"))
                    .unwrap_or(false);
            #[cfg(not(target_os = "linux"))]
            let is_appimage = false;

            let init_script = format!(
                r#"
                    if ({is_eink}) window.__READEST_IS_EINK = true;
                    if ({cli_access}) window.__READEST_CLI_ACCESS = true;
                    if ({is_appimage}) window.__READEST_IS_APPIMAGE = true;
                    window.addEventListener('DOMContentLoaded', function() {{
                        document.documentElement.classList.add('edge-to-edge');
                        const isTauriLocal = window.location.protocol === 'tauri:' ||
                                            window.location.protocol === 'about:' ||
                                            window.location.hostname === 'tauri.localhost';
                        const needsSafeArea = !isTauriLocal;
                        if (needsSafeArea && !document.getElementById('safe-area-style')) {{
                            const style = document.createElement('style');
                            style.id = 'safe-area-style';
                            style.textContent = `
                                body {{
                                    padding-top: env(safe-area-inset-top) !important;
                                    padding-bottom: env(safe-area-inset-bottom) !important;
                                    padding-left: env(safe-area-inset-left) !important;
                                    padding-right: env(safe-area-inset-right) !important;
                                }}
                            `;
                            document.head.appendChild(style);
                        }}
                    }});
                "#,
                is_eink = is_eink,
                cli_access = cli_access,
                is_appimage = is_appimage,
            );

            let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .background_color(if is_eink {
                    tauri::window::Color(255, 255, 255, 255)
                } else {
                    tauri::window::Color(50, 49, 48, 255)
                })
                .initialization_script(&init_script);

            #[cfg(target_os = "macos")]
            let win_builder = win_builder.inner_size(1280.0, 800.0).resizable(true);
            #[cfg(all(not(target_os = "macos"), desktop))]
            let win_builder = win_builder.inner_size(800.0, 600.0).resizable(true);

            // The overlay title bar draws its title over the app's own header,
            // so `macos::window::init()` hides the title text and the window
            // can carry a real name for the Window menu and VoiceOver.
            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .decorations(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .title("Readest");

            #[cfg(all(not(target_os = "macos"), desktop))]
            let win_builder = {
                let mut builder = win_builder
                    .decorations(false)
                    .visible(false)
                    .shadow(true)
                    .title("Readest");

                #[cfg(target_os = "windows")]
                {
                    builder = builder
                        .transparent(false)
                        .scroll_bar_style(ScrollBarStyle::FluentOverlay);
                }
                #[cfg(target_os = "linux")]
                {
                    // Keep the window opaque on Linux. A transparent WebKitGTK
                    // window (previously used to draw rounded corners, #1982)
                    // composites as fully transparent whenever its web process is
                    // too busy to repaint damaged regions (e.g. during a library
                    // backup), so the app "turns invisible" on any interaction
                    // (#3682). An opaque window instead retains its last painted
                    // frame, at the cost of square corners.
                    builder = builder.transparent(false);
                }

                builder
            };

            #[cfg(not(target_os = "macos"))]
            {
                win_builder.build().unwrap();
            }
            // let win = win_builder.build().unwrap();
            // win.open_devtools();

            #[cfg(target_os = "macos")]
            {
                let window = win_builder.build().unwrap();
                // On macOS, closing a window (via Cmd+W or the red traffic light)
                // should not quit the app — only Cmd+Q should — and normally hides
                // instead of minimizing (#5240): the app keeps running in the dock
                // and the window is restored when the user reopens the app from the
                // dock. On Tahoe the hide is defensive against the `orderOut:`
                // phantom-window regression (#4875); see
                // `macos::window::hide_main_window` for the fullscreen-failure
                // fallback.
                let window_for_close = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        macos::window::hide_main_window(&window_for_close);
                    }
                    // Safety net for JS-side `show()` callers (e.g.
                    // `ensureMainLibraryWindow` in src/utils/nav.ts re-shows a hidden
                    // main window from a reader window without a dock Reopen): the
                    // window can only become key after it is back on screen, so any
                    // pending defensively-zeroed frame must be restored by now.
                    tauri::WindowEvent::Focused(true) => {
                        macos::window::restore_main_window_frame(&window_for_close);
                    }
                    _ => {}
                });
            }

            #[cfg(target_os = "macos")]
            macos::menu::setup_macos_menu(app.handle())?;

            app.handle().emit("window-ready", ()).unwrap();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(
            #[allow(unused_variables)]
            |app_handle, event| {
                #[cfg(target_os = "macos")]
                match event {
                    tauri::RunEvent::Opened { urls } => {
                        let files = urls
                            .into_iter()
                            .filter_map(|url| url.to_file_path().ok())
                            .collect::<Vec<_>>();

                        let app_handler_clone = app_handle.clone();
                        allow_file_in_scopes(app_handle, files.clone());
                        app_handle.listen("window-ready", move |_| {
                            println!("Window is ready, proceeding to handle files.");
                            set_window_open_with_files(&app_handler_clone, files.clone());
                        });
                    }
                    // When the user reopens the app from the dock after closing all
                    // windows, re-show the main window instead of leaving the dock
                    // icon inert.
                    tauri::RunEvent::Reopen {
                        has_visible_windows: false,
                        ..
                    } => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            // Undo a pending Tahoe defensive hide (zeroed frame) before
                            // showing so the window reappears at its real position and
                            // size. No-op when the window was hidden plainly.
                            macos::window::restore_main_window_frame(&window);
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                    }
                    // A programmatic exit emits ExitRequested before the window-state
                    // plugin performs its final save. Restore any zeroed frame while
                    // the window is still hidden so live geometry remains valid.
                    tauri::RunEvent::ExitRequested { .. } => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            macos::window::restore_main_window_frame(&window);
                        }
                    }
                    _ => {}
                }
            },
        );
}
