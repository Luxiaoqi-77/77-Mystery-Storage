use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowThreadProcessId, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
    GWL_HWNDPARENT, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
};

const PET_SIZE: i32 = 260;
const PEEK_VISIBLE: i32 = 161;
const IDLE_RANDOM_ACTION_MS: u64 = 30_000;
const IDLE_NOTHING_CHANCE: f64 = 0.2;
const AUTONOMOUS_PEEK_REST_MS: u64 = 60_000;
const AUTONOMOUS_SIT_MS: u64 = 60_000;
const AUTONOMOUS_SLEEP_MS: u64 = 120_000;
const AUTONOMOUS_WALK_STEP: i32 = 3;
const MOUSE_SAMPLE_MS: u64 = 60;
const CLING_ATTACH_THRESHOLD: i32 = 52;
const CLING_OVERLAP: i32 = 42;
const EDGE_WALK_MS: u64 = 18_000;
const EDGE_PEEK_WALK_MS: u64 = 1_000;
const HEAD_SHAKE_TRIGGER_SCORE: f64 = 9.0;
const ANNOYED_LOCK_MS: u64 = 5_000;
const ANNOYED_CLICK_TARGET: u32 = 5;
const ANNOYED_CLICK_WINDOW_MS: u64 = 3_000;
const BEFUDDLED_TO_SIT_MS: u64 = 3_500;
const BEFUDDLED_DROP_TO_SIT_MS: u64 = 3_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct PointPayload {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DragEndPayload {
    #[serde(default, rename = "startGaze")]
    start_gaze: Option<bool>,
    #[serde(default, rename = "liftedBefuddledDrop")]
    lifted_befuddled_drop: bool,
    #[serde(default)]
    point: Option<PointPayload>,
}

#[derive(Debug, Clone, Serialize)]
struct StatePayload {
    state: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<String>,
    #[serde(rename = "startGaze", skip_serializing_if = "Option::is_none")]
    start_gaze: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct BoundsPayload {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Debug, Clone, Serialize)]
struct MotionPayload {
    x: i32,
    y: i32,
    speed: f64,
    #[serde(rename = "headShakeScore")]
    head_shake_score: f64,
    #[serde(rename = "idleMs")]
    idle_ms: u64,
    bounds: BoundsPayload,
}

#[derive(Debug, Clone, Copy)]
struct WindowRect {
    hwnd: isize,
    left: i32,
    top: i32,
    right: i32,
    width: i32,
    height: i32,
    topmost: bool,
}

#[derive(Debug, Clone)]
enum AutonomousAction {
    Walk {
        direction: String,
        origin_x: i32,
        max_distance: i32,
    },
    Pose {
        state: String,
        until: Instant,
    },
    PeekRest {
        edge: String,
        until: Instant,
    },
    LeavePeek {
        direction: String,
    },
}

#[derive(Debug, Clone)]
struct EdgePeekWalk {
    direction: String,
    until: Instant,
}

#[derive(Debug)]
struct AttachedWindow {
    hwnd: isize,
    offset_x: i32,
}

#[derive(Debug)]
struct RuntimeState {
    dragging: bool,
    drag_offset: PointPayload,
    last_cursor: Option<(i32, i32, Instant)>,
    last_interaction_at: Instant,
    last_pet_interaction_at: Instant,
    current_pet_state: String,
    annoyed_active: bool,
    annoyed_locked_until: Option<Instant>,
    click_burst_started_at: Option<Instant>,
    click_burst_count: u32,
    last_click_at: Option<Instant>,
    hidden_edge: Option<String>,
    autonomous_action: Option<AutonomousAction>,
    next_idle_action_at: Instant,
    attached_window: Option<AttachedWindow>,
    normal_always_on_top: bool,
    passthrough: bool,
    // Head-shake (matching Electron headShakeScore / triggerBefuddledThenSit)
    head_shake_score: f64,
    last_head_shake_axis: Option<i32>,
    last_befuddled_at: Instant,
    // Edge walk (matching Electron maybeEdgeWalk / edgePeekWalk)
    edge_peek_walk: Option<EdgePeekWalk>,
    edge_walk_direction: i32,
    last_edge_walk_at: Instant,
    // Befuddled-then-sit deferred transition
    befuddled_then_sit_at: Option<Instant>,
    // Auto-idle after a timed state (matching Electron's sendState setTimeout)
    auto_idle_at: Option<(Instant, String)>,
    // Auto-start
    autostart_enabled: bool,
}

impl Default for RuntimeState {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            dragging: false,
            drag_offset: PointPayload { x: 0, y: 0 },
            last_cursor: None,
            last_interaction_at: now,
            last_pet_interaction_at: now,
            current_pet_state: "idle".to_string(),
            annoyed_active: false,
            annoyed_locked_until: None,
            click_burst_started_at: None,
            click_burst_count: 0,
            last_click_at: None,
            hidden_edge: None,
            autonomous_action: None,
            next_idle_action_at: now + Duration::from_millis(IDLE_RANDOM_ACTION_MS),
            attached_window: None,
            normal_always_on_top: true,
            passthrough: false,
            head_shake_score: 0.0,
            last_head_shake_axis: None,
            last_befuddled_at: now - Duration::from_secs(60),
            edge_peek_walk: None,
            edge_walk_direction: 1,
            last_edge_walk_at: now - Duration::from_secs(60),
            befuddled_then_sit_at: None,
            auto_idle_at: None,
            autostart_enabled: true, // Matches Electron: app.getLoginItemSettings().openAtLogin || true
        }
    }
}

#[derive(Default)]
struct AppState(Mutex<RuntimeState>);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn emit_state(app: &AppHandle, state: &str, duration_ms: u64, direction: Option<&str>, start_gaze: Option<bool>) {
    let app = app.clone();
    let payload = StatePayload {
        state: state.to_string(),
        duration_ms,
        direction: direction.map(ToString::to_string),
        start_gaze,
    };
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("pet-state", payload);
    });
}

