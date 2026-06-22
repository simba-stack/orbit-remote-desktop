// Exposes a minimal, safe API to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orbit", {
  saveScreenshot: (dataUrl, suggestedName) =>
    ipcRenderer.invoke("save-screenshot", dataUrl, suggestedName),
  defaultSignalingUrl: "wss://orbit-remote-signaling-production.up.railway.app/ws"
});
