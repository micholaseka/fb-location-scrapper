const csvPath = document.getElementById("csvPath");

const selectCsv = document.getElementById("selectCsv");

const startButton = document.getElementById("startButton");

const stopButton = document.getElementById("stopButton");

const status = document.getElementById("status");

const progressBar = document.getElementById("progressBar");

const progressText = document.getElementById("progressText");

const progressPercent = document.getElementById("progressPercent");

const logContainer = document.getElementById("logContainer");

// ========================================
// STATUS BADGE
// ========================================

/*
 * Set teks badge status SEKALIGUS warnanya. `state` menentukan
 * warna lewat atribut data-status yang sudah didefinisikan di
 * style.css (idle / ready / running / success / error / warning).
 */
function setStatus(text, state = "idle") {
  status.textContent = text;
  status.dataset.status = state;
}

// ========================================
// LOG
// ========================================

/*
 * Menentukan class warna 1 baris log berdasarkan emoji/kata kunci
 * yang sudah dipakai scraper.js (✅ sukses, ❌ gagal/error,
 * ⚠️ warning/skip, sisanya dianggap info netral).
 */
function classifyLog(line) {
  if (/[✅🏁💾]/.test(line)) {
    return "log-success";
  }

  if (/[❌]/.test(line) || /gagal|error/i.test(line)) {
    return "log-error";
  }

  if (/[⚠️♻️]/.test(line)) {
    return "log-warning";
  }

  return "log-info";
}

function addLog(message) {
  const lines = String(message)
    .split("\n")
    .filter((line) => line.trim() !== "");

  for (const line of lines) {
    const log = document.createElement("div");

    log.className = `log ${classifyLog(line)}`;

    const time = new Date().toLocaleTimeString();

    log.textContent = `${time} ${line}`;

    logContainer.appendChild(log);
  }

  logContainer.scrollTop = logContainer.scrollHeight;
}

// ========================================
// PROGRESS
// ========================================

function setProgress(current, total) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  progressBar.style.width = `${percent}%`;

  progressText.textContent = `${current} / ${total} lokasi`;

  progressPercent.textContent = `${percent}%`;
}

// ========================================
// PARSE PROGRESS DARI LOG
// ========================================

function parseProgress(message) {
  /*
   * Mencari format seperti:
   *
   * 1/20
   * 2/20
   * 15/50
   */

  const match = String(message).match(/(\d+)\s*\/\s*(\d+)/);

  if (!match) {
    return;
  }

  const current = Number(match[1]);

  const total = Number(match[2]);

  if (Number.isNaN(current) || Number.isNaN(total)) {
    return;
  }

  setProgress(current, total);
}

// ========================================
// PILIH CSV
// ========================================

selectCsv.addEventListener("click", async () => {
  addLog("📂 Membuka file picker...");

  try {
    const filePath = await window.electronAPI.selectCsv();

    if (!filePath) {
      addLog("⚠️ Pemilihan CSV dibatalkan.");

      return;
    }

    csvPath.value = filePath;

    setStatus("CSV siap", "ready");

    addLog(`✅ CSV dipilih: ${filePath}`);
  } catch (error) {
    console.error(error);

    addLog(`❌ Gagal memilih CSV: ${error.message}`);
  }
});

// ========================================
// MULAI SCRAPING
// ========================================

startButton.addEventListener("click", async () => {
  if (!csvPath.value) {
    addLog("⚠️ Pilih file CSV terlebih dahulu.");

    setStatus("Pilih CSV", "warning");

    return;
  }

  addLog("🚀 Memulai scraper...");

  addLog(`📄 CSV: ${csvPath.value}`);

  setStatus("Berjalan", "running");

  startButton.disabled = true;

  stopButton.disabled = false;

  setProgress(0, 0);

  try {
    await window.electronAPI.startScraping(csvPath.value);
  } catch (error) {
    console.error(error);

    addLog(`❌ Gagal menjalankan scraper: ${error.message}`);

    setStatus("Error", "error");

    startButton.disabled = false;

    stopButton.disabled = true;
  }
});

// ========================================
// STOP
// ========================================

stopButton.addEventListener("click", async () => {
  addLog("⛔ Menghentikan scraper...");

  try {
    await window.electronAPI.stopScraping();
  } catch (error) {
    console.error(error);

    addLog(`❌ Gagal menghentikan scraper: ${error.message}`);
  }
});

// ========================================
// TERIMA LOG SCRAPER
// ========================================

window.electronAPI.onLog((message) => {
  addLog(message);

  parseProgress(message);
});

// ========================================
// TERIMA ERROR
// ========================================

window.electronAPI.onError((message) => {
  addLog(`❌ ${message}`);
});

// ========================================
// SCRAPER SELESAI
// ========================================

window.electronAPI.onFinished((result) => {
  startButton.disabled = false;

  stopButton.disabled = true;

  if (result.success) {
    setStatus("Selesai", "success");

    addLog("================================");

    addLog("✅ SCRAPING SELESAI");

    addLog("================================");
  } else {
    setStatus("Gagal", "error");

    addLog(`❌ Scraper berhenti. Exit code: ${result.code}`);
  }
});

// ========================================
// INIT
// ========================================

setProgress(0, 0);

setStatus("Siap", "idle");

addLog("🟢 Sistem siap digunakan.");
