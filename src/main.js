const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PET_SIZE = 260;
const PEEK_VISIBLE = 161;
const IDLE_HIDE_MS = 1000 * 60 * 4;
const EDGE_WALK_MS = 1000 * 18;
const EDGE_PEEK_WALK_MS = 1000;
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
        if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
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
  currentPetState = state;
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

function sendWalk(direction, durationMs) {
  if (!win) return;
  if (isAnnoyedLocked()) return;
  currentPetState = 'walk';
  lastInteractionAt = Date.now();
  hiddenEdge = null;
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

function hideToNearestEdge() {
  if (!win || hiddenEdge) return;
  if (isAnnoyedLocked()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const distances = {
    left: Math.abs(bounds.x - area.x),
    right: Math.abs(area.x + area.width - (bounds.x + bounds.width))
  };
  hiddenEdge = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
  const next = { ...bounds };
  if (hiddenEdge === 'left') next.x = area.x - PET_SIZE + PEEK_VISIBLE;
  if (hiddenEdge === 'right') next.x = area.x + area.width - PEEK_VISIBLE;
  win.setBounds(next);
  sendPeek(hiddenEdge);
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

function maybeEdgeWalk() {
  if (!win || dragging) return;
  if (isAnnoyedLocked()) return;
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

  if (headShakeScore >= HEAD_SHAKE_TRIGGER_SCORE && !hiddenEdge && !edgePeekWalk) {
    triggerBefuddledThenSit();
  } else if (now - lastInteractionAt > IDLE_HIDE_MS && !hiddenEdge && !edgePeekWalk) {
    hideToNearestEdge();
  }

  maybeEdgeWalk();
}

ipcMain.on('pet-drag-start', (_event, point) => {
  if (!win) return;
  if (isAnnoyedLocked()) return;
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
  sendState('idle', 0, { startGaze: data.startGaze !== false });
});

ipcMain.on('pet-lifted', () => {
  if (isAnnoyedLocked()) return;
  if (!dragging) return;
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
  if (win) buildMenu().popup({ window: win });
});

app.whenReady().then(() => {
  autostartEnabled = app.getLoginItemSettings().openAtLogin || true;
  setAutostart(autostartEnabled);
  createWindow();
  createTray();
  setInterval(sampleMouse, MOUSE_SAMPLE_MS);
});

app.on('window-all-closed', () => {
  // Keep the tray/menu process alive unless the user chooses Exit.
});
