const sprite = document.getElementById('sprite');
const spriteNext = document.getElementById('sprite-next');
const eyeStack = document.getElementById('eye-stack');
const irises = document.getElementById('irises');
const highlights = document.getElementById('highlights');
const eyelids = document.getElementById('eyelids');
const pet = document.getElementById('pet');

const assets = {
  idle: './assets/pet/base_idle.png',
  eyeWhites: './assets/pet/eye_whites.png',
  irises: './assets/pet/irises.png',
  highlights: './assets/pet/highlights.png',
  lashes: './assets/pet/lashes.png',
  eyelidsHalf: './assets/pet/eyelids_half.png',
  eyelidsClosed: './assets/pet/eyelids_closed.png',
  lookLeft: './assets/pet/look_left.png',
  lookRight: './assets/pet/look_right.png',
  lookUp: './assets/pet/look_up.png',
  lookDown: './assets/pet/look_down.png',
  befuddled: './assets/pet/befuddled.png',
  clickHappy: './assets/pet/click_happy.png',
  clickAnnoyed: './assets/pet/click_annoyed.png',
  lifted: './assets/pet/lifted.png',
  liftedBefuddled: './assets/pet/lifted_befuddled.png',
  lyingOpen: './assets/pet/lying_open.png',
  lyingClosed: './assets/pet/lying_closed.png',
  lyingClick: './assets/pet/lying_click.png',
  sit: './assets/pet/sit.png',
  sitClosed: './assets/pet/sit_closed.png',
  sleep: './assets/pet/sleep.png',
  peek: {
    left: './assets/pet/left_peek.png',
    right: './assets/pet/right_peek.png',
    leftClick: './assets/pet/left_peek_click.png',
    rightClick: './assets/pet/right_peek_click.png',
    leftClosed: './assets/pet/left_peek_closed.png',
    rightClosed: './assets/pet/right_peek_closed.png'
  },
  walk: {
    left: ['./assets/pet/walk_left_1.png', './assets/pet/walk_left_2.png'],
    right: ['./assets/pet/walk_right_1.png', './assets/pet/walk_right_2.png']
  }
};

[
  assets.idle,
  assets.eyeWhites,
  assets.irises,
  assets.highlights,
  assets.lashes,
  assets.eyelidsHalf,
  assets.eyelidsClosed,
  assets.lookLeft,
  assets.lookRight,
  assets.lookUp,
  assets.lookDown,
  assets.befuddled,
  assets.liftedBefuddled,
  assets.lyingOpen,
  assets.lyingClosed,
  assets.lyingClick,
  assets.sit,
  assets.sitClosed,
  assets.peek.left,
  assets.peek.right,
  assets.peek.leftClick,
  assets.peek.rightClick,
  assets.peek.leftClosed,
  assets.peek.rightClosed
].forEach((src) => {
  const image = new Image();
  image.src = src;
});

const poseOffsets = {
  idle: { x: 0, y: 0 },
  lookLeft: { x: 0.1, y: 1.9 },
  lookRight: { x: 0.1, y: 0.9 },
  lookUp: { x: 0.1, y: 1.3 },
  lookDown: { x: 0.1, y: -3.4 },
  befuddled: { x: 0.3, y: 0.8 },
  sit: { x: 0.4, y: 12 },
  sleep: { x: -7, y: 21 },
  clingTop: { x: 0, y: 8 },
  lifted: { x: 0.5, y: -9 },
  liftedBefuddled: { x: 0.5, y: -9 },
  peekLeft: { x: 2.1, y: 2.5 },
  peekRight: { x: 1.1, y: 2.5 },
  clickHappy: { x: 0.3, y: 0.2 },
  clickAnnoyed: { x: 1.8, y: 1.2 },
  walkLeft1: { x: 2.1, y: 6.8 },
  walkLeft2: { x: 3.2, y: 7.6 },
  walkRight1: { x: 0.9, y: 6.8 },
  walkRight2: { x: -0.1, y: 7.6 }
};

