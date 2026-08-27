const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // ==============================
  // PILIH CSV
  // ==============================

  selectCsv: () => {
    return ipcRenderer.invoke("select-csv");
  },

  // ==============================
  // MULAI SCRAPER
  // ==============================

  startScraping: (csvPath) => {
    return ipcRenderer.invoke("start-scraping", csvPath);
  },

  // ==============================
  // STOP SCRAPER
  // ==============================

  stopScraping: () => {
    return ipcRenderer.invoke("stop-scraping");
  },

  // ==============================
  // LOG SCRAPER
  // ==============================

  onLog: (callback) => {
    ipcRenderer.on("scraper-log", (_event, message) => {
      callback(message);
    });
  },

  // ==============================
  // ERROR SCRAPER
  // ==============================

  onError: (callback) => {
    ipcRenderer.on("scraper-error", (_event, message) => {
      callback(message);
    });
  },

  // ==============================
  // SCRAPER SELESAI
  // ==============================

  onFinished: (callback) => {
    ipcRenderer.on("scraper-finished", (_event, result) => {
      callback(result);
    });
  },
});
