const { app, BrowserWindow, ipcMain, dialog } = require("electron");

const path = require("path");

console.log("================================");
console.log("FB LOCATION SCRAPPER");
console.log("================================");

app.disableHardwareAcceleration();

function createWindow() {
  console.log("Creating GUI...");

  const window = new BrowserWindow({
    width: 1100,
    height: 750,

    minWidth: 900,
    minHeight: 600,

    show: true,

    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const htmlPath = path.join(__dirname, "../renderer/index.html");

  console.log("Loading:", htmlPath);

  window.loadFile(htmlPath);

  window.webContents.openDevTools();
}

ipcMain.handle("select-csv", async () => {
  const result = await dialog.showOpenDialog({
    title: "Pilih File CSV",

    properties: ["openFile"],

    filters: [
      {
        name: "CSV Files",
        extensions: ["csv"],
      },
      {
        name: "All Files",
        extensions: ["*"],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

app.whenReady().then(() => {
  console.log("Electron READY");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
