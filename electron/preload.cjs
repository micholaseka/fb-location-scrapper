const { contextBridge, ipcRenderer } = require("electron");

console.log("PRELOAD LOADED");

contextBridge.exposeInMainWorld("electronAPI", {
  selectCsv: () => {
    return ipcRenderer.invoke("select-csv");
  },

  startScraping: (csvPath) => {
    return ipcRenderer.invoke("start-scraping", csvPath);
  },

  stopScraping: () => {
    return ipcRenderer.invoke("stop-scraping");
  },

  onLog: (callback) => {
    ipcRenderer.on("scraper-log", (_event, message) => {
      callback(message);
    });
  },

  onError: (callback) => {
    ipcRenderer.on("scraper-error", (_event, message) => {
      callback(message);
    });
  },

  onFinished: (callback) => {
    ipcRenderer.on("scraper-finished", (_event, result) => {
      callback(result);
    });
  },
});
