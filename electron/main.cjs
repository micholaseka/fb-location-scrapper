const { app, BrowserWindow, ipcMain, dialog } = require("electron");

const path = require("path");
const { spawn } = require("child_process");

let mainWindow = null;
let scraperProcess = null;

app.disableHardwareAcceleration();

function createWindow() {
  console.log("================================");
  console.log("FB LOCATION SCRAPPER");
  console.log("================================");

  mainWindow = new BrowserWindow({
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

  mainWindow.loadFile(htmlPath);

  // Buka DevTools sementara untuk debugging.
  // Nanti kita hapus sebelum packaging.
  mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ========================================
// PILIH CSV
// ========================================

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

// ========================================
// MULAI SCRAPING
// ========================================

ipcMain.handle("start-scraping", async (event, csvFilePath) => {
  if (scraperProcess) {
    throw new Error("Scraper sedang berjalan.");
  }

  if (!csvFilePath) {
    throw new Error("File CSV belum dipilih.");
  }

  console.log("");
  console.log("================================");
  console.log("START SCRAPER");
  console.log("================================");
  console.log("CSV:", csvFilePath);

  const scraperPath = path.join(__dirname, "../scraper.js");

  console.log("SCRAPER:", scraperPath);

  /*
   * Kita menggunakan executable Node,
   * bukan Electron.
   *
   * process.env.ELECTRON_RUN_AS_NODE
   * mencegah child process dijalankan
   * sebagai aplikasi Electron.
   */

  const nodeExecutable = process.env.NODE || "node";

  scraperProcess = spawn(nodeExecutable, [scraperPath, csvFilePath], {
    cwd: path.join(__dirname, ".."),

    env: {
      ...process.env,
    },

    stdio: ["ignore", "pipe", "pipe"],
  });

  // ====================================
  // STDOUT
  // ====================================

  scraperProcess.stdout.on("data", (data) => {
    const message = data.toString();

    console.log("[SCRAPER]", message);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scraper-log", message);
    }
  });

  // ====================================
  // STDERR
  // ====================================

  scraperProcess.stderr.on("data", (data) => {
    const message = data.toString();

    console.error("[SCRAPER ERROR]", message);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scraper-error", message);
    }
  });

  // ====================================
  // PROCESS ERROR
  // ====================================

  scraperProcess.on("error", (error) => {
    console.error("Gagal menjalankan scraper:", error);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scraper-error", error.message);

      mainWindow.webContents.send("scraper-finished", {
        success: false,
        code: null,
        error: error.message,
      });
    }

    scraperProcess = null;
  });

  // ====================================
  // PROCESS SELESAI
  // ====================================

  scraperProcess.on("close", (code) => {
    console.log("Scraper selesai. Exit code:", code);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scraper-finished", {
        success: code === 0,
        code,
      });
    }

    scraperProcess = null;
  });

  return {
    started: true,
  };
});

// ========================================
// STOP SCRAPER
// ========================================

ipcMain.handle("stop-scraping", async () => {
  if (!scraperProcess) {
    return {
      stopped: false,
      message: "Tidak ada scraper yang sedang berjalan.",
    };
  }

  console.log("Menghentikan scraper...");

  scraperProcess.kill("SIGTERM");

  return {
    stopped: true,
  };
});

// ========================================
// ELECTRON READY
// ========================================

app.whenReady().then(() => {
  console.log("Electron READY");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// ========================================
// CLOSE APP
// ========================================

app.on("window-all-closed", () => {
  if (scraperProcess) {
    scraperProcess.kill("SIGTERM");

    scraperProcess = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