let currentState = 'idle';
let transientTimer = null;
let blinkTimer = null;
let peekBlinkTimer = null;
let peekClickTimer = null;
let sitBlinkTimer = null;
let clingBlinkTimer = null;
let clingClickTimer = null;
let walkTimer = null;
let lookAroundTimer = null;
let holdTimer = null;
let liftedBefuddledTimer = null;
let dragging = false;
let dragStarted = false;
let movedDuringDrag = false;
let wasLongPress = false;
let dragEndStartsGaze = true;
let pointerDownPoint = null;
let pendingDragMove = null;
let dragMoveInFlight = false;
let dragMoveFrame = 0;
let liftedShakeScore = 0;
let liftedShakeAxis = null;
let lastDragPoint = null;
let lastMotion = null;
let lookPose = 'idle';
let isBlinking = false;
let spriteFadeTimer = null;
let pendingLookPose = 'idle';
let pendingLookSince = 0;
let lastLookSwitchAt = 0;
let gazeActiveUntil = 0;
let gazeTimer = null;
let currentPeekDirection = 'right';
let gazeVector = { x: 0, y: 0 };

const SPRITE_FADE_MS = 180;
const GAZE_ACTIVE_MS = 20000;
const LIFTED_BEFUDDLED_MS = 3500;
const LIFTED_SHAKE_TRIGGER_SCORE = 16;

function applyPose(element, pose = 'idle') {
  const offset = poseOffsets[pose] || poseOffsets.idle;
  element.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
}

function setSprite(src, pose = 'idle', options = {}) {
  const smooth = Boolean(options.smooth);
  if (sprite.getAttribute('src') === src) {
    applyPose(sprite, pose);
    return;
  }

  if (spriteFadeTimer) {
    clearTimeout(spriteFadeTimer);
    spriteFadeTimer = null;
  }

  if (smooth) {
    spriteNext.setAttribute('src', src);
    applyPose(spriteNext, pose);
    spriteNext.style.opacity = '1';
    spriteFadeTimer = setTimeout(() => {
      sprite.setAttribute('src', src);
      applyPose(sprite, pose);
      spriteNext.style.opacity = '0';
      spriteFadeTimer = null;
    }, SPRITE_FADE_MS);
    return;
  }

  spriteNext.style.opacity = '0';
  applyPose(sprite, pose);
  if (sprite.getAttribute('src') !== src) sprite.setAttribute('src', src);
}

function setEyeStackVisible(visible) {
  eyeStack.style.opacity = visible ? '1' : '0';
}

function setBlinkFrameActive(active) {
  eyeStack.classList.toggle('blinking', active);
}

function setLayeredGaze(x, y) {
  gazeVector = { x, y };
  irises.style.setProperty('--iris-x', `${x.toFixed(2)}px`);
  irises.style.setProperty('--iris-y', `${y.toFixed(2)}px`);
  highlights.style.setProperty('--highlight-x', `${(x * 0.45).toFixed(2)}px`);
  highlights.style.setProperty('--highlight-y', `${(y * 0.45).toFixed(2)}px`);
}

function showEyelids(src, opacity = 1) {
  eyelids.src = src;
  setBlinkFrameActive(true);
  eyelids.style.opacity = String(opacity);
}

function hideEyelids() {
  eyelids.style.opacity = '0';
  setBlinkFrameActive(false);
}

function stopGazeFollow() {
  if (gazeTimer) {
    clearTimeout(gazeTimer);
    gazeTimer = null;
  }
  gazeActiveUntil = 0;
  pendingLookPose = 'idle';
  lookPose = 'idle';
  setLayeredGaze(0, 0);
}

function startGazeFollow() {
  if (gazeTimer) clearTimeout(gazeTimer);
  gazeActiveUntil = performance.now() + GAZE_ACTIVE_MS;
  pendingLookPose = 'idle';
  pendingLookSince = performance.now();
  lastLookSwitchAt = 0;
  applyLook(lastMotion);
  gazeTimer = setTimeout(() => {
    gazeTimer = null;
    if (performance.now() >= gazeActiveUntil) stopGazeFollow();
    if (currentState !== 'idle') setState('idle');
  }, GAZE_ACTIVE_MS);
}

