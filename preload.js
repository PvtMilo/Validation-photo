// filename: preload.js
// Secure bridge between renderer and main
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  hide: () => ipcRenderer.invoke("xso:hide"),
  show: () => ipcRenderer.invoke("xso:show"),
  minimize: () => ipcRenderer.invoke("xso:minimize"),
  getFlag: (name) => ipcRenderer.invoke("xso:get-flag", name)
});
