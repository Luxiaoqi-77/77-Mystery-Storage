const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage } = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PET_SIZE = 260;
const PEEK_VISIBLE = 161;
const IDLE_RANDOM_ACTION_MS = 1000 * 30;
const IDLE_NOTHING_CHANCE = 0.2;
const EDGE_WALK_MS = 1000 * 18;
const EDGE_PEEK_WALK_MS = 1000;
const AUTONOMOUS_PEEK_REST_MS = 1000 * 60;
const AUTONOMOUS_SIT_MS = 1000 * 60;
const AUTONOMOUS_SLEEP_MS = 1000 * 60 * 2;
const AUTONOMOUS_WALK_STEP = 3;
const CLING_ATTACH_THRESHOLD = 52;
const CLING_OVERLAP = 42;
const CLING_POLL_MS = 24;
const MOUSE_SAMPLE_MS = 60;
const HEAD_SHAKE_TRIGGER_SCORE = 9;
const ANNOYED_LOCK_MS = 5000;
const ANNOYED_CLICK_TARGET = 5;
const ANNOYED_CLICK_WINDOW_MS = 3000;

let win;
let tray;
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let lastCursor = null;
let lastInteractionAt = Date.now();
let lastPetInteractionAt = Date.now();
let headShakeScore = 0;
let lastHeadShakeAxis = null;
let lastBefuddledAt = 0;
let hiddenEdge = null;
let edgePeekWalk = null;
let edgeWalkDirection = 1;
let lastEdgeWalkAt = 0;
let autostartEnabled = true;
let currentPetState = 'idle';
let annoyedActive = false;
let annoyedReleaseTimer = null;
let annoyedLockedUntil = 0;
let clickBurstStartedAt = 0;
let clickBurstCount = 0;
let autonomousAction = null;
let nextIdleActionAt = Date.now() + IDLE_RANDOM_ACTION_MS;
let attachedWindow = null;
let lastClingPollAt = 0;
let clingTracker = null;
let clingTrackerBuffer = '';
let cachedVisibleWindows = [];
let windowListTracker = null;
let windowListTrackerBuffer = '';
let petMousePassthrough = false;
let normalAlwaysOnTop = true;

function assetPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function isAnnoyedLocked() {
  return annoyedActive && Date.now() < annoyedLockedUntil;
}

function resetClickChain() {
  clickBurstStartedAt = 0;
  clickBurstCount = 0;
}

function sendIdleFromMain() {
  if (!win) return;
  currentPetState = 'idle';
  win.webContents.send('pet-state', { state: 'idle', durationMs: 0 });
}

function scheduleNextIdleAction(delayMs = IDLE_RANDOM_ACTION_MS) {
  nextIdleActionAt = Date.now() + delayMs;
}

function cancelAutonomousAction(options = {}) {
  autonomousAction = null;
  if (options.clearPeek) hiddenEdge = null;
  if (options.toIdle) sendIdleFromMain();
  scheduleNextIdleAction();
}

function markPetInteraction() {
  lastPetInteractionAt = Date.now();
  cancelAutonomousAction({ clearPeek: true });
}

function runWindowQuery(script, timeout = 900) {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true }
    ).trim();
    if (!output) return null;
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function runPowerShell(script, timeout = 900) {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true }
    );
    return true;
  } catch {
    return false;
  }
}

function getWindowApiScript() {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinPetApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
`;
}

function getPetNativeHandleInt() {
  if (!win) return 0;
  const handle = win.getNativeWindowHandle();
  return Number(handle.readBigUInt64LE(0));
}

function setPetOwnerWindow(ownerHwnd) {
  const petHwnd = getPetNativeHandleInt();
  if (!petHwnd || process.platform !== 'win32') return;
  const owner = ownerHwnd ? Number(ownerHwnd) : 0;
  const script = `${getWindowApiScript()}
$pet = [IntPtr]${petHwnd}
$owner = [IntPtr]${owner}
[WinPetApi]::SetWindowLongPtr($pet, -8, $owner) | Out-Null
if ($owner -ne [IntPtr]::Zero) {
  [WinPetApi]::SetWindowPos($pet, $owner, 0, 0, 0, 0, 0x0013) | Out-Null
}
`;
  runPowerShell(script, 700);
}

function getVisibleWindows() {
  const script = `${getWindowApiScript()}
$items = New-Object System.Collections.ArrayList
[WinPetApi]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [WinPetApi]::IsWindowVisible($hWnd)) { return $true }
  if ([WinPetApi]::GetWindowTextLength($hWnd) -le 0) { return $true }
  [uint32]$processId = 0
  [WinPetApi]::GetWindowThreadProcessId($hWnd, [ref]$processId) | Out-Null
  if ($processId -eq ${process.pid}) { return $true }
  $rect = New-Object RECT
  if (-not [WinPetApi]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 180 -or $height -lt 120) { return $true }
  [void]$items.Add([pscustomobject]@{
    hwnd = $hWnd.ToInt64()
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    width = $width
    height = $height
    topmost = (([WinPetApi]::GetWindowLong($hWnd, -20) -band 8) -ne 0)
  })
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;
  const result = runWindowQuery(script, 1200);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

