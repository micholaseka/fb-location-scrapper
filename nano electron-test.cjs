const { app, BrowserWindow } = require("electron");

console.log("TEST 1");

app.disableHardwareAcceleration();

console.log("TEST 2");

app.whenReady().then(() => {
  console.log("TEST 3 - ELECTRON READY");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
  });

  console.log("TEST 4 - WINDOW CREATED");

  win.loadURL(
    "data:text/html,<h1 style='font-family:Arial;padding:40px'>Electron TEST BERHASIL 🚀</h1>",
  );

  console.log("TEST 5 - HTML LOADED");
});