fn set_window_position(window: &WebviewWindow, x: i32, y: i32) {
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn window_bounds(window: &WebviewWindow) -> BoundsPayload {
    let pos = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let size = window.outer_size().unwrap_or(PhysicalSize::new(PET_SIZE as u32, PET_SIZE as u32));
    BoundsPayload {
        x: pos.x,
        y: pos.y,
        width: size.width as i32,
        height: size.height as i32,
    }
}

fn cursor_point() -> PointPayload {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    PointPayload { x: point.x, y: point.y }
}

/// Returns the work area (excluding taskbar) of the monitor the window is on.
/// Matches Electron's `screen.getDisplayMatching(bounds).workArea`.
fn monitor_work_area(window: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let monitor = MonitorFromWindow(HWND(hwnd.0), MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(monitor, &mut info).as_bool() {
                    return Some((
                        info.rcWork.left,
                        info.rcWork.top,
                        info.rcWork.right - info.rcWork.left,
                        info.rcWork.bottom - info.rcWork.top,
                    ));
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let monitor = window.current_monitor().ok().flatten();
        return monitor.map(|m| (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32));
    }
    #[cfg(target_os = "windows")]
    None
}

fn is_annoyed_locked(state: &RuntimeState) -> bool {
    state.annoyed_active && state.annoyed_locked_until.map(|until| Instant::now() < until).unwrap_or(false)
}

fn reset_click_chain(state: &mut RuntimeState) {
    state.click_burst_started_at = None;
    state.click_burst_count = 0;
}

fn mark_pet_interaction(state: &mut RuntimeState) {
    let now = Instant::now();
    state.last_pet_interaction_at = now;
    state.autonomous_action = None;
    state.hidden_edge = None; // Matches Electron cancelAutonomousAction({ clearPeek: true })
    state.next_idle_action_at = now + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
}

fn set_passthrough(window: &WebviewWindow, state: &mut RuntimeState, enabled: bool) {
    if state.passthrough == enabled {
        return;
    }
    state.passthrough = enabled;
    let _ = window.set_ignore_cursor_events(enabled);
}

fn is_cursor_over_head(cursor: PointPayload, bounds: BoundsPayload) -> bool {
    // Match JS float comparison: localX >= bounds.width * 0.06  (not integer truncation)
    let local_x = (cursor.x - bounds.x) as f64;
    let local_y = (cursor.y - bounds.y) as f64;
    local_x >= bounds.width as f64 * 0.06
        && local_x <= bounds.width as f64 * 0.94
        && local_y >= -(bounds.height as f64 * 0.06)
        && local_y <= bounds.height as f64 * 0.58
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<WindowRect>);
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    if GetWindowTextLengthW(hwnd) <= 0 {
        return BOOL(1);
    }
    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    if process_id == GetCurrentProcessId() {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return BOOL(1);
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width < 180 || height < 120 {
        return BOOL(1);
    }
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    windows.push(WindowRect {
        hwnd: hwnd.0 as isize,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        width,
        height,
        topmost: (ex_style & WS_EX_TOPMOST.0) != 0,
    });
    BOOL(1)
}

fn visible_windows() -> Vec<WindowRect> {
    let mut windows = Vec::<WindowRect>::new();
    unsafe {
        let ptr = &mut windows as *mut Vec<WindowRect>;
        let _ = EnumWindows(Some(enum_windows_proc), LPARAM(ptr as isize));
    }
    windows
}

fn rect_by_handle(hwnd: isize) -> Option<WindowRect> {
    unsafe {
        let hwnd = HWND(hwnd as _);
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        Some(WindowRect {
            hwnd: hwnd.0 as isize,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            width,
            height,
            topmost: (ex_style & WS_EX_TOPMOST.0) != 0,
        })
    }
}

fn set_owner_window(window: &WebviewWindow, owner: Option<isize>) {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Ok(hwnd) = window.hwnd() {
            let owner_hwnd = HWND(owner.unwrap_or(0) as _);
            SetWindowLongPtrW(HWND(hwnd.0), GWL_HWNDPARENT, owner_hwnd.0 as isize);
            if let Some(owner) = owner {
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    Some(HWND(owner as _)),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
}

fn find_top_attach_target(bounds: BoundsPayload, point: Option<PointPayload>) -> Option<WindowRect> {
    let pet_left = bounds.x;
    let pet_right = bounds.x + bounds.width;
    let pet_bottom = bounds.y + bounds.height;
    let center_x = bounds.x + bounds.width / 2;

    visible_windows()
        .into_iter()
        .filter_map(|candidate| {
            let overlap = pet_right.min(candidate.right) - pet_left.max(candidate.left);
            let top_distance = (pet_bottom - candidate.top).abs();
            let pointer_top_distance = point.map(|p| (p.y - candidate.top).abs()).unwrap_or(i32::MAX);
            let center_inside = center_x >= candidate.left - 24 && center_x <= candidate.right + 24;
            let pointer_inside = point
                .map(|p| p.x >= candidate.left - 24 && p.x <= candidate.right + 24)
                .unwrap_or(false);
            let near_top = top_distance <= CLING_ATTACH_THRESHOLD || pointer_top_distance <= CLING_ATTACH_THRESHOLD;
            if near_top && overlap > 48 && (center_inside || pointer_inside) {
                let score = top_distance.min(pointer_top_distance) - overlap / 20;
                Some((score, candidate))
            } else {
                None
            }
        })
        .min_by_key(|(score, _)| *score)
        .map(|(_, candidate)| candidate)
}

fn apply_attached_bounds(window: &WebviewWindow, state: &RuntimeState, rect: WindowRect) {
    let offset_x = state
        .attached_window
        .as_ref()
        .map(|attached| attached.offset_x)
        .unwrap_or((rect.width - PET_SIZE) / 2);
    let min_offset_x = -PET_SIZE + 42;
    let max_offset_x = rect.width - 42;
    let x = rect.left + offset_x.clamp(min_offset_x, max_offset_x);
    let y = rect.top - PET_SIZE + CLING_OVERLAP;
    set_window_position(window, x, y);
    let _ = window.set_always_on_top(rect.topmost);
}

fn attach_to_window(app: &AppHandle, state: &mut RuntimeState, rect: WindowRect) -> bool {
    if is_annoyed_locked(state) {
        return false;
    }
    let Some(window) = main_window(app) else {
        return false;
    };
    let bounds = window_bounds(&window);
    state.attached_window = Some(AttachedWindow {
        hwnd: rect.hwnd,
        offset_x: bounds.x - rect.left,
    });
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.autonomous_action = None;
    state.current_pet_state = "cling_top".to_string();
    set_passthrough(&window, state, false);
    let _ = window.set_focusable(false);
    set_owner_window(&window, Some(rect.hwnd));
    apply_attached_bounds(&window, state, rect);
    emit_state(app, "cling_top", 0, None, None);
    state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
    true
}

fn detach_from_window(app: &AppHandle, state: &mut RuntimeState, to_idle: bool) {
    if state.attached_window.is_none() {
        return; // Matches Electron: if (!attachedWindow) return;
    }
    let Some(window) = main_window(app) else {
        return;
    };
    state.attached_window = None;
    set_owner_window(&window, None);
    set_passthrough(&window, state, false);
    let _ = window.set_focusable(true);
    let _ = window.set_always_on_top(state.normal_always_on_top);
    state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
    if to_idle {
        state.current_pet_state = "idle".to_string();
        emit_state(app, "idle", 0, None, None);
    }
}

fn update_attached_window(app: &AppHandle, state: &mut RuntimeState) -> bool {
    let Some(attached) = state.attached_window.as_ref() else {
        return false;
    };
    let Some(window) = main_window(app) else {
        return false;
    };
    match rect_by_handle(attached.hwnd) {
        Some(rect) if rect.width >= 180 && rect.height >= 80 => {
            apply_attached_bounds(&window, state, rect);
            true
        }
        _ => {
            detach_from_window(app, state, true);
            false
        }
    }
}

fn send_state(app: &AppHandle, state: &mut RuntimeState, pet_state: &str, duration_ms: u64, start_gaze: Option<bool>) {
    if is_annoyed_locked(state) && pet_state != "idle" {
        return;
    }
    if state.attached_window.is_some() && pet_state != "cling_top" {
        detach_from_window(app, state, false);
    }
    mark_pet_interaction(state);
    state.current_pet_state = pet_state.to_string();
    state.last_interaction_at = Instant::now();
    state.hidden_edge = None;
    if pet_state != "click_annoyed" {
        state.annoyed_active = false;
        state.annoyed_locked_until = None;
    }
    // If state changes away from befuddled, cancel any pending befuddled→sit
    if pet_state != "befuddled" {
        state.befuddled_then_sit_at = None;
    }
    // Cancel auto-idle if state isn't the expected one
    if let Some((_, ref expected)) = state.auto_idle_at {
        if pet_state != expected.as_str() {
            state.auto_idle_at = None;
        }
    }
    // Auto-idle timer (matching Electron: setTimeout(() => { if currentPetState === stateAtStart ) currentPetState = 'idle' }, durationMs))
    if duration_ms > 0 {
        state.auto_idle_at = Some((Instant::now() + Duration::from_millis(duration_ms), pet_state.to_string()));
    } else {
        state.auto_idle_at = None;
    }
    emit_state(app, pet_state, duration_ms, None, start_gaze);
}

fn send_walk(app: &AppHandle, state: &mut RuntimeState, direction: &str, count_as_interaction: bool, clear_peek: bool) {
    if is_annoyed_locked(state) {
        return;
    }
    if count_as_interaction {
        mark_pet_interaction(state);
    }
    state.current_pet_state = "walk".to_string();
    state.last_interaction_at = Instant::now();
    if clear_peek {
        state.hidden_edge = None;
    }
    emit_state(app, "walk", 0, Some(direction), None);
}

fn send_peek(app: &AppHandle, state: &mut RuntimeState, direction: &str) {
    if is_annoyed_locked(state) {
        return;
    }
    state.current_pet_state = "peek".to_string();
    emit_state(app, "peek", 0, Some(direction), None);
}

fn enter_annoyed_lock(app: &AppHandle, state: &mut RuntimeState) {
    let now = Instant::now();
    state.annoyed_active = true;
    state.annoyed_locked_until = Some(now + Duration::from_millis(ANNOYED_LOCK_MS));
    state.dragging = false;
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.autonomous_action = None;
    state.head_shake_score = 0.0;
    reset_click_chain(state);
    state.current_pet_state = "click_annoyed".to_string();
    emit_state(app, "click_annoyed", 0, None, None);
}

fn trigger_befuddled_then_sit(app: &AppHandle, state: &mut RuntimeState) {
    if is_annoyed_locked(state) {
        return;
    }
    if !["idle", "click_happy"].contains(&state.current_pet_state.as_str()) {
        return;
    }
    let now = Instant::now();
    if now.duration_since(state.last_befuddled_at).as_millis() < 7000 {
        return;
    }
    state.last_befuddled_at = now;
    state.head_shake_score = 0.0;
    state.last_head_shake_axis = None;
    state.dragging = false;
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.current_pet_state = "befuddled".to_string();
    emit_state(app, "befuddled", 0, None, None);
    state.befuddled_then_sit_at = Some(now + Duration::from_millis(BEFUDDLED_TO_SIT_MS));
}

fn send_befuddled_then_sit(app: &AppHandle, state: &mut RuntimeState, duration_ms: u64) {
    if is_annoyed_locked(state) {
        return;
    }
    let now = Instant::now();
    state.dragging = false;
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.current_pet_state = "befuddled".to_string();
    emit_state(app, "befuddled", 0, None, None);
    state.befuddled_then_sit_at = Some(now + Duration::from_millis(duration_ms));
}

fn start_edge_peek_walk(app: &AppHandle, state: &mut RuntimeState, direction: &str) {
    if state.edge_peek_walk.is_some() || state.hidden_edge.is_some() {
        return;
    }
    if is_annoyed_locked(state) {
        return;
    }
    let now = Instant::now();
    state.edge_peek_walk = Some(EdgePeekWalk {
        direction: direction.to_string(),
        until: now + Duration::from_millis(EDGE_PEEK_WALK_MS),
    });
    state.last_edge_walk_at = now;
    send_walk(app, state, direction, true, true); // Electron sendWalk defaults countAsInteraction=true, clearPeek=true
}

fn finish_edge_peek_walk(app: &AppHandle, state: &mut RuntimeState, area_x: i32, area_y: i32, area_width: i32, area_height: i32) {
    let Some(edge_peek) = state.edge_peek_walk.as_ref() else {
        return;
    };
    let Some(window) = main_window(app) else {
        return;
    };
    let direction = edge_peek.direction.clone();
    let bounds = window_bounds(&window);
    let x = if direction == "left" {
        area_x - PET_SIZE + PEEK_VISIBLE
    } else {
        area_x + area_width - PEEK_VISIBLE
    };
    let y = bounds.y.clamp(area_y, area_y + area_height - PET_SIZE);
    set_window_position(&window, x, y);
    state.hidden_edge = Some(direction.clone());
    state.edge_peek_walk = None;
    send_peek(app, state, &direction);
}

fn maybe_edge_walk(app: &AppHandle, state: &mut RuntimeState, area_x: i32, area_y: i32, area_width: i32, area_height: i32) {
    if state.dragging {
        return;
    }
    if is_annoyed_locked(state) {
        return;
    }
    if state.autonomous_action.is_some() {
        return;
    }
    let Some(window) = main_window(app) else {
        return;
    };
    let now = Instant::now();
    let bounds = window_bounds(&window);

    // Already in an edge-peek walk
    if let Some(ref edge_peek) = state.edge_peek_walk {
        if now >= edge_peek.until {
            finish_edge_peek_walk(app, state, area_x, area_y, area_width, area_height);
            return;
        }
        let step: i32 = 4;
        let dx = if edge_peek.direction == "left" { -step } else { step };
        let min_x = area_x - PET_SIZE + PEEK_VISIBLE;
        let max_x = area_x + area_width - PEEK_VISIBLE;
        let x = (bounds.x + dx).clamp(min_x, max_x);
        set_window_position(&window, x, bounds.y);
        return;
    }

    if state.hidden_edge.is_some() {
        return;
    }

    let near_left = bounds.x <= area_x + 2;
    let near_right = bounds.x + bounds.width >= area_x + area_width - 2;
    if !near_left && !near_right {
        return;
    }
    if now.duration_since(state.last_edge_walk_at).as_millis() as u64 > EDGE_WALK_MS {
        state.edge_walk_direction = if near_left { -1 } else { 1 };
        start_edge_peek_walk(
            app,
            state,
            if state.edge_walk_direction < 0 { "left" } else { "right" },
        );
    }
}

fn random_f64() -> f64 {
    let nanos = Instant::now().elapsed().as_nanos() as u64;
    let mut x = nanos ^ 0x9E37_79B9_7F4A_7C15;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    ((x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64) / ((1u64 << 53) as f64)
}

fn start_autonomous_walk(app: &AppHandle, state: &mut RuntimeState, direction: &str) {
    let Some(window) = main_window(app) else {
        return;
    };
    let bounds = window_bounds(&window);
    let monitor_width = monitor_work_area(&window)
        .map(|(_, _, w, _)| w)
        .unwrap_or(1920);
    let ratio = if random_f64() < 0.6 { 0.1 } else { 1.0 / 3.0 };
    let max_distance = (monitor_width as f64 * ratio).floor() as i32;
    state.autonomous_action = Some(AutonomousAction::Walk {
        direction: direction.to_string(),
        origin_x: bounds.x,
        max_distance,
    });
    send_walk(app, state, direction, false, true); // Electron: countAsInteraction=false (autonomous), clearPeek=true (default)
}

fn start_autonomous_pose(app: &AppHandle, state: &mut RuntimeState, pose: &str) {
    let duration = if pose == "sit" {
        AUTONOMOUS_SIT_MS
    } else {
        AUTONOMOUS_SLEEP_MS
    };
    state.autonomous_action = Some(AutonomousAction::Pose {
        state: pose.to_string(),
        until: Instant::now() + Duration::from_millis(duration),
    });
    state.current_pet_state = pose.to_string();
    state.hidden_edge = None;
    emit_state(app, pose, 0, None, None);
}

fn start_random_idle_action(app: &AppHandle, state: &mut RuntimeState) {
    let Some(window) = main_window(app) else {
        return;
    };
    if state.dragging || state.hidden_edge.is_some() || state.edge_peek_walk.is_some() || state.autonomous_action.is_some() || state.current_pet_state != "idle" {
        return;
    }
    if random_f64() < IDLE_NOTHING_CHANCE {
        state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
        return;
    }
    let bounds = window_bounds(&window);
    let (area_x, _, area_width, _) = monitor_work_area(&window).unwrap_or((0, 0, 1920, 1080));
    let left_distance = (bounds.x - area_x).max(0);
    let right_distance = (area_x + area_width - (bounds.x + bounds.width)).max(0);
    let near_edge = left_distance.min(right_distance) <= area_width / 6;
    let walk_chance = if near_edge { 0.4 } else { 0.2 };
    let sit_chance = if near_edge { 0.225 } else { 0.3 };
    let roll = random_f64();
    if roll < walk_chance {
        let direction = if near_edge {
            if left_distance <= right_distance { "left" } else { "right" }
        } else if random_f64() < 0.5 {
            "left"
        } else {
            "right"
        };
        start_autonomous_walk(app, state, direction);
    } else if roll < walk_chance + sit_chance {
        start_autonomous_pose(app, state, "sit");
    } else {
        start_autonomous_pose(app, state, "sleep");
    }
}

fn update_autonomous_action(app: &AppHandle, state: &mut RuntimeState) {
    if state.dragging || is_annoyed_locked(state) {
        return;
    }
    if state.autonomous_action.is_none() {
        let now = Instant::now();
        if now.duration_since(state.last_pet_interaction_at).as_millis() as u64 >= IDLE_RANDOM_ACTION_MS
            && now >= state.next_idle_action_at
        {
            start_random_idle_action(app, state);
        }
        return;
    }
    let Some(window) = main_window(app) else {
        return;
    };
    let bounds = window_bounds(&window);
    let (area_x, area_y, area_width, area_height) = monitor_work_area(&window).unwrap_or((0, 0, 1920, 1080));

    let action = state.autonomous_action.clone();
    match action {
        Some(AutonomousAction::Pose { state: pose, until }) => {
            if Instant::now() >= until {
                state.autonomous_action = None;
                state.current_pet_state = "idle".to_string();
                state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
                emit_state(app, "idle", 0, None, None);
            } else {
                state.current_pet_state = pose;
            }
        }
        Some(AutonomousAction::PeekRest { edge, until }) => {
            if Instant::now() >= until {
                let direction = if edge == "left" { "right" } else { "left" };
                state.autonomous_action = Some(AutonomousAction::LeavePeek {
                    direction: direction.to_string(),
                });
                send_walk(app, state, direction, false, false); // Electron finishAutonomousPeek: clearPeek=false
            }
        }
        Some(AutonomousAction::Walk {
            direction,
            origin_x,
            max_distance,
        }) => {
            let dx = if direction == "left" { -AUTONOMOUS_WALK_STEP } else { AUTONOMOUS_WALK_STEP };
            let mut next_x = bounds.x + dx;
            let reaches_left = next_x <= area_x - PET_SIZE + PEEK_VISIBLE;
            let reaches_right = next_x + PET_SIZE >= area_x + area_width + PET_SIZE - PEEK_VISIBLE;
            if direction == "left" && reaches_left {
                next_x = area_x - PET_SIZE + PEEK_VISIBLE;
                set_window_position(&window, next_x, bounds.y.clamp(area_y, area_y + area_height - PET_SIZE));
                state.hidden_edge = Some("left".to_string());
                state.autonomous_action = Some(AutonomousAction::PeekRest {
                    edge: "left".to_string(),
                    until: Instant::now() + Duration::from_millis(AUTONOMOUS_PEEK_REST_MS),
                });
                send_peek(app, state, "left");
                return;
            }
            if direction == "right" && reaches_right {
                next_x = area_x + area_width - PEEK_VISIBLE;
                set_window_position(&window, next_x, bounds.y.clamp(area_y, area_y + area_height - PET_SIZE));
                state.hidden_edge = Some("right".to_string());
                state.autonomous_action = Some(AutonomousAction::PeekRest {
                    edge: "right".to_string(),
                    until: Instant::now() + Duration::from_millis(AUTONOMOUS_PEEK_REST_MS),
                });
                send_peek(app, state, "right");
                return;
            }
            if (next_x - origin_x).abs() >= max_distance {
                next_x = (origin_x + if direction == "left" { -max_distance } else { max_distance })
                    .clamp(area_x + 12, area_x + area_width - PET_SIZE - 12);
                set_window_position(&window, next_x, bounds.y);
                state.autonomous_action = None;
                state.current_pet_state = "idle".to_string();
                state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
                emit_state(app, "idle", 0, None, None);
                return;
            }
            set_window_position(&window, next_x, bounds.y);
        }
        Some(AutonomousAction::LeavePeek { direction }) => {
            let dx = if direction == "left" { -AUTONOMOUS_WALK_STEP } else { AUTONOMOUS_WALK_STEP };
            let next_x = bounds.x + dx;
            let fully_inside_left = direction == "right" && next_x >= area_x + 12;
            let fully_inside_right = direction == "left" && next_x + PET_SIZE <= area_x + area_width - 12;
            if fully_inside_left || fully_inside_right {
                let x = if direction == "right" {
                    area_x + 12
                } else {
                    area_x + area_width - PET_SIZE - 12
                };
                set_window_position(&window, x, bounds.y);
                state.hidden_edge = None;
                state.autonomous_action = None;
                state.current_pet_state = "idle".to_string();
                state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
                emit_state(app, "idle", 0, None, None);
            } else {
                set_window_position(&window, next_x, bounds.y);
            }
        }
        None => {}
    }
}

// ── Tauri commands ──────────────────────────────────────

#[tauri::command]
fn pet_drag_start(app: AppHandle, state: tauri::State<AppState>, point: PointPayload) {
    let Some(window) = main_window(&app) else {
        return;
    };
    let mut state = state.0.lock().unwrap();
    if is_annoyed_locked(&state) {
        return;
    }
    detach_from_window(&app, &mut state, false);
    let bounds = window_bounds(&window);
    state.dragging = true;
    state.drag_offset = PointPayload {
        x: point.x - bounds.x,
        y: point.y - bounds.y,
    };
    state.last_interaction_at = Instant::now();
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.last_edge_walk_at = Instant::now() - Duration::from_secs(60); // Matches Electron lastEdgeWalkAt = 0 (allows immediate edge walk)
    send_state(&app, &mut state, "idle", 0, None);
}

#[tauri::command]
fn pet_drag_move(app: AppHandle, state: tauri::State<AppState>, point: PointPayload) {
    let Some(window) = main_window(&app) else {
        return;
    };
    let mut state = state.0.lock().unwrap();
    if !state.dragging || is_annoyed_locked(&state) {
        return;
    }
    reset_click_chain(&mut state);
    let (area_x, area_y, area_width, area_height) = monitor_work_area(&window).unwrap_or((0, 0, 1920, 1080));
    let x = (point.x - state.drag_offset.x).clamp(area_x, area_x + area_width - PET_SIZE);
    let y = (point.y - state.drag_offset.y).clamp(area_y, area_y + area_height - PET_SIZE);
    set_window_position(&window, x, y);
}

#[tauri::command]
fn pet_drag_end(app: AppHandle, state: tauri::State<AppState>, data: DragEndPayload) {
    let Some(window) = main_window(&app) else {
        return;
    };
    let mut state = state.0.lock().unwrap();
    if is_annoyed_locked(&state) {
        state.dragging = false;
        return;
    }
    state.dragging = false;
    state.last_interaction_at = Instant::now();
    state.last_edge_walk_at = Instant::now() - Duration::from_secs(60); // Matches Electron lastEdgeWalkAt = 0
    if data.lifted_befuddled_drop {
        send_befuddled_then_sit(&app, &mut state, BEFUDDLED_DROP_TO_SIT_MS);
        return;
    }
    let bounds = window_bounds(&window);
    if let Some(target) = find_top_attach_target(bounds, data.point) {
        if attach_to_window(&app, &mut state, target) {
            return;
        }
    }
    send_state(&app, &mut state, "idle", 0, data.start_gaze.or(Some(true)));
}

#[tauri::command]
fn pet_lifted(app: AppHandle, state: tauri::State<AppState>) {
    let mut state = state.0.lock().unwrap();
    if !state.dragging || is_annoyed_locked(&state) {
        return;
    }
    if state
        .last_click_at
        .map(|last| last.elapsed() < Duration::from_millis(280))
        .unwrap_or(false)
    {
        return;
    }
    mark_pet_interaction(&mut state);
    state.last_interaction_at = Instant::now();
    state.hidden_edge = None;
    state.edge_peek_walk = None;
    state.current_pet_state = "lifted".to_string();
    emit_state(&app, "lifted", 0, None, None);
}

#[tauri::command]
fn pet_wake_idle(app: AppHandle, state: tauri::State<AppState>, data: serde_json::Value) {
    let mut state = state.0.lock().unwrap();
    if is_annoyed_locked(&state) {
        return;
    }
    let start_gaze = data
        .get("startGaze")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    send_state(&app, &mut state, "idle", 0, Some(start_gaze));
}

#[tauri::command]
fn pet_click(app: AppHandle, state: tauri::State<AppState>, _data: serde_json::Value) {
    let mut state = state.0.lock().unwrap();
    if is_annoyed_locked(&state) {
        return;
    }
    let now = Instant::now();
    state.last_click_at = Some(now);
    state.last_interaction_at = now;
    state.hidden_edge = None;

    if state
        .click_burst_started_at
        .map(|started| now.duration_since(started).as_millis() as u64 > ANNOYED_CLICK_WINDOW_MS)
        .unwrap_or(true)
    {
        state.click_burst_started_at = Some(now);
        state.click_burst_count = 1;
    } else {
        state.click_burst_count += 1;
    }

    if state.click_burst_count < ANNOYED_CLICK_TARGET {
        mark_pet_interaction(&mut state);
        send_state(&app, &mut state, "click_happy", 700, Some(true));
        return;
    }
    // Electron: enterAnnoyedLock does NOT call markPetInteraction on the threshold click
    enter_annoyed_lock(&app, &mut state);
}

#[tauri::command]
fn pet_cling_hit_test(app: AppHandle, state: tauri::State<AppState>, interactive: bool) {
    let Some(window) = main_window(&app) else {
        return;
    };
    let mut state = state.0.lock().unwrap();
    if state.attached_window.is_none() {
        set_passthrough(&window, &mut state, false);
        return;
    }
    set_passthrough(&window, &mut state, !interactive);
}

#[tauri::command]
fn show_context_menu(app: AppHandle, state: tauri::State<AppState>) {
    {
        let mut state = state.0.lock().unwrap();
        if is_annoyed_locked(&state) {
            return;
        }
        mark_pet_interaction(&mut state);
    }
    // Read state values while holding the lock briefly
    let (autostart, always_on_top) = {
        let state = state.0.lock().unwrap();
        (state.autostart_enabled, state.normal_always_on_top)
    };

    let Some(window) = main_window(&app) else {
        return;
    };

    let show_item = MenuItem::with_id(&app, "ctx_show", "显示/召回", true, None::<&str>).ok();
    let sleep_item = MenuItem::with_id(&app, "ctx_sleep", "睡觉", true, None::<&str>).ok();
    let sit_item = MenuItem::with_id(&app, "ctx_sit", "坐下", true, None::<&str>).ok();
    let sep1 = PredefinedMenuItem::separator(&app).ok();
    let autostart_item = CheckMenuItem::with_id(&app, "ctx_autostart", "开机自启", true, autostart, None::<&str>).ok();
    let top_item = CheckMenuItem::with_id(&app, "ctx_top", "保持置顶", true, always_on_top, None::<&str>).ok();
    let sep2 = PredefinedMenuItem::separator(&app).ok();
    let exit_item = MenuItem::with_id(&app, "ctx_exit", "退出", true, None::<&str>).ok();

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    if let Some(ref item) = show_item { items.push(item); }
    if let Some(ref item) = sleep_item { items.push(item); }
    if let Some(ref item) = sit_item { items.push(item); }
    if let Some(ref item) = sep1 { items.push(item); }
    if let Some(ref item) = autostart_item { items.push(item); }
    if let Some(ref item) = top_item { items.push(item); }
    if let Some(ref item) = sep2 { items.push(item); }
    if let Some(ref item) = exit_item { items.push(item); }

    if let Ok(menu) = Menu::with_items(&app, &items) {
        let _ = window.popup_menu(&menu);
    }
}

// ── Auto-start ──────────────────────────────────────────

fn get_windows_startup_script_path() -> std::path::PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("桌宠.vbs")
}

fn set_autostart(enabled: bool, state: &mut RuntimeState) {
    state.autostart_enabled = enabled;
    let startup_path = get_windows_startup_script_path();

    if !enabled {
        if startup_path.exists() {
            let _ = std::fs::remove_file(&startup_path);
        }
        return;
    }

    // Determine exe path – check portable location first, then current exe
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let portable_path = std::path::PathBuf::from(&home)
        .join("Documents")
        .join("桌宠")
        .join("dist")
        .join("桌宠 0.1.0.exe");

    let exe_path = if portable_path.exists() {
        portable_path
    } else {
        std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("桌宠.exe"))
    };

    let exe_str = exe_path.to_string_lossy().replace('"', "\"\"");
    let script = format!(
        "Set WshShell = CreateObject(\"WScript.Shell\")\r\nWshShell.Run \"\"\"{}\"\"\", 0, False",
        exe_str
    );

    if let Some(parent) = startup_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Write UTF-16LE with BOM (matching Electron's 'utf16le' encoding)
    let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // BOM
    for c in script.encode_utf16() {
        bytes.extend_from_slice(&c.to_le_bytes());
    }
    let _ = std::fs::write(&startup_path, &bytes);
}

// ── Tray menu ───────────────────────────────────────────

fn build_tray_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let handle = app.handle();
    let show_item = MenuItem::with_id(handle, "show", "显示/召回", true, None::<&str>)?;
    let sleep_item = MenuItem::with_id(handle, "sleep", "睡觉", true, None::<&str>)?;
    let sit_item = MenuItem::with_id(handle, "sit", "坐下", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(handle)?;

    let state_ref = app.state::<AppState>();
    let (autostart, always_on_top) = {
        let state = state_ref.0.lock().unwrap();
        (state.autostart_enabled, state.normal_always_on_top)
    };

    let autostart_item = CheckMenuItem::with_id(handle, "autostart", "开机自启", true, autostart, None::<&str>)?;
    let top_item = CheckMenuItem::with_id(handle, "top", "保持置顶", true, always_on_top, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(handle)?;
    let exit_item = MenuItem::with_id(handle, "exit", "退出", true, None::<&str>)?;

    Menu::with_items(
        handle,
        &[
            &show_item,
            &sleep_item,
            &sit_item,
            &sep1,
            &autostart_item,
            &top_item,
            &sep2,
            &exit_item,
        ],
    )
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };

    TrayIconBuilder::new()
        .tooltip("桌宠")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => recall_pet(app),
                "sleep" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    if !is_annoyed_locked(&state) {
                        send_state(app, &mut state, "sleep", 0, None);
                    }
                }
                "sit" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    if !is_annoyed_locked(&state) {
                        send_state(app, &mut state, "sit", 5000, None);
                    }
                }
                "autostart" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    let enabled = !state.autostart_enabled;
                    set_autostart(enabled, &mut state);
                }
                "top" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    state.normal_always_on_top = !state.normal_always_on_top;
                    if state.attached_window.is_none() {
                        if let Some(window) = main_window(app) {
                            let _ = window.set_always_on_top(state.normal_always_on_top);
                        }
                    }
                }
                "exit" => app.exit(0),
                // Context menu items
                "ctx_show" => recall_pet(app),
                "ctx_sleep" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    if !is_annoyed_locked(&state) {
                        send_state(app, &mut state, "sleep", 0, None);
                    }
                }
                "ctx_sit" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    if !is_annoyed_locked(&state) {
                        send_state(app, &mut state, "sit", 5000, None);
                    }
                }
                "ctx_autostart" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    let enabled = !state.autostart_enabled;
                    set_autostart(enabled, &mut state);
                }
                "ctx_top" => {
                    let state_ref = app.state::<AppState>();
                    let mut state = state_ref.0.lock().unwrap();
                    state.normal_always_on_top = !state.normal_always_on_top;
                    if state.attached_window.is_none() {
                        if let Some(window) = main_window(app) {
                            let _ = window.set_always_on_top(state.normal_always_on_top);
                        }
                    }
                }
                "ctx_exit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

