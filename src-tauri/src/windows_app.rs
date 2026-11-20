#![cfg(target_os = "windows")]

use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, OnceLock};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Controller2, ICoreWebView2Environment,
    ICoreWebView2EnvironmentOptions, COREWEBVIEW2_COLOR, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::{
    take_pwstr, ContainsFullScreenElementChangedEventHandler, CoreWebView2EnvironmentOptions,
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
};
use windows::core::{s, w, Interface, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    BOOL, COLORREF, E_FAIL, E_POINTER, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, RECT,
    RPC_E_CHANGED_MODE, S_FALSE, S_OK, WPARAM,
};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
use windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::WinRT::EventRegistrationToken;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, GetWindowLongW,
    GetWindowPlacement, IsIconic, LoadCursorW, LoadImageW, PostMessageW, PostQuitMessage,
    RegisterClassExW, SetForegroundWindow, SetWindowLongPtrW, SetWindowLongW, SetWindowPlacement,
    SetWindowPos, ShowWindow, TranslateMessage, CW_USEDEFAULT, GWLP_USERDATA, GWL_EXSTYLE,
    GWL_STYLE, HICON, HWND_TOP, IDC_ARROW, IMAGE_ICON, LR_DEFAULTSIZE, LR_SHARED, MSG,
    SM_CXSCREEN, SM_CYSCREEN, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    SWP_NOZORDER, SW_HIDE, SW_RESTORE, SW_SHOW, WINDOWPLACEMENT, WM_APP, WM_CLOSE, WM_DESTROY,
    WM_SETFOCUS, WM_SIZE, WNDCLASSEXW, WS_EX_APPWINDOW, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME,
    WS_EX_NOACTIVATE, WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_WINDOWEDGE, WS_OVERLAPPEDWINDOW,
    WS_POPUP,
};

pub const IMP_NATIVE_UI_CLASS: &str = "ImpWin32WebViewWindowClass";
pub const IMP_NATIVE_WORKER_CLASS: &str = "ImpWin32AppleWorkerClass";
pub const WM_IMP_SHOW_WINDOW: u32 = WM_APP + 41;
pub const WM_IMP_QUIT_APP: u32 = WM_APP + 42;
pub const WM_IMP_SET_FULLSCREEN: u32 = WM_APP + 43;

#[cfg(has_embedded_webview2_loader)]
const EMBEDDED_WEBVIEW2_LOADER_DLL: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/WebView2Loader.dll"));

static MAIN_HWND_RAW: AtomicIsize = AtomicIsize::new(0);
static WEBVIEW2_LOADER_MODULE: OnceLock<isize> = OnceLock::new();

type CreateEnvWithOptionsFn = unsafe extern "system" fn(
    browser_executable_folder: PCWSTR,
    user_data_folder: PCWSTR,
    environment_options: *mut c_void,
    environment_created_handler: *mut c_void,
) -> HRESULT;

struct ComApartmentGuard(bool);

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

struct WindowState {
    controller: ICoreWebView2Controller,
    is_worker: bool,
    is_fullscreen: bool,
    saved_style: i32,
    saved_ex_style: i32,
    saved_placement: WINDOWPLACEMENT,
    // Keep callback event tokens alive until controller destruction.
    _perm_token: EventRegistrationToken,
    _new_win_token: Option<EventRegistrationToken>,
    _fullscreen_token: Option<EventRegistrationToken>,
}

fn to_wide<S: AsRef<OsStr>>(s: S) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

fn ensure_extracted_loader_dll(dest: &Path) -> bool {
    #[cfg(has_embedded_webview2_loader)]
    {
        if let Ok(meta) = std::fs::metadata(dest) {
            if meta.len() == EMBEDDED_WEBVIEW2_LOADER_DLL.len() as u64 {
                return true;
            }
        }
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp_name = format!("WebView2Loader.{}.tmp", std::process::id());
        let tmp_path = dest.with_file_name(tmp_name);
        if std::fs::write(&tmp_path, EMBEDDED_WEBVIEW2_LOADER_DLL).is_ok() {
            if std::fs::rename(&tmp_path, dest).is_ok() {
                return true;
            }
            let _ = std::fs::remove_file(&tmp_path);
        }
        dest.is_file()
    }
    #[cfg(not(has_embedded_webview2_loader))]
    {
        dest.is_file()
    }
}

fn try_load_dll_path(path: &Path) -> Option<HMODULE> {
    if !path.is_file() {
        return None;
    }
    let wide = to_wide(path);
    unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())).ok() }
}