function stopWindowListTracker() {
  if (windowListTracker) {
    windowListTracker.removeAllListeners();
    windowListTracker.kill();
    windowListTracker = null;
  }
  windowListTrackerBuffer = '';
}

function handleWindowListLine(line) {
  if (!line.trim()) return;
  try {
    const parsed = JSON.parse(line);
    cachedVisibleWindows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    cachedVisibleWindows = [];
  }
}

function startWindowListTracker() {
  if (process.platform !== 'win32' || windowListTracker) return;
  const script = `${getWindowApiScript()}
while ($true) {
  $items = New-Object System.Collections.ArrayList
  [WinPetApi]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [WinPetApi]::IsWindowVisible($hWnd)) { return $true }
    if ([WinPetApi]::GetWindowTextLength($hWnd) -le 0) { return $true }
    [uint32]$processId = 0
    [WinPetApi]::GetWindowThreadProcessId($hWnd, [ref]$processId) | Out-Null
    if ($processId -eq ${process.pid}) { return $true }
    $rect = New-Object RECT
    if (-not [WinPetApi]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 180 -or $height -lt 120) { return $true }
    [void]$items.Add([pscustomobject]@{
      hwnd = $hWnd.ToInt64()
      left = $rect.Left
      top = $rect.Top
      right = $rect.Right
      bottom = $rect.Bottom
      width = $width
      height = $height
      topmost = (([WinPetApi]::GetWindowLong($hWnd, -20) -band 8) -ne 0)
    })
    return $true
  }, [IntPtr]::Zero) | Out-Null
  $items | ConvertTo-Json -Compress
  Start-Sleep -Milliseconds 220
}
`;
  windowListTracker = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  windowListTracker.stdout.on('data', (chunk) => {
    windowListTrackerBuffer += chunk.toString('utf8');
    const lines = windowListTrackerBuffer.split(/\r?\n/);
    windowListTrackerBuffer = lines.pop() || '';
    lines.forEach(handleWindowListLine);
  });
  windowListTracker.on('exit', () => {
    windowListTracker = null;
  });
}

function getWindowRectByHandle(hwnd) {
  const script = `${getWindowApiScript()}
$hWnd = [IntPtr]${Number(hwnd)}
$rect = New-Object RECT
if (([WinPetApi]::IsWindowVisible($hWnd)) -and ([WinPetApi]::GetWindowRect($hWnd, [ref]$rect)) -and ($rect.Right -gt $rect.Left) -and ($rect.Bottom -gt $rect.Top)) {
  [pscustomobject]@{
    hwnd = $hWnd.ToInt64()
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
    topmost = (([WinPetApi]::GetWindowLong($hWnd, -20) -band 8) -ne 0)
  } | ConvertTo-Json -Compress
}
`;
  return runWindowQuery(script, 700);
}

