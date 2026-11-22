// Bridge between the editor UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vpm', {
  platform: process.platform,
  invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
  onMenu: (fn) => ipcRenderer.on('menu', (e, cmd) => fn(cmd)),
  forceClose: () => ipcRenderer.send('window:force-close'),
  setTitle: (t, edited) => ipcRenderer.send('window:set-title', t, edited),
  pathForFile: (f) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : f.path),
});
