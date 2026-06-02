(() => {
  const coreInvoke = window.__TAURI__?.core?.invoke;
  const eventListen = window.__TAURI__?.event?.listen;

  const invoke = (command, args = {}) => {
    if (coreInvoke) return coreInvoke(command, args);
    console.error('Tauri invoke API is not available:', command);
    return Promise.reject(new Error('Tauri invoke API is not available'));
  };

  const listen = (event, callback) => {
    if (eventListen) return eventListen(event, callback);
    console.error('Tauri event API is not available:', event);
    return Promise.resolve(() => {});
  };

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