function findTopAttachTarget(bounds, point) {
  const petLeft = bounds.x;
  const petRight = bounds.x + bounds.width;
  const petBottom = bounds.y + bounds.height;
  const centerX = bounds.x + bounds.width / 2;
  const candidates = cachedVisibleWindows.length ? cachedVisibleWindows : getVisibleWindows();

  return candidates
    .map((candidate) => {
      const overlap = Math.min(petRight, candidate.right) - Math.max(petLeft, candidate.left);
      const topDistance = Math.abs(petBottom - candidate.top);
      const pointerTopDistance = point ? Math.abs(point.y - candidate.top) : Number.POSITIVE_INFINITY;
      const centerInside = centerX >= candidate.left - 24 && centerX <= candidate.right + 24;
      const pointerInside = point && point.x >= candidate.left - 24 && point.x <= candidate.right + 24;
      const nearTop = topDistance <= CLING_ATTACH_THRESHOLD || pointerTopDistance <= CLING_ATTACH_THRESHOLD;
      return {
        ...candidate,
        score: Math.min(topDistance, pointerTopDistance) - overlap / 20,
        overlap,
        centerInside,
        pointerInside,
        nearTop
      };
    })
    .filter((candidate) => candidate.nearTop && candidate.overlap > 48 && (candidate.centerInside || candidate.pointerInside))
    .sort((a, b) => a.score - b.score)[0] || null;
}

function setAttachedWindowBounds(rect) {
  if (!win) return;
  const fallbackOffsetX = Math.round((rect.width - PET_SIZE) / 2);
  const offsetX = attachedWindow?.offsetX ?? fallbackOffsetX;
  const minOffsetX = -PET_SIZE + 42;
  const maxOffsetX = rect.width - 42;
  const x = Math.round(rect.left + Math.min(Math.max(offsetX, minOffsetX), maxOffsetX));
  const y = Math.round(rect.top - PET_SIZE + CLING_OVERLAP);
  win.setBounds({ x, y, width: PET_SIZE, height: PET_SIZE });
  win.setAlwaysOnTop(Boolean(rect.topmost), 'screen-saver');
}

function setPetMousePassthrough(enabled) {
  if (!win || petMousePassthrough === enabled) return;
  petMousePassthrough = enabled;
  win.setIgnoreMouseEvents(enabled, { forward: true });
}

function stopClingTracker() {
  if (clingTracker) {
    clingTracker.removeAllListeners();
    clingTracker.kill();
    clingTracker = null;
  }
  clingTrackerBuffer = '';
}

function handleClingTrackerLine(line) {
  if (!attachedWindow || !line.trim()) return;
  let rect;
  try {
    rect = JSON.parse(line);
  } catch {
    return;
  }
  if (!rect.visible || rect.width < 180 || rect.height < 80) {
    detachFromWindow({ toIdle: true });
    return;
  }
  setAttachedWindowBounds(rect);
}

function startClingTracker(hwnd) {
  stopClingTracker();
  if (process.platform !== 'win32') return;
  const script = `${getWindowApiScript()}
$hWnd = [IntPtr]${Number(hwnd)}
while ($true) {
  $rect = New-Object RECT
  $visible = [WinPetApi]::IsWindowVisible($hWnd)
  if ($visible -and [WinPetApi]::GetWindowRect($hWnd, [ref]$rect)) {
    [pscustomobject]@{
      hwnd = $hWnd.ToInt64()
      left = $rect.Left
      top = $rect.Top
      right = $rect.Right
      bottom = $rect.Bottom
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
      topmost = (([WinPetApi]::GetWindowLong($hWnd, -20) -band 8) -ne 0)
      visible = $true
    } | ConvertTo-Json -Compress
  } else {
    [pscustomobject]@{ visible = $false } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds ${CLING_POLL_MS}
}
`;
  clingTracker = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  clingTracker.stdout.on('data', (chunk) => {
    clingTrackerBuffer += chunk.toString('utf8');
    const lines = clingTrackerBuffer.split(/\r?\n/);
    clingTrackerBuffer = lines.pop() || '';
    lines.forEach(handleClingTrackerLine);
  });
  clingTracker.on('exit', () => {
    clingTracker = null;
  });
}

function attachToWindow(rect) {
  if (!win || isAnnoyedLocked()) return false;
  const bounds = win.getBounds();
  attachedWindow = { hwnd: rect.hwnd, offsetX: Math.round(bounds.x - rect.left) };
  hiddenEdge = null;
  edgePeekWalk = null;
  autonomousAction = null;
  currentPetState = 'cling_top';
  lastClingPollAt = Date.now();
  setPetMousePassthrough(false);
  win.setFocusable(false);
  setPetOwnerWindow(rect.hwnd);
  setAttachedWindowBounds(rect);
  startClingTracker(rect.hwnd);
  win.webContents.send('pet-state', { state: 'cling_top', durationMs: 0 });
  scheduleNextIdleAction();
  return true;
}