function clearTransient() {
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
}

function stopWalk() {
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
}

function stopPeekBlink() {
  if (peekBlinkTimer) {
    clearTimeout(peekBlinkTimer);
    peekBlinkTimer = null;
  }
}

function stopPeekClick() {
  if (peekClickTimer) {
    clearTimeout(peekClickTimer);
    peekClickTimer = null;
  }
}

function stopSitBlink() {
  if (sitBlinkTimer) {
    clearTimeout(sitBlinkTimer);
    sitBlinkTimer = null;
  }
}

function stopClingBlink() {
  if (clingBlinkTimer) {
    clearTimeout(clingBlinkTimer);
    clingBlinkTimer = null;
  }
}

function stopClingClick() {
  if (clingClickTimer) {
    clearTimeout(clingClickTimer);
    clingClickTimer = null;
  }
}

function stopLiftedBefuddledTimer() {
  if (liftedBefuddledTimer) {
    clearTimeout(liftedBefuddledTimer);
    liftedBefuddledTimer = null;
  }
}

function resetLiftedShake() {
  liftedShakeScore = 0;
  liftedShakeAxis = null;
  lastDragPoint = null;
}

function flushDragMove() {
  dragMoveFrame = 0;
  if (!pendingDragMove || dragMoveInFlight) return;

  const point = pendingDragMove;
  pendingDragMove = null;
  dragMoveInFlight = true;
  window.petApi.dragMove(point)
    .catch((error) => console.error('dragMove failed', error))
    .finally(() => {
      dragMoveInFlight = false;
      if (pendingDragMove && !dragMoveFrame) {
        dragMoveFrame = requestAnimationFrame(flushDragMove);
      }
    });
}

function queueDragMove(point) {
  pendingDragMove = point;
  if (!dragMoveFrame && !dragMoveInFlight) {
    dragMoveFrame = requestAnimationFrame(flushDragMove);
  }
}

function resetDragMoveQueue() {
  pendingDragMove = null;
  dragMoveInFlight = false;
  if (dragMoveFrame) {
    cancelAnimationFrame(dragMoveFrame);
    dragMoveFrame = 0;
  }
}

function isInteractionLocked() {
  return currentState === 'click_annoyed';
}

function resetPointerInteraction() {
  dragging = false;
  dragStarted = false;
  movedDuringDrag = false;
  wasLongPress = false;
  pointerDownPoint = null;
  pet.classList.remove('dragging');
  pet.classList.remove('clicked');
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  stopLiftedBefuddledTimer();
  resetLiftedShake();
  resetDragMoveQueue();
}