fn load_create_env_fn() -> Result<CreateEnvWithOptionsFn, String> {
    let hmod = if let Some(&raw) = WEBVIEW2_LOADER_MODULE.get() {
        HMODULE(raw)
    } else {
        let mut loaded: Option<HMODULE> = None;
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                loaded = try_load_dll_path(&exe_dir.join("WebView2Loader.dll"))
                    .or_else(|| try_load_dll_path(&exe_dir.join("data/lib/WebView2Loader.dll")));
            }
        }
        if loaded.is_none() {
            let data_loader = imp_core::simp_data_dir().join("lib/WebView2Loader.dll");
            if ensure_extracted_loader_dll(&data_loader) {
                loaded = try_load_dll_path(&data_loader);
            }
        }
        if loaded.is_none() {
            loaded = unsafe { LoadLibraryW(w!("WebView2Loader.dll")).ok() };
        }
        let m = loaded.ok_or_else(|| "WebView2Loader.dll could not be located or loaded".to_string())?;
        let _ = WEBVIEW2_LOADER_MODULE.set(m.0);
        m
    };

    let proc = unsafe { GetProcAddress(hmod, s!("CreateCoreWebView2EnvironmentWithOptions")) }
        .ok_or_else(|| {
            "WebView2Loader.dll missing CreateCoreWebView2EnvironmentWithOptions".to_string()
        })?;
    let func: CreateEnvWithOptionsFn = unsafe { std::mem::transmute(proc) };
    Ok(func)
}

fn raise_main_window_from_callback() {
    let raw = MAIN_HWND_RAW.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = PostMessageW(HWND(raw), WM_IMP_SHOW_WINDOW, WPARAM(0), LPARAM(0));
        }
    }
}

fn is_local_imp_origin(uri: &str) -> bool {
    let lower = uri.trim().to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1:18888") || lower.starts_with("http://localhost:18888")
}