function detachFromWindow(options = {}) {
  if (!attachedWindow) return;
  attachedWindow = null;
  lastClingPollAt = 0;
  stopClingTracker();
  setPetOwnerWindow(0);
  setPetMousePassthrough(false);
  win.setFocusable(true);
  win.setAlwaysOnTop(normalAlwaysOnTop, 'screen-saver');
  if (options.toIdle) sendIdleFromMain();
  scheduleNextIdleAction();
}

function updateAttachedWindow(now) {
  if (!attachedWindow || !win) return false;
  if (clingTracker) return true;
  if (now - lastClingPollAt < CLING_POLL_MS) return true;
  lastClingPollAt = now;
  const rect = getWindowRectByHandle(attachedWindow.hwnd);
  if (!rect || rect.width < 180 || rect.height < 80) {
    detachFromWindow({ toIdle: true });
    return false;
  }
  setAttachedWindowBounds(rect);
  return true;
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;

  win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x: area.x + area.width - PET_SIZE - 48,
    y: area.y + area.height - PET_SIZE - 24,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(assetPath('assets', 'pet', 'base_idle.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('桌宠');
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示/召回',
      click: () => recallPet()
    },
    {
      label: '睡觉',
      click: () => sendState('sleep', 0)
    },
    {
      label: '坐下',
      click: () => sendState('sit', 5000)
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autostartEnabled,
      click: (item) => {
        autostartEnabled = item.checked;
        setAutostart(autostartEnabled);
      }
    },
    {
      label: '保持置顶',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        normalAlwaysOnTop = item.checked;
        if (win && !attachedWindow) win.setAlwaysOnTop(item.checked, 'screen-saver');
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit()
    }
  ]);
}

function setAutostart(enabled) {
  if (process.platform === 'win32') {
    setWindowsStartupScript(enabled);
    return;
  }

  const loginSettings = {
    openAtLogin: enabled,
    path: process.execPath
  };

  if (!app.isPackaged) {
    loginSettings.args = [app.getAppPath()];
  }

  app.setLoginItemSettings(loginSettings);
}

function getWindowsStartupScriptPath() {
  return path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    '桌宠.vbs'
  );
}