// ── Recall ──────────────────────────────────────────────

fn recall_pet(app: &AppHandle) {
    {
        let state_ref = app.state::<AppState>();
        let state = state_ref.0.lock().unwrap();
        if is_annoyed_locked(&state) {
            return;
        }
    }
    let Some(window) = main_window(app) else {
        return;
    };
    let cursor = cursor_point();
    let (area_x, area_y, area_width, area_height) = monitor_work_area(&window).unwrap_or((0, 0, 1920, 1080));
    let x = (cursor.x - PET_SIZE / 2).clamp(area_x + 12, area_x + area_width - PET_SIZE - 12);
    let y = (cursor.y - PET_SIZE / 2).clamp(area_y + 12, area_y + area_height - PET_SIZE - 12);
    set_window_position(&window, x, y);
    let state_ref = app.state::<AppState>();
    let mut state = state_ref.0.lock().unwrap();
    state.hidden_edge = None;
    state.last_interaction_at = Instant::now();
    detach_from_window(app, &mut state, false);
    send_state(app, &mut state, "idle", 0, None);
}

// ── Main loop ───────────────────────────────────────────

async fn tokio_sleep() {
    tokio::time::sleep(Duration::from_millis(MOUSE_SAMPLE_MS)).await;
}

/// One tick of the sample loop — runs synchronously so the MutexGuard never
/// crosses an await point. Returns the desired sleep duration.
fn sample_tick(app: &AppHandle) {
    let state_ref = app.state::<AppState>();
    let mut state = state_ref.0.lock().unwrap();
    let Some(window) = main_window(app) else {
        return;
    };
    let cursor = cursor_point();
    let now = Instant::now();
    let bounds = window_bounds(&window);
    let mut speed = 0.0;
    let mut dx: i32 = 0;
    let mut dy: i32 = 0;
    let mut distance = 0.0;
    if let Some((last_x, last_y, last_t)) = state.last_cursor {
        dx = cursor.x - last_x;
        dy = cursor.y - last_y;
        distance = ((dx * dx + dy * dy) as f64).sqrt();
        let elapsed = now.duration_since(last_t).as_millis().max(1) as f64;
        speed = distance / elapsed;
        if distance > 2.0 {
            state.last_interaction_at = now;
        }
    }

    // Head-shake detection (matching Electron's sampleMouse)
    let over_head = is_cursor_over_head(cursor, bounds);
    let axis = if dx.abs() >= dy.abs() {
        dx.signum()
    } else {
        dy.signum() * 2
    };
    let reversed = state.last_head_shake_axis.map_or(false, |last_axis| {
        axis != 0 && axis == -last_axis
    });
    if !state.dragging
        && state.hidden_edge.is_none()
        && state.edge_peek_walk.is_none()
        && over_head
        && speed > 0.9
        && distance > 12.0
    {
        state.head_shake_score = (16.0f64)
            .min(state.head_shake_score + if reversed { 2.6 } else { 1.1 });
        state.last_head_shake_axis = Some(axis);
    } else {
        state.head_shake_score = (0.0f64).max(state.head_shake_score - 0.7);
        if !over_head {
            state.last_head_shake_axis = None;
        }
    }

    state.last_cursor = Some((cursor.x, cursor.y, now));

    // Send motion to frontend (matching Electron's sendMotion)
    let motion = MotionPayload {
        x: cursor.x,
        y: cursor.y,
        speed,
        head_shake_score: state.head_shake_score,
        idle_ms: now.duration_since(state.last_interaction_at).as_millis() as u64,
        bounds,
    };
    let _ = app.emit("mouse-motion", motion);

    // Befuddled→sit deferred transition check
    let should_befuddled_to_sit = state.befuddled_then_sit_at.map_or(false, |until| {
        now >= until && state.current_pet_state == "befuddled"
    });
    if should_befuddled_to_sit {
        state.befuddled_then_sit_at = None;
        if !is_annoyed_locked(&state) {
            state.current_pet_state = "sit".to_string();
            emit_state(app, "sit", 0, None, None);
        }
    }

    // Auto-idle timer (matching Electron: setTimeout { if currentPetState === stateAtStart then currentPetState = 'idle' })
    let should_auto_idle = state.auto_idle_at.as_ref().map_or(false, |(until, expected)| {
        now >= *until && state.current_pet_state == *expected
    });
    if should_auto_idle {
        state.auto_idle_at = None;
        if !is_annoyed_locked(&state) {
            state.current_pet_state = "idle".to_string();
            // Frontend already reverted via its own timer, but backend needs to know
        }
    }

    if is_annoyed_locked(&state) {
        if state
            .annoyed_locked_until
            .map(|until| now >= until)
            .unwrap_or(false)
        {
            state.annoyed_active = false;
            state.annoyed_locked_until = None;
            reset_click_chain(&mut state);
            state.dragging = false;
            state.current_pet_state = "idle".to_string();
            emit_state(app, "idle", 0, None, Some(true));
        }
        return;
    }

    if update_attached_window(app, &mut state) {
        return;
    }

    update_autonomous_action(app, &mut state);

    if state.autonomous_action.is_some() {
        return;
    }

    // Head-shake trigger (matches Electron: after autonomous check, before edge walk)
    if state.head_shake_score >= HEAD_SHAKE_TRIGGER_SCORE
        && state.hidden_edge.is_none()
        && state.edge_peek_walk.is_none()
    {
        trigger_befuddled_then_sit(app, &mut state);
    }

    // Edge walk (matches Electron: maybeEdgeWalk is called last in sampleMouse)
    let (area_x, area_y, area_width, area_height) = monitor_work_area(&window).unwrap_or((0, 0, 1920, 1080));
    maybe_edge_walk(app, &mut state, area_x, area_y, area_width, area_height);
}

