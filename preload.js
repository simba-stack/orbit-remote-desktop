// Exposes a minimal, safe API to the renderer.
const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("orbit", {
  saveScreenshot: (dataUrl, suggestedName) =>
    ipcRenderer.invoke("save-screenshot", dataUrl, suggestedName),
  // Reliable clipboard access via Electron's native module (no permission prompts).
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text || ""),
  defaultSignalingUrl: "wss://orbit-remote-signaling-production.up.railway.app/ws"
});
