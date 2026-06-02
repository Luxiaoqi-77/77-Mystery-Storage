use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::System::Threading::GetCurrentProcessId;
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
const MOUSE_SAMPLE_MS: u64 = 24;
const CLING_ATTACH_THRESHOLD: i32 = 52;
const CLING_OVERLAP: i32 = 42;
const ANNOYED_LOCK_MS: u64 = 5_000;
const ANNOYED_CLICK_TARGET: u32 = 5;
const ANNOYED_CLICK_WINDOW_MS: u64 = 3_000;

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
        }
    }
}

#[derive(Default)]
struct AppState(Mutex<RuntimeState>);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn emit_state(app: &AppHandle, state: &str, duration_ms: u64, direction: Option<&str>, start_gaze: Option<bool>) {
    let _ = app.emit(
        "pet-state",
        StatePayload {
            state: state.to_string(),
            duration_ms,
            direction: direction.map(ToString::to_string),
            start_gaze,
        },
    );
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
    state.next_idle_action_at = now + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
}

fn set_passthrough(window: &WebviewWindow, state: &mut RuntimeState, enabled: bool) {
    if state.passthrough == enabled {
        return;
    }
    state.passthrough = enabled;
    let _ = window.set_ignore_cursor_events(enabled);
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
    let Some(window) = main_window(app) else {
        return false;
    };
    let bounds = window_bounds(&window);
    state.attached_window = Some(AttachedWindow {
        hwnd: rect.hwnd,
        offset_x: bounds.x - rect.left,
    });
    state.hidden_edge = None;
    state.autonomous_action = None;
    state.current_pet_state = "cling_top".to_string();
    set_passthrough(&window, state, false);
    let _ = window.set_focusable(false);
    set_owner_window(&window, Some(rect.hwnd));
    apply_attached_bounds(&window, state, rect);
    emit_state(app, "cling_top", 0, None, None);
    true
}

fn detach_from_window(app: &AppHandle, state: &mut RuntimeState, to_idle: bool) {
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
    emit_state(app, pet_state, duration_ms, None, start_gaze);
}

fn send_walk(app: &AppHandle, state: &mut RuntimeState, direction: &str, count_as_interaction: bool) {
    if is_annoyed_locked(state) {
        return;
    }
    if count_as_interaction {
        mark_pet_interaction(state);
    }
    state.current_pet_state = "walk".to_string();
    state.last_interaction_at = Instant::now();
    state.hidden_edge = None;
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
    state.autonomous_action = None;
    reset_click_chain(state);
    state.current_pet_state = "click_annoyed".to_string();
    emit_state(app, "click_annoyed", 0, None, None);
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
    let monitor_width = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().width as i32)
        .unwrap_or(1920);
    let ratio = if random_f64() < 0.6 { 0.1 } else { 1.0 / 3.0 };
    let max_distance = (monitor_width as f64 * ratio).floor() as i32;
    state.autonomous_action = Some(AutonomousAction::Walk {
        direction: direction.to_string(),
        origin_x: bounds.x,
        max_distance,
    });
    send_walk(app, state, direction, false);
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
    if state.dragging || state.hidden_edge.is_some() || state.autonomous_action.is_some() || state.current_pet_state != "idle" {
        return;
    }
    if random_f64() < IDLE_NOTHING_CHANCE {
        state.next_idle_action_at = Instant::now() + Duration::from_millis(IDLE_RANDOM_ACTION_MS);
        return;
    }
    let bounds = window_bounds(&window);
    let monitor = window.current_monitor().ok().flatten();
    let (area_x, area_width) = monitor
        .as_ref()
        .map(|m| (m.position().x, m.size().width as i32))
        .unwrap_or((0, 1920));
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
    let monitor = window.current_monitor().ok().flatten();
    let (area_x, area_width, area_y, area_height) = monitor
        .as_ref()
        .map(|m| (m.position().x, m.size().width as i32, m.position().y, m.size().height as i32))
        .unwrap_or((0, 1920, 0, 1080));

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
                send_walk(app, state, direction, false);
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
    mark_pet_interaction(&mut state);
    state.hidden_edge = None;
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
    let monitor = window.current_monitor().ok().flatten();
    let (area_x, area_y, area_width, area_height) = monitor
        .as_ref()
        .map(|m| (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32))
        .unwrap_or((0, 0, 1920, 1080));
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
    mark_pet_interaction(&mut state);
    if data.lifted_befuddled_drop {
        state.current_pet_state = "befuddled".to_string();
        emit_state(&app, "befuddled", 0, None, None);
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
    state.hidden_edge = None;
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
    mark_pet_interaction(&mut state);
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
        send_state(&app, &mut state, "click_happy", 700, Some(true));
        return;
    }
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
fn show_context_menu() {
    // Tauri migration keeps the pet interactive first; a native tray/menu can be added later.
}

fn sample_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            {
                let state_ref = app.state::<AppState>();
                let mut state = state_ref.0.lock().unwrap();
                let Some(window) = main_window(&app) else {
                    drop(state);
                    tokio_sleep().await;
                    continue;
                };
                let cursor = cursor_point();
                let now = Instant::now();
                let bounds = window_bounds(&window);
                let mut speed = 0.0;
                if let Some((last_x, last_y, last_t)) = state.last_cursor {
                    let dx = cursor.x - last_x;
                    let dy = cursor.y - last_y;
                    let distance = ((dx * dx + dy * dy) as f64).sqrt();
                    let elapsed = now.duration_since(last_t).as_millis().max(1) as f64;
                    speed = distance / elapsed;
                    if distance > 2.0 {
                        state.last_interaction_at = now;
                    }
                }
                state.last_cursor = Some((cursor.x, cursor.y, now));
                let _ = app.emit(
                    "mouse-motion",
                    MotionPayload {
                        x: cursor.x,
                        y: cursor.y,
                        speed,
                        head_shake_score: 0.0,
                        idle_ms: now.duration_since(state.last_interaction_at).as_millis() as u64,
                        bounds,
                    },
                );
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
                        emit_state(&app, "idle", 0, None, Some(true));
                    }
                } else if !update_attached_window(&app, &mut state) {
                    update_autonomous_action(&app, &mut state);
                }
            }
            tokio_sleep().await;
        }
    });
}

async fn tokio_sleep() {
    tokio::time::sleep(Duration::from_millis(MOUSE_SAMPLE_MS)).await;
}

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
            sample_loop(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