fn should_allow_webview_popup(uri: &str) -> bool {
    let trimmed = uri.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("about:blank") {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let host_port = without_scheme.split('/').next().unwrap_or("");
    let host = host_port.split(':').next().unwrap_or("");
    host == "127.0.0.1"
        || host == "localhost"
        || host == "apple.com"
        || host.ends_with(".apple.com")
        || host == "icloud.com"
        || host.ends_with(".icloud.com")
        || host == "soundcloud.com"
        || host.ends_with(".soundcloud.com")
}

unsafe fn sync_controller_bounds(hwnd: HWND, controller: &ICoreWebView2Controller) {
    let mut rc = RECT::default();
    if GetClientRect(hwnd, &mut rc).is_ok() {
        let _ = controller.SetBounds(rc);
    }
}

unsafe fn apply_window_fullscreen(hwnd: HWND, state: &mut WindowState, enter: bool) {
    if state.is_worker || state.is_fullscreen == enter {
        return;
    }
    if enter {
        state.saved_style = GetWindowLongW(hwnd, GWL_STYLE);
        state.saved_ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        state.saved_placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let _ = GetWindowPlacement(hwnd, &mut state.saved_placement);

        let next_style = (state.saved_style & !(WS_OVERLAPPEDWINDOW.0 as i32)) | (WS_POPUP.0 as i32);
        let ex_strip =
            (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE).0
                as i32;
        let next_ex_style = state.saved_ex_style & !ex_strip;

        SetWindowLongW(hwnd, GWL_STYLE, next_style);
        SetWindowLongW(hwnd, GWL_EXSTYLE, next_ex_style);

        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut mi).as_bool() {
            let rc = mi.rcMonitor;
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                rc.left,
                rc.top,
                rc.right - rc.left,
                rc.bottom - rc.top,
                SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
            );
        } else {
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
            );
        }
        state.is_fullscreen = true;
        sync_controller_bounds(hwnd, &state.controller);
    } else {
        SetWindowLongW(hwnd, GWL_STYLE, state.saved_style);
        SetWindowLongW(hwnd, GWL_EXSTYLE, state.saved_ex_style);
        let _ = SetWindowPlacement(hwnd, &state.saved_placement);
        let _ = SetWindowPos(
            hwnd,
            HWND(0),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
        );
        state.is_fullscreen = false;
        sync_controller_bounds(hwnd, &state.controller);
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);

    match msg {
        WM_SIZE => {
            if ptr != 0 {
                let state = &*(ptr as *const WindowState);
                sync_controller_bounds(hwnd, &state.controller);
            }
            LRESULT(0)
        }
        WM_SETFOCUS => {
            if ptr != 0 {
                let state = &*(ptr as *const WindowState);
                if !state.is_worker {
                    let _ = state
                        .controller
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                if !state.is_worker {
                    if state.is_fullscreen {
                        apply_window_fullscreen(hwnd, state, false);
                    }
                    let _ = state.controller.SetIsVisible(false);
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    return LRESULT(0);
                }
                let _ = state.controller.Close();
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_IMP_SET_FULLSCREEN => {
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                apply_window_fullscreen(hwnd, state, w_param.0 != 0);
            }
            LRESULT(0)
        }
        WM_IMP_SHOW_WINDOW => {
            if ptr != 0 {
                let state = &*(ptr as *const WindowState);
                if !state.is_worker {
                    let _ = state.controller.SetIsVisible(true);
                    sync_controller_bounds(hwnd, &state.controller);
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    } else {
                        let _ = ShowWindow(hwnd, SW_SHOW);
                    }
                    let _ = BringWindowToTop(hwnd);
                    let _ = SetForegroundWindow(hwnd);
                    let _ = state
                        .controller
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                    return LRESULT(0);
                }
            }
            LRESULT(0)
        }
        WM_IMP_QUIT_APP => {
            if ptr != 0 {
                let state = &*(ptr as *const WindowState);
                let _ = state.controller.Close();
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            MAIN_HWND_RAW.store(0, Ordering::SeqCst);
            if ptr != 0 {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(ptr as *mut WindowState));
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w_param, l_param),
    }
}

fn create_webview2_environment(
    create_env_fn: CreateEnvWithOptionsFn,
    user_data_dir: &Path,
    additional_args: &str,
) -> Result<ICoreWebView2Environment, String> {
    let opts = CoreWebView2EnvironmentOptions::default();
    unsafe {
        opts.set_additional_browser_arguments(additional_args.to_string());
    }
    let env_options: ICoreWebView2EnvironmentOptions = opts.into();
    let user_data_w = to_wide(user_data_dir);

    let (tx, rx) = mpsc::channel();
    let env_opts_raw = env_options.as_raw();
    let user_data_ptr = user_data_w.as_ptr();

    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            (create_env_fn)(
                PCWSTR::null(),
                PCWSTR(user_data_ptr),
                env_opts_raw,
                handler.as_raw(),
            )
            .ok()
            .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error_code, environment| {
            error_code?;
            tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                .map_err(|_| windows::core::Error::from(E_FAIL))?;
            Ok(())
        }),
    )
    .map_err(|e| format!("CreateCoreWebView2EnvironmentWithOptions failed: {e}"))?;

    let env = rx
        .recv()
        .map_err(|e| format!("WebView2 environment channel receive failed: {e}"))?
        .map_err(|e| format!("WebView2 environment error: {e}"))?;

    // Explicitly keep env_options and user_data_w alive until wait_for_async_operation finishes.
    drop(env_options);
    drop(user_data_w);
    Ok(env)
}

fn create_webview2_controller(
    env: &ICoreWebView2Environment,
    hwnd: HWND,
) -> Result<ICoreWebView2Controller, String> {
    let env_clone = env.clone();
    let (tx, rx) = mpsc::channel();

    CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            env_clone
                .CreateCoreWebView2Controller(hwnd, &handler)
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error_code, controller| {
            error_code?;
            tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                .map_err(|_| windows::core::Error::from(E_FAIL))?;
            Ok(())
        }),
    )
    .map_err(|e| format!("CreateCoreWebView2Controller failed: {e}"))?;

    rx.recv()
        .map_err(|e| format!("WebView2 controller channel receive failed: {e}"))?
        .map_err(|e| format!("WebView2 controller error: {e}"))
}