function setState(state, durationMs = 0, options = {}) {
  clearTransient();
  stopWalk();
  currentState = state;
  pet.classList.toggle('sleeping', state === 'sleep');
  pet.classList.toggle('peek', state === 'peek');
  pet.classList.toggle('sitting', state === 'sit');
  pet.classList.toggle('clinging', state === 'cling_top');
  pet.classList.toggle('lifted', state === 'lifted' || state === 'lifted_befuddled');
  setEyeStackVisible(state === 'idle');
  if (state !== 'sit') stopSitBlink();
  if (state !== 'cling_top') stopClingBlink();
  if (state !== 'cling_top') stopClingClick();
  if (state !== 'lifted_befuddled') stopLiftedBefuddledTimer();
  if (state !== 'idle') {
    hideEyelids();
    setLayeredGaze(0, 0);
  }
  if (state !== 'peek') stopPeekBlink();
  if (state !== 'peek') stopPeekClick();

  if (state === 'idle') {
    lookPose = 'idle';
    setSprite(assets.idle, 'idle');
    applyLook(lastMotion);
  }
  if (state === 'befuddled') setSprite(assets.befuddled, 'befuddled');
  if (state === 'sit') {
    stopGazeFollow();
    setSprite(assets.sit, 'sit');
    scheduleSitBlink();
  }
  if (state === 'sleep') setSprite(assets.sleep, 'sleep');
  if (state === 'cling_top') {
    stopGazeFollow();
    setSprite(assets.lyingOpen, 'clingTop');
    scheduleClingBlink();
  }
  if (state === 'lifted') setSprite(assets.lifted, 'lifted');
  if (state === 'lifted_befuddled') setSprite(assets.liftedBefuddled, 'liftedBefuddled');
  if (state === 'peek') {
    const peekDirection = options.direction === 'left' ? 'left' : 'right';
    currentPeekDirection = peekDirection;
    setSprite(assets.peek[peekDirection], peekDirection === 'left' ? 'peekLeft' : 'peekRight');
    schedulePeekBlink();
  }
  if (state === 'click_happy') setSprite(assets.clickHappy, 'clickHappy');
  if (state === 'click_annoyed') {
    resetPointerInteraction();
    stopGazeFollow();
    pendingLookPose = 'idle';
    pendingLookSince = performance.now();
    lastLookSwitchAt = 0;
    setSprite(assets.clickAnnoyed, 'clickAnnoyed');
  }
  if (state === 'walk') startWalk(options.direction);

  if (durationMs > 0) {
    transientTimer = setTimeout(() => {
      setState('idle');
    }, durationMs);
  }
}

function triggerLiftedBefuddled() {
  if (currentState !== 'lifted' || liftedBefuddledTimer) return;
  resetLiftedShake();
  setState('lifted_befuddled');
  liftedBefuddledTimer = setTimeout(() => {
    liftedBefuddledTimer = null;
    resetLiftedShake();
    if (dragging && currentState === 'lifted_befuddled') setState('lifted');
  }, LIFTED_BEFUDDLED_MS);
}

function trackLiftedShake(point) {
  if (!dragging || currentState !== 'lifted') {
    lastDragPoint = point;
    return;
  }
  if (!lastDragPoint) {
    lastDragPoint = point;
    return;
  }

  const dx = point.x - lastDragPoint.x;
  const dy = point.y - lastDragPoint.y;
  const distance = Math.hypot(dx, dy);
  const axis = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : Math.sign(dy) * 2;
  const reversed = liftedShakeAxis !== null && axis !== 0 && axis === -liftedShakeAxis;

  if (distance > 20) {
    liftedShakeScore = Math.min(22, liftedShakeScore + (reversed ? 2.7 : 0.9));
    liftedShakeAxis = axis;
  } else {
    liftedShakeScore = Math.max(0, liftedShakeScore - 0.65);
  }

  lastDragPoint = point;
  if (liftedShakeScore >= LIFTED_SHAKE_TRIGGER_SCORE) triggerLiftedBefuddled();
}

function sitBlink() {
  if (currentState !== 'sit') return;
  setSprite(assets.sitClosed, 'sit');
  sitBlinkTimer = setTimeout(() => {
    if (currentState !== 'sit') return;
    setSprite(assets.sit, 'sit');
    scheduleSitBlink();
  }, 140);
}

function scheduleSitBlink() {
  stopSitBlink();
  sitBlinkTimer = setTimeout(sitBlink, 2300 + Math.random() * 3600);
}

function clingBlink() {
  if (currentState !== 'cling_top') return;
  setSprite(assets.lyingClosed, 'clingTop');
  clingBlinkTimer = setTimeout(() => {
    if (currentState !== 'cling_top') return;
    setSprite(assets.lyingOpen, 'clingTop');
    scheduleClingBlink();
  }, 150);
}

function scheduleClingBlink() {
  stopClingBlink();
  clingBlinkTimer = setTimeout(clingBlink, 2400 + Math.random() * 4200);
}

function triggerClingClick() {
  if (currentState !== 'cling_top') return false;
  stopClingBlink();
  stopClingClick();
  setSprite(assets.lyingClick, 'clingTop');
  clingClickTimer = setTimeout(() => {
    if (currentState !== 'cling_top') return;
    setSprite(assets.lyingOpen, 'clingTop');
    scheduleClingBlink();
  }, 700);
  return true;
}

