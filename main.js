// Orbit Remote — Electron main process.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0d14",
    title: "Orbit Remote",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Save a screenshot (PNG data URL) to disk via a native dialog.
ipcMain.handle("save-screenshot", async (_event, dataUrl, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save screenshot",
    defaultPath: suggestedName || `orbit-screenshot-${Date.now()}.png`,
    filters: [{ name: "PNG Image", extensions: ["png"] }]
  });
  if (canceled || !filePath) return { saved: false };
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return { saved: true, filePath };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