fn run_webview2_window(url: &str, is_worker: bool) -> Result<(), String> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let com_hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let com_guard = if com_hr == S_OK || com_hr == S_FALSE {
        ComApartmentGuard(true)
    } else if com_hr == RPC_E_CHANGED_MODE {
        return Err("Win32 thread initialized with non-STA COM apartment mode".to_string());
    } else {
        ComApartmentGuard(false)
    };

    let create_env_fn = load_create_env_fn()?;

    let class_name = if is_worker {
        IMP_NATIVE_WORKER_CLASS
    } else {
        IMP_NATIVE_UI_CLASS
    };
    let window_title = if is_worker {
        "IMP Headless Audio Worker"
    } else {
        "IMP — Interactive Media Player"
    };

    let class_w = to_wide(class_name);
    let title_w = to_wide(window_title);

    let hmod = unsafe { GetModuleHandleW(None) }
        .map_err(|e| format!("GetModuleHandleW failed: {e}"))?;
    let hinst = HINSTANCE(hmod.0);

    let bg_brush = unsafe { CreateSolidBrush(COLORREF(0x000c0808)) };
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default();
    let (icon_big, icon_sm) = if !is_worker {
        let res_id = PCWSTR(1usize as *const u16);
        let big = unsafe {
            LoadImageW(hinst, res_id, IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED)
                .map(|h| HICON(h.0))
                .unwrap_or_default()
        };
        let sm = unsafe {
            LoadImageW(hinst, res_id, IMAGE_ICON, 16, 16, LR_SHARED)
                .map(|h| HICON(h.0))
                .unwrap_or_default()
        };
        (big, sm)
    } else {
        (HICON::default(), HICON::default())
    };

    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: Default::default(),
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinst,
        hIcon: icon_big,
        hCursor: cursor,
        hbrBackground: bg_brush,
        lpszMenuName: PCWSTR::null(),
        lpszClassName: PCWSTR(class_w.as_ptr()),
        hIconSm: icon_sm,
    };
    unsafe {
        let _ = RegisterClassExW(&wc);
    }

    let (ex_style, style, x, y, w_px, h_px) = if is_worker {
        (
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            WS_POPUP,
            -32_000,
            -32_000,
            320,
            240,
        )
    } else {
        let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        let width = if screen_w > 0 {
            1280.min((screen_w - 40).max(640))
        } else {
            1280
        };
        let height = if screen_h > 0 {
            800.min((screen_h - 60).max(480))
        } else {
            800
        };
        let pos_x = if screen_w > width {
            (screen_w - width) / 2
        } else {
            CW_USEDEFAULT
        };
        let pos_y = if screen_h > height {
            (screen_h - height) / 2
        } else {
            CW_USEDEFAULT
        };
        (
            WS_EX_APPWINDOW,
            WS_OVERLAPPEDWINDOW,
            pos_x,
            pos_y,
            width,
            height,
        )
    };

    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            PCWSTR(class_w.as_ptr()),
            PCWSTR(title_w.as_ptr()),
            style,
            x,
            y,
            w_px,
            h_px,
            None,
            None,
            hinst,
            None,
        )
    };
    if hwnd.0 == 0 {
        return Err("CreateWindowExW failed for IMP WebView2 host window".to_string());
    }

    if !is_worker {
        let dark: i32 = 1;
        unsafe {
            if DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(20),
                (&dark as *const i32) as *const c_void,
                std::mem::size_of::<i32>() as u32,
            )
            .is_err()
            {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWINDOWATTRIBUTE(19),
                    (&dark as *const i32) as *const c_void,
                    std::mem::size_of::<i32>() as u32,
                );
            }
        }
    }

    let user_data_dir = if is_worker {
        imp_core::simp_data_dir().join("webview2-apple-worker")
    } else {
        imp_core::simp_data_dir().join("webview2-ui")
    };
    let _ = std::fs::create_dir_all(&user_data_dir);

    let additional_args = if is_worker {
        "--autoplay-policy=no-user-gesture-required \
         --use-fake-ui-for-media-stream \
         --disable-background-timer-throttling \
         --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows \
         --disable-features=Translate,DialMediaRouteProvider,OptimizationHints,MediaRouter,HardwareMediaKeyHandling,MediaSessionService,CalculateNativeWinOcclusion"
    } else {
        "--autoplay-policy=no-user-gesture-required \
         --disable-features=HardwareMediaKeyHandling,MediaSessionService"
    };

    let env = match create_webview2_environment(create_env_fn, &user_data_dir, additional_args) {
        Ok(env) => env,
        Err(err) => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            return Err(err);
        }
    };

    let controller = match create_webview2_controller(&env, hwnd) {
        Ok(ctrl) => ctrl,
        Err(err) => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            return Err(err);
        }
    };

    unsafe {
        if let Ok(ctrl2) = controller.cast::<ICoreWebView2Controller2>() {
            let _ = ctrl2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 255,
                R: 8,
                G: 8,
                B: 12,
            });
        }
        sync_controller_bounds(hwnd, &controller);
        let _ = controller.SetIsVisible(true);
    }

    let webview = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("ICoreWebView2 acquisition failed: {e}"))?;

    unsafe {
        if let Ok(settings) = webview.Settings() {
            let _ = settings.SetIsStatusBarEnabled(false);
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetAreDefaultScriptDialogsEnabled(true);
            let devtools = cfg!(debug_assertions)
                || std::env::var("IMP_WEBVIEW_DEVTOOLS").ok().as_deref() == Some("1");
            let _ = settings.SetAreDevToolsEnabled(devtools);
            let _ = settings.SetAreDefaultContextMenusEnabled(devtools);
        }
    }

    let mut perm_token = EventRegistrationToken::default();
    let perm_handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
        if let Some(args) = args {
            let mut uri_pw = PWSTR::null();
            if unsafe { args.Uri(&mut uri_pw) }.is_ok() {
                let uri = take_pwstr(uri_pw);
                if is_local_imp_origin(&uri) {
                    let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
                }
            }
        }
        Ok(())
    }));
    unsafe {
        let _ = webview.add_PermissionRequested(&perm_handler, &mut perm_token);
    }

    let new_win_token = if !is_worker {
        let mut token = EventRegistrationToken::default();
        let new_win_handler =
            NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    let mut uri_pw = PWSTR::null();
                    let uri = if unsafe { args.Uri(&mut uri_pw) }.is_ok() {
                        take_pwstr(uri_pw)
                    } else {
                        String::new()
                    };
                    if should_allow_webview_popup(&uri) {
                        let _ = unsafe { args.SetHandled(false) };
                    } else if uri.starts_with("http://") || uri.starts_with("https://") {
                        let _ = unsafe { args.SetHandled(true) };
                        let mut cmd = Command::new("explorer");
                        cmd.arg(&uri)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null());
                        imp_core::configure_background_command(&mut cmd);
                        let _ = cmd.spawn();
                    }
                }
                Ok(())
            }));
        unsafe {
            let _ = webview.add_NewWindowRequested(&new_win_handler, &mut token);
        }
        Some(token)
    } else {
        None
    };

    let fullscreen_token = if !is_worker {
        let mut token = EventRegistrationToken::default();
        let fs_hwnd_raw = hwnd.0;
        let fs_handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(
            move |sender, _args| {
                if let Some(wv) = sender {
                    let mut is_fs = BOOL(0);
                    if unsafe { wv.ContainsFullScreenElement(&mut is_fs) }.is_ok() {
                        unsafe {
                            let _ = PostMessageW(
                                HWND(fs_hwnd_raw),
                                WM_IMP_SET_FULLSCREEN,
                                WPARAM(usize::from(is_fs.as_bool())),
                                LPARAM(0),
                            );
                        }
                    }
                }
                Ok(())
            },
        ));
        unsafe {
            let _ = webview.add_ContainsFullScreenElementChanged(&fs_handler, &mut token);
        }
        Some(token)
    } else {
        None
    };

    let url_w = to_wide(url);
    if let Err(e) = unsafe { webview.Navigate(PCWSTR(url_w.as_ptr())) } {
        unsafe {
            let _ = controller.Close();
            let _ = DestroyWindow(hwnd);
        }
        return Err(format!("WebView2 Navigate failed: {e}"));
    }

    let state_ptr = Box::into_raw(Box::new(WindowState {
        controller,
        is_worker,
        is_fullscreen: false,
        saved_style: 0,
        saved_ex_style: 0,
        saved_placement: WINDOWPLACEMENT::default(),
        _perm_token: perm_token,
        _new_win_token: new_win_token,
        _fullscreen_token: fullscreen_token,
    }));
    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
    }

    if !is_worker {
        MAIN_HWND_RAW.store(hwnd.0, Ordering::SeqCst);
        imp_core::mpris::set_native_window_raiser(raise_main_window_from_callback);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let state = &*(state_ptr as *const WindowState);
            let _ = state
                .controller
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    }

    let mut msg = MSG::default();
    loop {
        let res = unsafe { GetMessageW(&mut msg, HWND::default(), 0, 0).0 };
        if res <= 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    drop(com_guard);
    Ok(())
}

/// Launches the embedded Edge WebView2 desktop window for the IMP Console on Windows.
pub fn run_windows_native_app(ui_url: &str) -> Result<(), String> {
    run_webview2_window(ui_url, false)
}

/// Launches a hidden embedded Edge WebView2 background host (`WS_EX_TOOLWINDOW`) for
/// Apple Music Widevine/PlayReady DRM playback on Windows.
pub fn run_windows_apple_worker(worker_url: &str) -> Result<(), String> {
    run_webview2_window(worker_url, true)
}