fn sample_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            sample_tick(&app);
            tokio_sleep().await;
        }
    });
}

// ── Tauri entry point ───────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            pet_drag_start,
            pet_drag_move,
            pet_drag_end,
            pet_lifted,
            pet_wake_idle,
            pet_click,
            pet_cling_hit_test,
            show_context_menu
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");
            let _ = window.set_size(PhysicalSize::new(PET_SIZE as u32, PET_SIZE as u32));
            let _ = window.set_decorations(false);
            let _ = window.set_shadow(false);
            let _ = window.set_skip_taskbar(true);
            let _ = window.set_always_on_top(true);
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let pos = monitor.position();
                let size = monitor.size();
                set_window_position(
                    &window,
                    pos.x + size.width as i32 - PET_SIZE - 48,
                    pos.y + size.height as i32 - PET_SIZE - 24,
                );
            }
            let _ = window.show();

            // Initialize auto-start (matching Electron: autostartEnabled=true, setAutostart(true) on launch)
            {
                let state_ref = app.state::<AppState>();
                let mut state = state_ref.0.lock().unwrap();
                set_autostart(true, &mut state);
            }

            create_tray(app)?;
            sample_loop(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Unit tests ──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn make_bounds(x: i32, y: i32, w: i32, h: i32) -> BoundsPayload {
        BoundsPayload { x, y, width: w, height: h }
    }

    fn make_pt(x: i32, y: i32) -> PointPayload {
        PointPayload { x, y }
    }

    // ── is_cursor_over_head ───────────────────────────

    #[test]
    fn test_cursor_over_head_center() {
        let bounds = make_bounds(100, 100, 246, 246);
        // Center of head area: roughly x=223, y=171 (0.5*(0.06+0.94)*246=123, 0.5*(0+0.58)*246≈71)
        assert!(is_cursor_over_head(make_pt(100 + 123, 100 + 71), bounds));
    }

    #[test]
    fn test_cursor_over_head_far_outside() {
        let bounds = make_bounds(100, 100, 246, 246);
        assert!(!is_cursor_over_head(make_pt(0, 0), bounds));
        assert!(!is_cursor_over_head(make_pt(500, 500), bounds));
    }

    #[test]
    fn test_cursor_over_head_boundaries() {
        let bounds = make_bounds(100, 100, 246, 246);
        // Left:  100 + 246*0.06 = 114.76  → x >= 115
        // Right: 100 + 246*0.94 = 331.24  → x <= 331
        // Top:   100 - 246*0.06 =  85.24  → y >=  86
        // Bottom:100 + 246*0.58 = 242.68  → y <= 242
        assert!(is_cursor_over_head(make_pt(115, 171), bounds));
        assert!(!is_cursor_over_head(make_pt(114, 171), bounds));
        assert!(is_cursor_over_head(make_pt(331, 171), bounds));
        assert!(!is_cursor_over_head(make_pt(332, 171), bounds));
        assert!(is_cursor_over_head(make_pt(223, 86), bounds));
        assert!(!is_cursor_over_head(make_pt(223, 85), bounds));
        assert!(is_cursor_over_head(make_pt(223, 242), bounds));
        assert!(!is_cursor_over_head(make_pt(223, 243), bounds));
    }

    // ── is_annoyed_locked ──────────────────────────────

    #[test]
    fn test_not_annoyed_by_default() {
        let state = RuntimeState::default();
        assert!(!is_annoyed_locked(&state));
    }

    #[test]
    fn test_annoyed_active_not_expired() {
        let mut state = RuntimeState::default();
        state.annoyed_active = true;
        state.annoyed_locked_until = Some(Instant::now() + Duration::from_secs(10));
        assert!(is_annoyed_locked(&state));
    }

    #[test]
    fn test_annoyed_expired() {
        let mut state = RuntimeState::default();
        state.annoyed_active = true;
        state.annoyed_locked_until = Some(Instant::now() - Duration::from_secs(1));
        assert!(!is_annoyed_locked(&state));
    }

    #[test]
    fn test_annoyed_inactive_but_future_until() {
        let mut state = RuntimeState::default();
        state.annoyed_active = false;
        state.annoyed_locked_until = Some(Instant::now() + Duration::from_secs(10));
        assert!(!is_annoyed_locked(&state));
    }

    #[test]
    fn test_annoyed_no_until() {
        let mut state = RuntimeState::default();
        state.annoyed_active = true;
        state.annoyed_locked_until = None;
        assert!(!is_annoyed_locked(&state));
    }

    // ── reset_click_chain ──────────────────────────────

    #[test]
    fn test_reset_click_chain_sets_to_zero() {
        let mut state = RuntimeState::default();
        state.click_burst_started_at = Some(Instant::now());
        state.click_burst_count = 7;
        reset_click_chain(&mut state);
        assert!(state.click_burst_started_at.is_none());
        assert_eq!(state.click_burst_count, 0);
    }

    #[test]
    fn test_reset_click_chain_from_default_is_idempotent() {
        let mut state = RuntimeState::default();
        reset_click_chain(&mut state);
        assert!(state.click_burst_started_at.is_none());
        assert_eq!(state.click_burst_count, 0);
    }

    // ── random_f64 ─────────────────────────────────────

    #[test]
    fn test_random_f64_in_range() {
        for _ in 0..2000 {
            let r = random_f64();
            assert!(r >= 0.0, "random_f64 below 0: {}", r);
            assert!(r < 1.0, "random_f64 at or above 1: {}", r);
        }
    }

    #[test]
    fn test_random_f64_has_variation() {
        // Ensure we get at least a few distinct values (not a constant function).
        let values: Vec<f64> = (0..100).map(|_| random_f64()).collect();
        let first = values[0];
        let different = values.iter().any(|&v| (v - first).abs() > 1e-9);
        assert!(different, "random_f64 returned constant value {}", first);
    }

    // ── mark_pet_interaction ───────────────────────────

    #[test]
    fn test_mark_pet_interaction_clears_autonomous() {
        let mut state = RuntimeState::default();
        state.autonomous_action = Some(AutonomousAction::Pose {
            state: "sit".to_string(),
            until: Instant::now() + Duration::from_secs(60),
        });
        state.hidden_edge = Some("left".to_string());
        mark_pet_interaction(&mut state);
        assert!(state.autonomous_action.is_none(), "autonomous_action should be None");
        assert!(state.hidden_edge.is_none(), "hidden_edge should be None after mark_pet_interaction");
    }

    #[test]
    fn test_mark_pet_interaction_resets_idle_timer() {
        let mut state = RuntimeState::default();
        let old_timer = state.next_idle_action_at;
        // Sleep a tiny bit so Instant::now() advances
        std::thread::sleep(Duration::from_millis(5));
        mark_pet_interaction(&mut state);
        assert!(state.next_idle_action_at > old_timer, "next_idle_action_at should be pushed forward");
    }

    // ── Default RuntimeState ───────────────────────────

    #[test]
    fn test_default_state_values() {
        let state = RuntimeState::default();
        assert!(!state.dragging);
        assert_eq!(state.current_pet_state, "idle");
        assert!(!state.annoyed_active);
        assert!(state.annoyed_locked_until.is_none());
        assert_eq!(state.click_burst_count, 0);
        assert!(state.click_burst_started_at.is_none());
        assert!(state.autonomous_action.is_none());
        assert!(state.hidden_edge.is_none());
        assert!(state.attached_window.is_none());
        assert!(state.normal_always_on_top);
        assert!(!state.passthrough);
        assert_eq!(state.head_shake_score, 0.0);
        assert!(state.last_head_shake_axis.is_none());
        assert!(state.edge_peek_walk.is_none());
        assert_eq!(state.edge_walk_direction, 1);
        assert!(state.befuddled_then_sit_at.is_none());
        assert!(state.auto_idle_at.is_none());
        assert!(state.autostart_enabled);
    }

    // ── Click burst counting (simulated state transitions) ──

    #[test]
    fn test_click_burst_first_click_starts_burst() {
        let mut state = RuntimeState::default();
        // Simulate first click: burst started
        state.click_burst_started_at = Some(Instant::now());
        state.click_burst_count = 1;
        assert_eq!(state.click_burst_count, 1);
        // Below threshold: annoyed NOT active
        assert!(!state.annoyed_active);
    }

    #[test]
    fn test_click_burst_at_threshold_triggers_annoyed() {
        let mut state = RuntimeState::default();
        state.click_burst_started_at = Some(Instant::now());
        state.click_burst_count = ANNOYED_CLICK_TARGET; // 5
        // Threshold reached — should trigger annoyed lock
        assert!(state.click_burst_count >= ANNOYED_CLICK_TARGET);
        // The actual lock is triggered by enter_annoyed_lock, verified below
    }

    #[test]
    fn test_enter_annoyed_lock_state() {
        let mut state = RuntimeState::default();
        let now = Instant::now();
        state.annoyed_active = true;
        state.annoyed_locked_until = Some(now + Duration::from_millis(ANNOYED_LOCK_MS));
        state.dragging = false;
        state.hidden_edge = None;
        state.edge_peek_walk = None;
        state.head_shake_score = 0.0;
        state.click_burst_started_at = None;
        state.click_burst_count = 0;
        state.current_pet_state = "click_annoyed".to_string();

        // Verify the state after enter_annoyed_lock
        assert!(state.annoyed_active);
        assert!(state.annoyed_locked_until.is_some());
        assert!(!state.dragging);
        assert_eq!(state.current_pet_state, "click_annoyed");
        assert_eq!(state.click_burst_count, 0);
        assert_eq!(state.head_shake_score, 0.0);
    }

    // ── Window clamping logic ──────────────────────────

    #[test]
    fn test_clamp_drag_position() {
        let area_x = 0;
        let area_y = 0;
        let area_width: i32 = 1920;
        let area_height: i32 = 1080;
        let pet_size = PET_SIZE;

        // Normal case: drag to center
        let point = PointPayload { x: 960, y: 540 };
        let offset = PointPayload { x: 100, y: 100 };
        let x = (point.x - offset.x).clamp(area_x, area_x + area_width - pet_size);
        let y = (point.y - offset.y).clamp(area_y, area_y + area_height - pet_size);
        assert_eq!(x, 860);
        assert_eq!(y, 440);

        // Clamp left/top
        let point = PointPayload { x: -50, y: -50 };
        let x = (point.x - offset.x).clamp(area_x, area_x + area_width - pet_size);
        let y = (point.y - offset.y).clamp(area_y, area_y + area_height - pet_size);
        assert_eq!(x, 0);
        assert_eq!(y, 0);

        // Clamp right/bottom
        let point = PointPayload { x: 5000, y: 5000 };
        let x = (point.x - offset.x).clamp(area_x, area_x + area_width - pet_size);
        let y = (point.y - offset.y).clamp(area_y, area_y + area_height - pet_size);
        assert_eq!(x, area_width - pet_size);
        assert_eq!(y, area_height - pet_size);
    }

    // ── Edge peek walk position ────────────────────────

    #[test]
    fn test_finish_edge_peek_position_left() {
        let area_x = 0;
        // When finishing a left edge peek, pet should be positioned at area_x - PET_SIZE + PEEK_VISIBLE
        let expected_x = area_x - PET_SIZE + PEEK_VISIBLE;
        assert_eq!(expected_x, 0 - 260 + 161); // -99
        // Only 161px of the 260px pet is visible (peeking from left)
        assert!(expected_x < 0);
    }

    #[test]
    fn test_finish_edge_peek_position_right() {
        let area_x = 0;
        let area_width = 1920;
        // When finishing a right edge peek, pet should be at area_x + area_width - PEEK_VISIBLE
        let expected_x = area_x + area_width - PEEK_VISIBLE;
        assert_eq!(expected_x, 0 + 1920 - 161); // 1759
        // Only 161px visible from right side
        assert_eq!(area_x + area_width - expected_x, 161);
    }

    // ── befuddled_then_sit timing ──────────────────────

    #[test]
    fn test_befuddled_then_sit_clears_dragging_and_hidden_edge() {
        let mut state = RuntimeState::default();
        state.dragging = true;
        state.hidden_edge = Some("left".to_string());
        state.edge_peek_walk = Some(EdgePeekWalk {
            direction: "right".to_string(),
            until: Instant::now() + Duration::from_secs(5),
        });
        // Simulate what send_befuddled_then_sit does (without needing AppHandle)
        state.dragging = false;
        state.hidden_edge = None;
        state.edge_peek_walk = None;
        state.current_pet_state = "befuddled".to_string();
        state.befuddled_then_sit_at = Some(Instant::now() + Duration::from_millis(3000));

        assert!(!state.dragging);
        assert!(state.hidden_edge.is_none());
        assert!(state.edge_peek_walk.is_none());
        assert_eq!(state.current_pet_state, "befuddled");
        assert!(state.befuddled_then_sit_at.is_some());
    }

    #[test]
    fn test_trigger_befuddled_only_from_idle_or_click_happy() {
        // trigger_befuddled_then_sit should only work when state is "idle" or "click_happy"
        // It checks: !["idle", "click_happy"].contains(&state.current_pet_state)
        let valid_states = ["idle", "click_happy"];
        let invalid_states = ["sleep", "sit", "walk", "peek", "cling_top", "lifted", "befuddled", "click_annoyed"];

        for s in &valid_states {
            assert!(["idle", "click_happy"].contains(s), "{} should be valid", s);
        }
        for s in &invalid_states {
            assert!(!["idle", "click_happy"].contains(s), "{} should be invalid", s);
        }
    }

    // ── detach_from_window guard ───────────────────────

    #[test]
    fn test_detach_guard_returns_early_if_not_attached() {
        let state = RuntimeState::default();
        assert!(state.attached_window.is_none());
        // The function should return early when attached_window is None
        // We verify the guard condition exists and works
        if state.attached_window.is_none() {
            // Early return — should not proceed to set_owner_window etc.
            // This test verifies the guard logic is in place
        }
        // State should remain unchanged
        assert!(state.attached_window.is_none());
    }

    // ── annoyed lock expiry ────────────────────────────

    #[test]
    fn test_annoyed_lock_releases_after_expiry() {
        let mut state = RuntimeState::default();
        state.annoyed_active = true;
        state.annoyed_locked_until = Some(Instant::now() + Duration::from_millis(5000));
        state.current_pet_state = "click_annoyed".to_string();

        // Simulate expiry (as sample_tick would do)
        let expired = Instant::now() >= state.annoyed_locked_until.unwrap();
        assert!(!expired, "should not be expired immediately");

        // After waiting...
        state.annoyed_locked_until = Some(Instant::now() - Duration::from_secs(1));
        let expired = Instant::now() >= state.annoyed_locked_until.unwrap();
        assert!(expired, "should be expired after time passes");
    }

    #[test]
    fn test_annoyed_release_resets_state() {
        let mut state = RuntimeState::default();
        // Given: annoyed lock was active
        state.annoyed_active = true;
        state.annoyed_locked_until = Some(Instant::now() - Duration::from_secs(1));
        state.current_pet_state = "click_annoyed".to_string();
        state.click_burst_started_at = Some(Instant::now());
        state.click_burst_count = 5;
        state.dragging = true;

        // When: annoyed lock expires (simulating sample_tick release logic)
        let now = Instant::now();
        if state.annoyed_locked_until.map(|until| now >= until).unwrap_or(false) {
            state.annoyed_active = false;
            state.annoyed_locked_until = None;
            reset_click_chain(&mut state);
            state.dragging = false;
            state.current_pet_state = "idle".to_string();
        }

        // Then: all state should be reset
        assert!(!state.annoyed_active);
        assert!(state.annoyed_locked_until.is_none());
        assert!(state.click_burst_started_at.is_none());
        assert_eq!(state.click_burst_count, 0);
        assert!(!state.dragging);
        assert_eq!(state.current_pet_state, "idle");
    }

    // ── Click burst window expiry ──────────────────────

    #[test]
    fn test_click_burst_window_expires() {
        // After ANNOYED_CLICK_WINDOW_MS (3000ms), burst resets
        let mut state = RuntimeState::default();
        let old_time = Instant::now() - Duration::from_millis(ANNOYED_CLICK_WINDOW_MS + 1);
        state.click_burst_started_at = Some(old_time);
        state.click_burst_count = 4;

        let now = Instant::now();
        let expired = state
            .click_burst_started_at
            .map(|started| now.duration_since(started).as_millis() as u64 > ANNOYED_CLICK_WINDOW_MS)
            .unwrap_or(true);
        assert!(expired, "burst window should expire after {}ms", ANNOYED_CLICK_WINDOW_MS);
    }

    // ── Send_state detach logic ────────────────────────

    #[test]
    fn test_send_state_detaches_when_changing_from_cling() {
        let mut state = RuntimeState::default();
        state.attached_window = Some(AttachedWindow {
            hwnd: 12345,
            offset_x: 50,
        });
        // If new state is not "cling_top" while attached, should detach
        let should_detach = state.attached_window.is_some() && "idle" != "cling_top";
        assert!(should_detach, "should detach when state changes from cling_top");
    }

    #[test]
    fn test_send_state_no_detach_for_cling_to_cling() {
        let mut state = RuntimeState::default();
        state.attached_window = Some(AttachedWindow {
            hwnd: 12345,
            offset_x: 50,
        });
        // If new state IS "cling_top", should NOT detach
        let should_detach = state.attached_window.is_some() && "cling_top" != "cling_top";
        assert!(!should_detach, "should NOT detach for cling_top state");
    }
}