function startWalk(direction = 'right') {
  const walkDirection = direction === 'left' ? 'left' : 'right';
  const frames = assets.walk[walkDirection];
  const poseNames = walkDirection === 'left' ? ['walkLeft1', 'walkLeft2'] : ['walkRight1', 'walkRight2'];
  let frame = 0;
  setSprite(frames[frame], poseNames[frame]);
  walkTimer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    setSprite(frames[frame], poseNames[frame]);
  }, 260);
}

function blink() {
  if (currentState !== 'idle') return scheduleBlink();
  if (gazeActiveUntil > 0 && performance.now() < gazeActiveUntil) return scheduleBlink();
  isBlinking = true;
  setLayeredGaze(0, 0);
  showEyelids(assets.eyelidsHalf);
  setTimeout(() => {
    showEyelids(assets.eyelidsClosed);
  }, 70);
  setTimeout(() => {
    showEyelids(assets.eyelidsHalf);
  }, 150);
  setTimeout(() => {
    hideEyelids();
    isBlinking = false;
    applyLook(lastMotion);
  }, 230);
  scheduleBlink();
}

function scheduleBlink() {
  if (blinkTimer) clearTimeout(blinkTimer);
  blinkTimer = setTimeout(blink, 2400 + Math.random() * 4200);
}

function peekBlink() {
  if (currentState !== 'peek') return;
  const closedSrc = currentPeekDirection === 'left' ? assets.peek.leftClosed : assets.peek.rightClosed;
  const openSrc = assets.peek[currentPeekDirection];
  const openPose = currentPeekDirection === 'left' ? 'peekLeft' : 'peekRight';
  setSprite(closedSrc, openPose);
  peekBlinkTimer = setTimeout(() => {
    setSprite(openSrc, openPose);
    schedulePeekBlink();
  }, 140);
}

function schedulePeekBlink() {
  stopPeekBlink();
  peekBlinkTimer = setTimeout(peekBlink, 2200 + Math.random() * 3600);
}

function triggerPeekClick() {
  if (currentState !== 'peek') return false;
  stopPeekBlink();
  stopPeekClick();
  const clickSrc = currentPeekDirection === 'left' ? assets.peek.leftClick : assets.peek.rightClick;
  const openSrc = assets.peek[currentPeekDirection];
  const pose = currentPeekDirection === 'left' ? 'peekLeft' : 'peekRight';
  setSprite(clickSrc, pose);
  peekClickTimer = setTimeout(() => {
    if (currentState !== 'peek') return;
    setSprite(openSrc, pose);
    schedulePeekBlink();
  }, 1000);
  return true;
}

function applyLook(mouse) {
  lastMotion = mouse;
  if (!mouse || !mouse.bounds || currentState !== 'idle' || isBlinking) return;

  const now = performance.now();

  if (gazeActiveUntil > 0 && now >= gazeActiveUntil) {
    stopGazeFollow();
    return;
  }

  if (gazeActiveUntil === 0) {
    if (lookPose !== 'idle') lookPose = 'idle';
    if (Math.abs(gazeVector.x) > 0.01 || Math.abs(gazeVector.y) > 0.01) setLayeredGaze(0, 0);
    return;
  }

  const centerX = mouse.bounds.x + mouse.bounds.width / 2;
  const centerY = mouse.bounds.y + mouse.bounds.height / 2;
  const dx = mouse.x - centerX;
  const dy = mouse.y - centerY;
  const targetX = Math.max(-2.25, Math.min(2.25, dx / 95));
  const targetY = Math.max(-1.45, Math.min(1.55, dy / 105));
  setLayeredGaze(targetX, targetY);
}

function lookAround() {
  // Waiting for dedicated eye-direction assets before enabling gaze animation.
}

function isClingHeadPoint(event) {
  const rect = pet.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return x >= 0.08 && x <= 0.74 && y >= 0.04 && y <= 0.73;
}

