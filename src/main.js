const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PET_SIZE = 260;
const PEEK_VISIBLE = 161;
const IDLE_RANDOM_ACTION_MS = 1000 * 30;
const EDGE_WALK_MS = 1000 * 18;
const EDGE_PEEK_WALK_MS = 1000;
const AUTONOMOUS_PEEK_REST_MS = 1000 * 60;
const AUTONOMOUS_SIT_MS = 1000 * 60;
const AUTONOMOUS_SLEEP_MS = 1000 * 60 * 2;
const AUTONOMOUS_WALK_STEP = 3;
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
  const maxDistance = Math.floor(display.workArea.width / 3);
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