function setWindowsStartupScript(enabled) {
  const startupScriptPath = getWindowsStartupScriptPath();
  if (!enabled) {
    if (fs.existsSync(startupScriptPath)) fs.unlinkSync(startupScriptPath);
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
    return;
  }

  const localPortablePath = path.join(os.homedir(), 'Documents', '桌宠', 'dist', '桌宠 0.1.0.exe');
  const exePath = fs.existsSync(localPortablePath)
    ? localPortablePath
    : app.isPackaged
      ? (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath)
      : path.join(__dirname, '..', 'dist', '桌宠 0.1.0.exe');
  const escapedExePath = exePath.replace(/"/g, '""');
  const script = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${escapedExePath}""", 0, False`
  ].join('\r\n');

  fs.mkdirSync(path.dirname(startupScriptPath), { recursive: true });
  fs.writeFileSync(startupScriptPath, `\uFEFF${script}`, 'utf16le');
  app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
}

function sendState(state, durationMs, options = {}) {
  if (!win) return;
  if (isAnnoyedLocked() && state !== 'idle') return;
  if (attachedWindow && state !== 'cling_top') detachFromWindow();
  currentPetState = state;
  if (options.countAsInteraction !== false) markPetInteraction();
  lastInteractionAt = Date.now();
  hiddenEdge = null;
  if (state !== 'click_annoyed') {
    annoyedActive = false;
    annoyedLockedUntil = 0;
    if (annoyedReleaseTimer) {
      clearTimeout(annoyedReleaseTimer);
      annoyedReleaseTimer = null;
    }
  }
  win.webContents.send('pet-state', { state, durationMs, startGaze: Boolean(options.startGaze) });
  if (durationMs > 0) {
    const stateAtStart = state;
    setTimeout(() => {
      if (currentPetState === stateAtStart) currentPetState = 'idle';
    }, durationMs);
  }
}

function scheduleAnnoyedRelease() {
  if (annoyedReleaseTimer) clearTimeout(annoyedReleaseTimer);
  annoyedReleaseTimer = setTimeout(() => {
    annoyedActive = false;
    annoyedLockedUntil = 0;
    annoyedReleaseTimer = null;
    resetClickChain();
    dragging = false;
    currentPetState = 'idle';
    win.webContents.send('pet-state', { state: 'idle', durationMs: 0, startGaze: true });
  }, ANNOYED_LOCK_MS);
}

function enterAnnoyedLock() {
  annoyedActive = true;
  annoyedLockedUntil = Date.now() + ANNOYED_LOCK_MS;
  dragging = false;
  hiddenEdge = null;
  edgePeekWalk = null;
  headShakeScore = 0;
  resetClickChain();
  currentPetState = 'click_annoyed';
  win.webContents.send('pet-state', { state: 'click_annoyed', durationMs: 0 });
  scheduleAnnoyedRelease();
}

function isCursorOverHead(cursor, bounds) {
  if (!bounds) return false;
  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  return localX >= bounds.width * 0.06
    && localX <= bounds.width * 0.94
    && localY >= -bounds.height * 0.06
    && localY <= bounds.height * 0.58;
}

function triggerBefuddledThenSit() {
  if (!win || isAnnoyedLocked()) return;
  if (!['idle', 'click_happy'].includes(currentPetState)) return;
  const now = Date.now();
  if (now - lastBefuddledAt < 7000) return;
  lastBefuddledAt = now;
  headShakeScore = 0;
  lastHeadShakeAxis = null;
  dragging = false;
  hiddenEdge = null;
  edgePeekWalk = null;
  currentPetState = 'befuddled';
  win.webContents.send('pet-state', { state: 'befuddled', durationMs: 0 });
  setTimeout(() => {
    if (!win || isAnnoyedLocked()) return;
    if (currentPetState !== 'befuddled') return;
    currentPetState = 'sit';
    win.webContents.send('pet-state', { state: 'sit', durationMs: 0 });
  }, 3500);
}

function sendBefuddledThenSit(durationMs) {
  if (!win || isAnnoyedLocked()) return;
  dragging = false;
  hiddenEdge = null;
  edgePeekWalk = null;
  currentPetState = 'befuddled';
  win.webContents.send('pet-state', { state: 'befuddled', durationMs: 0 });
  setTimeout(() => {
    if (!win || isAnnoyedLocked()) return;
    if (currentPetState !== 'befuddled') return;
    currentPetState = 'sit';
    win.webContents.send('pet-state', { state: 'sit', durationMs: 0 });
  }, durationMs);
}

function sendWalk(direction, durationMs, options = {}) {
  if (!win) return;
  if (isAnnoyedLocked()) return;
  currentPetState = 'walk';
  if (options.countAsInteraction !== false) markPetInteraction();
  lastInteractionAt = Date.now();
  if (options.clearPeek !== false) hiddenEdge = null;
  win.webContents.send('pet-state', { state: 'walk', direction, durationMs });
}

function sendPeek(direction) {
  if (!win) return;
  if (isAnnoyedLocked()) return;
  currentPetState = 'peek';
  win.webContents.send('pet-state', { state: 'peek', direction, durationMs: 0 });
}

function sendMotion(payload) {
  if (win) win.webContents.send('mouse-motion', payload);
}

function recallPet() {
  if (!win) return;
  if (isAnnoyedLocked()) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const M = 12;
  const targetX = Math.min(Math.max(cursor.x - PET_SIZE / 2, area.x + M), area.x + area.width - PET_SIZE - M);
  const targetY = Math.min(Math.max(cursor.y - PET_SIZE / 2, area.y + M), area.y + area.height - PET_SIZE - M);
  win.setBounds({ x: Math.round(targetX), y: Math.round(targetY), width: PET_SIZE, height: PET_SIZE });
  hiddenEdge = null;
  lastInteractionAt = Date.now();
  sendState('idle', 0);
}

function startEdgePeekWalk(direction) {
  if (!win || edgePeekWalk || hiddenEdge) return;
  if (isAnnoyedLocked()) return;
  edgePeekWalk = {
    direction,
    until: Date.now() + EDGE_PEEK_WALK_MS
  };
  lastEdgeWalkAt = Date.now();
  sendWalk(direction, 0);
}

function finishEdgePeekWalk(area) {
  if (!win || !edgePeekWalk) return;
  const direction = edgePeekWalk.direction;
  const bounds = win.getBounds();
  const next = { ...bounds };
  next.x = direction === 'left' ? area.x - PET_SIZE + PEEK_VISIBLE : area.x + area.width - PEEK_VISIBLE;
  next.y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - PET_SIZE);
  win.setBounds(next);
  hiddenEdge = direction;
  edgePeekWalk = null;
  sendPeek(direction);
}

function startAutonomousWalk(direction) {
  if (!win || isAnnoyedLocked()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const distanceRatio = Math.random() < 0.6 ? 1 / 10 : 1 / 3;
  const maxDistance = Math.floor(display.workArea.width * distanceRatio);
  autonomousAction = { type: 'walk', direction, originX: bounds.x, maxDistance };
  sendWalk(direction, 0, { countAsInteraction: false });
}

function startAutonomousPose(state) {
  if (!win || isAnnoyedLocked()) return;
  const durationMs = state === 'sit' ? AUTONOMOUS_SIT_MS : AUTONOMOUS_SLEEP_MS;
  autonomousAction = { type: 'pose', state, until: Date.now() + durationMs };
  currentPetState = state;
  hiddenEdge = null;
  win.webContents.send('pet-state', { state, durationMs: 0 });
}

function getNearestEdgeDirection(bounds, area) {
  const leftDistance = Math.max(0, bounds.x - area.x);
  const rightDistance = Math.max(0, area.x + area.width - (bounds.x + bounds.width));
  return leftDistance <= rightDistance ? 'left' : 'right';
}

function isNearHorizontalEdge(bounds, area) {
  const threshold = area.width / 6;
  const leftDistance = Math.max(0, bounds.x - area.x);
  const rightDistance = Math.max(0, area.x + area.width - (bounds.x + bounds.width));
  return Math.min(leftDistance, rightDistance) <= threshold;
}

function chooseRandomIdleAction(bounds, area) {
  const nearEdge = isNearHorizontalEdge(bounds, area);
  const walkChance = nearEdge ? 0.4 : 0.2;
  const sitChance = nearEdge ? 0.225 : 0.3;
  const actionRoll = Math.random();
  if (actionRoll < IDLE_NOTHING_CHANCE) return { type: 'nothing' };

  const roll = Math.random();

  if (roll < walkChance) {
    return {
      type: 'walk',
      direction: nearEdge
        ? getNearestEdgeDirection(bounds, area)
        : Math.random() < 0.5 ? 'left' : 'right'
    };
  }
  if (roll < walkChance + sitChance) return { type: 'sit' };
  return { type: 'sleep' };
}

function startRandomIdleAction() {
  if (!win || dragging || hiddenEdge || edgePeekWalk || autonomousAction) return;
  if (isAnnoyedLocked()) return;
  if (currentPetState !== 'idle') return;

  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const action = chooseRandomIdleAction(bounds, display.workArea);
  if (action.type === 'nothing') {
    scheduleNextIdleAction();
    return;
  }
  if (action.type === 'walk') {
    startAutonomousWalk(action.direction);
    return;
  }
  startAutonomousPose(action.type);
}

function finishAutonomousPeek(edge) {
  const direction = edge === 'left' ? 'right' : 'left';
  autonomousAction = { type: 'leave-peek', direction };
  sendWalk(direction, 0, { countAsInteraction: false, clearPeek: false });
}

function updateAutonomousAction(now) {
  if (!win || dragging || isAnnoyedLocked()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;

  if (!autonomousAction) {
    if (now - lastPetInteractionAt >= IDLE_RANDOM_ACTION_MS && now >= nextIdleActionAt) {
      startRandomIdleAction();
    }
    return;
  }

  if (autonomousAction.type === 'pose') {
    if (now >= autonomousAction.until) {
      cancelAutonomousAction({ toIdle: true });
    }
    return;
  }

  if (autonomousAction.type === 'peek-rest') {
    if (now >= autonomousAction.until) finishAutonomousPeek(autonomousAction.edge);
    return;
  }

  const direction = autonomousAction.direction;
  const dx = direction === 'left' ? -AUTONOMOUS_WALK_STEP : AUTONOMOUS_WALK_STEP;
  const next = { ...bounds, x: bounds.x + dx };

  if (autonomousAction.type === 'walk') {
    const reachesLeft = next.x <= area.x - PET_SIZE + PEEK_VISIBLE;
    const reachesRight = next.x + PET_SIZE >= area.x + area.width + PET_SIZE - PEEK_VISIBLE;
    const walkedDistance = Math.abs(next.x - autonomousAction.originX);
    if (direction === 'left' && reachesLeft) {
      next.x = area.x - PET_SIZE + PEEK_VISIBLE;
      win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
      hiddenEdge = 'left';
      autonomousAction = { type: 'peek-rest', edge: 'left', until: now + AUTONOMOUS_PEEK_REST_MS };
      sendPeek('left');
      return;
    }
    if (direction === 'right' && reachesRight) {
      next.x = area.x + area.width - PEEK_VISIBLE;
      win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
      hiddenEdge = 'right';
      autonomousAction = { type: 'peek-rest', edge: 'right', until: now + AUTONOMOUS_PEEK_REST_MS };
      sendPeek('right');
      return;
    }
    if (walkedDistance >= autonomousAction.maxDistance) {
      const limitedX = autonomousAction.originX + (direction === 'left' ? -autonomousAction.maxDistance : autonomousAction.maxDistance);
      const minX = area.x + 12;
      const maxX = area.x + area.width - PET_SIZE - 12;
      next.x = Math.min(Math.max(limitedX, minX), maxX);
      win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
      cancelAutonomousAction({ toIdle: true });
      return;
    }
    win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
    return;
  }

  if (autonomousAction.type === 'leave-peek') {
    const fullyInsideLeft = direction === 'right' && next.x >= area.x + 12;
    const fullyInsideRight = direction === 'left' && next.x + PET_SIZE <= area.x + area.width - 12;
    if (fullyInsideLeft || fullyInsideRight) {
      next.x = direction === 'right' ? area.x + 12 : area.x + area.width - PET_SIZE - 12;
      win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
      hiddenEdge = null;
      cancelAutonomousAction({ toIdle: true });
      return;
    }
    win.setBounds({ x: Math.round(next.x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
  }
}

function maybeEdgeWalk() {
  if (!win || dragging) return;
  if (isAnnoyedLocked()) return;
  if (autonomousAction) return;
  const now = Date.now();
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;

  if (edgePeekWalk) {
    if (now >= edgePeekWalk.until) {
      finishEdgePeekWalk(area);
      return;
    }
    const S = 4;
    const dx = edgePeekWalk.direction === 'left' ? -S : S;
    const minX = area.x - PET_SIZE + PEEK_VISIBLE;
    const maxX = area.x + area.width - PEEK_VISIBLE;
    const x = Math.min(Math.max(bounds.x + dx, minX), maxX);
    win.setBounds({ x: Math.round(x), y: bounds.y, width: PET_SIZE, height: PET_SIZE });
    return;
  }

  if (hiddenEdge) return;

  const P = 2;
  const nearLeft = bounds.x <= area.x + P;
  const nearRight = bounds.x + bounds.width >= area.x + area.width - P;
  const nearEdge = nearLeft || nearRight;

  if (!nearEdge) return;
  if (now - lastEdgeWalkAt > EDGE_WALK_MS) {
    edgeWalkDirection = nearLeft ? -1 : 1;
    startEdgePeekWalk(edgeWalkDirection < 0 ? 'left' : 'right');
  }
}

function sampleMouse() {
  const cursor = screen.getCursorScreenPoint();
  const now = Date.now();
  let speed = 0;
  const bounds = win ? win.getBounds() : null;
  if (lastCursor) {
    const dx = cursor.x - lastCursor.x;
    const dy = cursor.y - lastCursor.y;
    speed = Math.hypot(dx, dy) / Math.max(1, now - lastCursor.t);
    if (Math.hypot(dx, dy) > 2) lastInteractionAt = now;

    const overHead = isCursorOverHead(cursor, bounds);
    const axis = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : Math.sign(dy) * 2;
    const reversed = lastHeadShakeAxis !== null && axis !== 0 && axis === -lastHeadShakeAxis;
    if (!dragging && !hiddenEdge && !edgePeekWalk && overHead && speed > 0.9 && Math.hypot(dx, dy) > 12) {
      headShakeScore = Math.min(16, headShakeScore + (reversed ? 2.6 : 1.1));
      lastHeadShakeAxis = axis;
    } else {
      headShakeScore = Math.max(0, headShakeScore - 0.7);
      if (!overHead) lastHeadShakeAxis = null;
    }
  }
  lastCursor = { ...cursor, t: now };

  sendMotion({
    x: cursor.x,
    y: cursor.y,
    speed,
    headShakeScore,
    idleMs: now - lastInteractionAt,
    bounds
  });

  if (isAnnoyedLocked()) {
    return;
  }

  if (updateAttachedWindow(now)) return;

  updateAutonomousAction(now);
  if (autonomousAction) return;

  if (headShakeScore >= HEAD_SHAKE_TRIGGER_SCORE && !hiddenEdge && !edgePeekWalk) {
    triggerBefuddledThenSit();
  }

  maybeEdgeWalk();
}

ipcMain.on('pet-drag-start', (_event, point) => {
  if (!win) return;
  if (isAnnoyedLocked()) return;
  detachFromWindow();
  const bounds = win.getBounds();
  dragging = true;
  dragOffset = { x: point.x - bounds.x, y: point.y - bounds.y };
  lastInteractionAt = Date.now();
  hiddenEdge = null;
  edgePeekWalk = null;
  lastEdgeWalkAt = 0;
  sendState('idle', 0);
});

ipcMain.on('pet-drag-move', (_event, point) => {
  if (!win || !dragging) return;
  if (isAnnoyedLocked()) return;
  resetClickChain();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const x = Math.min(Math.max(point.x - dragOffset.x, area.x), area.x + area.width - PET_SIZE);
  const y = Math.min(Math.max(point.y - dragOffset.y, area.y), area.y + area.height - PET_SIZE);
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: PET_SIZE, height: PET_SIZE });
});

ipcMain.on('pet-drag-end', (_event, data = {}) => {
  if (isAnnoyedLocked()) {
    dragging = false;
    return;
  }
  dragging = false;
  lastInteractionAt = Date.now();
  lastEdgeWalkAt = 0;
  if (data.liftedBefuddledDrop) {
    sendBefuddledThenSit(3000);
    return;
  }
  const attachTarget = findTopAttachTarget(win.getBounds(), data.point);
  if (attachTarget && attachToWindow(attachTarget)) return;
  sendState('idle', 0, { startGaze: data.startGaze !== false });
});

ipcMain.on('pet-lifted', () => {
  if (isAnnoyedLocked()) return;
  if (!dragging) return;
  markPetInteraction();
  lastInteractionAt = Date.now();
  hiddenEdge = null;
  edgePeekWalk = null;
  currentPetState = 'lifted';
  win.webContents.send('pet-state', { state: 'lifted', durationMs: 0 });
});

ipcMain.on('pet-wake-idle', (_event, data = {}) => {
  if (isAnnoyedLocked()) return;
  sendState('idle', 0, { startGaze: data.startGaze !== false });
});

ipcMain.on('pet-click', (_event, data) => {
  if (isAnnoyedLocked()) return;
  lastInteractionAt = Date.now();
  hiddenEdge = null;

  const now = Date.now();
  if (!clickBurstStartedAt || now - clickBurstStartedAt > ANNOYED_CLICK_WINDOW_MS) {
    clickBurstStartedAt = now;
    clickBurstCount = 1;
  } else {
    clickBurstCount += 1;
  }

  if (clickBurstCount < ANNOYED_CLICK_TARGET) {
    sendState('click_happy', 700, { startGaze: true });
    return;
  }

  enterAnnoyedLock();
});

ipcMain.on('show-context-menu', () => {
  if (isAnnoyedLocked()) return;
  markPetInteraction();
  if (win) buildMenu().popup({ window: win });
});

ipcMain.on('pet-cling-hit-test', (_event, interactive) => {
  if (!attachedWindow) {
    setPetMousePassthrough(false);
    return;
  }
  setPetMousePassthrough(!interactive);
});

app.whenReady().then(() => {
  autostartEnabled = app.getLoginItemSettings().openAtLogin || true;
  setAutostart(autostartEnabled);
  createWindow();
  createTray();
  startWindowListTracker();
  setInterval(sampleMouse, MOUSE_SAMPLE_MS);
});

app.on('window-all-closed', () => {
  // Keep the tray/menu process alive unless the user chooses Exit.
});

app.on('before-quit', () => {
  stopClingTracker();
  stopWindowListTracker();
});
