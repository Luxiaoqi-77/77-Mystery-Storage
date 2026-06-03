const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  dragStart: (point) => ipcRenderer.send('pet-drag-start', point),
  dragMove: (point) => ipcRenderer.send('pet-drag-move', point),
  dragEnd: (data) => ipcRenderer.send('pet-drag-end', data),
  lifted: () => ipcRenderer.send('pet-lifted'),
  click: (data) => ipcRenderer.send('pet-click', data),
  clingHitTest: (interactive) => ipcRenderer.send('pet-cling-hit-test', interactive),
  wakeIdle: (data) => ipcRenderer.send('pet-wake-idle', data),
  setSizeScale: (scale) => ipcRenderer.send('pet-size-scale', scale),
  contextMenu: () => ipcRenderer.send('show-context-menu'),
  onState: (callback) => ipcRenderer.on('pet-state', (_event, payload) => callback(payload)),
  onSize: (callback) => ipcRenderer.on('pet-size', (_event, payload) => callback(payload)),
  onMouseMotion: (callback) => ipcRenderer.on('mouse-motion', (_event, payload) => callback(payload))
});