function updateClingHitTest(event) {
  if (currentState !== 'cling_top') return;
  window.petApi.clingHitTest(isClingHeadPoint(event));
}

pet.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (currentState === 'cling_top' && !isClingHeadPoint(event)) {
    window.petApi.clingHitTest(false);
    return;
  }
  if (isInteractionLocked()) {
    event.preventDefault();
    return;
  }
  dragging = true;
  dragStarted = false;
  movedDuringDrag = false;
  wasLongPress = false;
  pointerDownPoint = { x: event.screenX, y: event.screenY };
  dragEndStartsGaze = true;

  const startedInPeek = currentState === 'peek';
  const startedInSit = currentState === 'sit';
  const startedInCling = currentState === 'cling_top';
  holdTimer = setTimeout(() => {
    if (!dragging) return;
    wasLongPress = true;
    if (!dragStarted) {
      dragStarted = true;
      pet.classList.add('dragging');
      window.petApi.dragStart({ x: event.screenX, y: event.screenY });
    }
    if (startedInSit) dragEndStartsGaze = false;
    resetLiftedShake();
    lastDragPoint = { x: event.screenX, y: event.screenY };
    window.petApi.lifted();
  }, 250);
});

window.addEventListener('mousemove', (event) => {
  updateClingHitTest(event);
  if (isInteractionLocked()) return;
  if (!dragging) return;
  if (!dragStarted && pointerDownPoint) {
    const dx = event.screenX - pointerDownPoint.x;
    const dy = event.screenY - pointerDownPoint.y;
    if (Math.hypot(dx, dy) > 6) {
      dragStarted = true;
      pet.classList.add('dragging');
      window.petApi.dragStart({ x: pointerDownPoint.x, y: pointerDownPoint.y });
    }
  }
  if (!dragStarted) return;
  movedDuringDrag = true;
  trackLiftedShake({ x: event.screenX, y: event.screenY });
  queueDragMove({ x: event.screenX, y: event.screenY });
});

window.addEventListener('mouseup', (event) => {
  if (isInteractionLocked()) {
    resetPointerInteraction();
    return;
  }
  if (!dragging) return;
  dragging = false;
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  pet.classList.remove('dragging');
  resetDragMoveQueue();
  const droppedWhileLiftedBefuddled = currentState === 'lifted_befuddled';
  if (droppedWhileLiftedBefuddled) stopLiftedBefuddledTimer();
  if (dragStarted) {
    window.petApi.dragEnd({
      startGaze: droppedWhileLiftedBefuddled ? false : dragEndStartsGaze,
      liftedBefuddledDrop: droppedWhileLiftedBefuddled,
      point: { x: event.screenX, y: event.screenY }
    });
  }
  dragStarted = false;
  pointerDownPoint = null;
  dragEndStartsGaze = true;
  resetLiftedShake();
});

pet.addEventListener('click', () => {
  if (isInteractionLocked()) return;
  if (currentState === 'sit') return;
  if (movedDuringDrag || wasLongPress) return;
  if (currentState === 'cling_top') {
    triggerClingClick();
    return;
  }
  if (triggerPeekClick()) return;
  pet.classList.remove('clicked');
  void pet.offsetWidth;
  pet.classList.add('clicked');
  window.petApi.click({});
});

pet.addEventListener('dblclick', () => {
  if (isInteractionLocked()) return;
  if (currentState !== 'sit') return;
  resetPointerInteraction();
  stopSitBlink();
  window.petApi.wakeIdle({ startGaze: true });
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (isInteractionLocked()) return;
  window.petApi.contextMenu();
});

window.petApi.onState(({ state, durationMs, direction, startGaze }) => {
  setState(state, durationMs, { direction });
  if (startGaze) startGazeFollow();
});

window.petApi.onMouseMotion((payload) => {
  lastMotion = payload;
  applyLook(payload);
});

setState('idle');
scheduleBlink();
lookAroundTimer = setInterval(lookAround, 2200);

