(() => {
  if (!window.__TAURI__?.core || !window.__TAURI__?.event) {
    console.error('Tauri API is not available. Check build.withGlobalTauri in src-tauri/tauri.conf.json.');
    return;
  }
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.petApi = {
    dragStart: (point) => invoke('pet_drag_start', { point }),
    dragMove: (point) => invoke('pet_drag_move', { point }),
    dragEnd: (data) => invoke('pet_drag_end', { data }),
    lifted: () => invoke('pet_lifted'),
    click: (data) => invoke('pet_click', { data }),
    clingHitTest: (interactive) => invoke('pet_cling_hit_test', { interactive }),
    wakeIdle: (data) => invoke('pet_wake_idle', { data }),
    contextMenu: () => invoke('show_context_menu'),
    onState: (callback) => {
      listen('pet-state', (event) => callback(event.payload));
    },
    onMouseMotion: (callback) => {
      listen('mouse-motion', (event) => callback(event.payload));
    }
  };
})();
