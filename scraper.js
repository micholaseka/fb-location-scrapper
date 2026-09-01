import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parse } from "csv-parse/sync";
import { writeResultsCsv } from "./csvWriter.js";

const FACEBOOK_URL = "https://www.facebook.com/marketplace/";

const AUTOCOMPLETE_WAIT = 2000;
const BETWEEN_LOCATION_WAIT = 1000;

const MAX_RETRIES = 2;
const RETRY_DELAY = 2000;

const OUTPUT_FILE = path.resolve("autocomplete-results.json");
const CSV_OUTPUT_FILE = path.resolve("scraped-locations.csv");
const ERROR_FILE = path.resolve("scraper-errors.json");

/*
|--------------------------------------------------------------------------
| PROFIL BROWSER PERSISTEN
|--------------------------------------------------------------------------
|
| Folder ini menyimpan cookies, localStorage, dan session Facebook —
| persis seperti profil Chrome/Firefox biasa. Dengan ini, setelah
| login manual SATU KALI, bot akan tetap login di sesi berikutnya
| tanpa perlu login ulang, selama folder ini tidak dihapus.
|
| PENTING: folder ini berisi data sesi login akun Facebook — jangan
| pernah di-commit ke git atau dibagikan ke orang lain (sudah
| ditambahkan ke .gitignore).
|
*/
const USER_DATA_DIR = path.resolve("browser-profile");

/*
|--------------------------------------------------------------------------
| SELECTOR LOKASI (BILINGUAL)
|--------------------------------------------------------------------------
|
| Facebook menampilkan UI dalam Bahasa Indonesia ATAU Bahasa Inggris
| tergantung akun/browser. Selector di bawah ini sengaja ditulis
| dengan format "selectorA, selectorB" (koma) supaya Playwright
| mencari elemen yang cocok dengan SALAH SATU dari keduanya —
| jadi bot tetap jalan baik saat UI Indonesia maupun Inggris.
|
| CATATAN: kita SENGAJA tidak pakai class CSS Facebook (mis. "x193iq5w")
| karena class itu acak dan berubah tiap Facebook deploy versi baru.
| Kita pakai aria-label & role karena itu jauh lebih stabil.
|
*/

// Tombol trigger di sidebar Marketplace, bentuknya:
// <div role="button" aria-label="Lokasi: <nama tempat>, Dalam <radius>">
// Kita pakai "starts with" (^=) karena nama tempat & radius di
// dalam aria-label selalu berubah-ubah, cuma prefix-nya yang tetap.
const LOCATION_TRIGGER_SELECTOR =
  'div[role="button"][aria-label^="Lokasi:"], div[role="button"][aria-label^="Location:"]';

// Input combobox di dalam modal "Ubah Lokasi" / "Edit Location".
// Ini adalah selector yang SUDAH ADA sebelumnya di scraper ini
// (terbukti bekerja), sekarang ditambah versi Bahasa Indonesia.
const LOCATION_INPUT_SELECTOR =
  'input[role="combobox"][aria-label="Lokasi"], input[role="combobox"][aria-label="Location"]';

// Berapa lama bot menunggu modal "Ubah Lokasi" muncul setelah
// tombol trigger diklik.
const LOCATION_MODAL_TIMEOUT = 15_000;

// Berapa lama bot mengecek apakah input lokasi SUDAH terbuka
// sebelum mencoba klik tombol trigger (mis. modal kebetulan
// masih terbuka dari sesi sebelumnya).
const LOCATION_ALREADY_OPEN_CHECK_TIMEOUT = 3_000;

/*
|--------------------------------------------------------------------------
| SELECTOR VERIFIKASI (APPLY + URL)
|--------------------------------------------------------------------------
|
| Dipakai khusus untuk keyword dengan ≤ 2 hasil autocomplete —
| lihat bagian "VERIFIKASI APPLY + URL" di bawah.
|
| CATATAN PENTING: tombol "Terapkan" / "Apply" belum pernah kita
| lihat langsung markup-nya, jadi selector di bawah ini pakai
| Playwright getByRole (role + accessible name) yang paling stabil
| terhadap perubahan class CSS Facebook. Kalau saat live test
| ternyata tombolnya tidak ketemu, INI yang pertama harus dicek —
| tinggal sesuaikan APPLY_BUTTON_NAME atau ganti ke selector lain.
|
*/
const APPLY_BUTTON_NAME = /Terapkan|Apply/i;

// Berapa lama bot menunggu URL berubah setelah tombol Terapkan
// diklik. Marketplace adalah SPA, jadi ini menunggu perubahan
// URL (bukan full page reload).
const URL_CHANGE_TIMEOUT = 10_000;

// Batas jumlah hasil autocomplete supaya keyword ini masuk alur
// verifikasi apply+URL. Kalau hasilnya lebih banyak dari ini,
// verifikasi di-skip (cuma simpan data autocomplete seperti biasa).
const VERIFY_MAX_RESULTS = 2;

/*
|--------------------------------------------------------------------------
| INPUT
|--------------------------------------------------------------------------
*/

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/*
|--------------------------------------------------------------------------
| CSV INPUT
|--------------------------------------------------------------------------
*/

function detectDelimiter(csvText) {
  const firstLine =
    csvText.split(/\r?\n/).find((line) => line.trim().length > 0) || "";

  const candidates = [",", ";", "\t", "|"];

  let bestDelimiter = ",";
  let bestCount = 0;

  for (const delimiter of candidates) {
    const count = firstLine.split(delimiter).length - 1;

    if (count > bestCount) {
      bestDelimiter = delimiter;
      bestCount = count;
    }
  }

  return bestDelimiter;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function looksLikeHeader(row) {
  const headers = [
    "location",
    "lokasi",
    "city",
    "kota",
    "town",
    "region",
    "wilayah",
    "place",
  ];

  return row.some((cell) => headers.includes(normalizeHeader(cell)));
}

function findLocationColumn(headers) {
  const candidates = [
    "location",
    "lokasi",
    "city",
    "kota",
    "town",
    "region",
    "wilayah",
    "place",
  ];

  for (let i = 0; i < headers.length; i++) {
    if (candidates.includes(normalizeHeader(headers[i]))) {
      return i;
    }
  }

  return null;
}

function extractLocations(csvText) {
  const delimiter = detectDelimiter(csvText);

  console.log(`📐 Delimiter: ${JSON.stringify(delimiter)}`);

  const rows = parse(csvText, {
    delimiter,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  if (rows.length === 0) {
    return [];
  }

  const firstRow = rows[0];

  if (looksLikeHeader(firstRow)) {
    const columnIndex = findLocationColumn(firstRow);

    if (columnIndex === null) {
      throw new Error("Kolom lokasi tidak ditemukan.");
    }

    return rows
      .slice(1)
      .map((row) => String(row[columnIndex] ?? "").trim())
      .filter(Boolean);
  }

  return rows.map((row) => String(row[0] ?? "").trim()).filter(Boolean);
}

async function loadLocations() {
  const argumentPath = process.argv[2];

  let csvPath;

  if (argumentPath) {
    csvPath = path.resolve(argumentPath);
  } else {
    console.log("");
    console.log("📄 Masukkan path file CSV:");

    csvPath = path.resolve(await ask("> "));
  }

  if (!fs.existsSync(csvPath)) {
    throw new Error(`File tidak ditemukan:\n${csvPath}`);
  }

  console.log("");
  console.log(`📁 CSV: ${csvPath}`);

  const csvText = fs.readFileSync(csvPath, "utf8");
  const locations = extractLocations(csvText);

  // Dedupe case-insensitive: "Abar-Abir" dan "Abar-abir" adalah
  // lokasi yang SAMA, cuma beda kapitalisasi (biasanya karena CSV
  // diisi manual/gabungan dari beberapa sumber). Set biasa
  // ([...new Set(...)]) case-sensitive, jadi dua penulisan itu
  // lolos sebagai 2 entri berbeda dan bikin bot memproses (dan
  // klik Terapkan) lokasi yang sama berkali-kali.
  const seenKeys = new Set();
  const uniqueLocations = [];

  for (const location of locations) {
    const key = location.trim().toLowerCase().replace(/\s+/g, " ");

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueLocations.push(location);
    }
  }

  if (uniqueLocations.length === 0) {
    throw new Error("Tidak ada lokasi di dalam CSV.");
  }

  const duplicateCount = locations.length - uniqueLocations.length;

  console.log(`📊 Total lokasi: ${uniqueLocations.length}`);

  if (duplicateCount > 0) {
    console.log(
      `🧹 ${duplicateCount} baris duplikat (termasuk beda kapitalisasi) dibuang dari CSV.`,
    );
  }

  return uniqueLocations;
}

/*
|--------------------------------------------------------------------------
| FILE STORAGE
|--------------------------------------------------------------------------
*/

function saveResults(results) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf8");
}

function saveErrors(errors) {
  fs.writeFileSync(ERROR_FILE, JSON.stringify(errors, null, 2), "utf8");
}

/*
|--------------------------------------------------------------------------
| DETEKSI & BUKA INPUT LOKASI (OTOMATIS)
|--------------------------------------------------------------------------
|
| Sebelumnya, user harus klik manual tombol "Lokasi" di sidebar
| Marketplace, lalu klik kolom input di dalam modal "Ubah Lokasi",
| baru scraper bisa mulai mengisi keyword.
|
| Fungsi-fungsi di bawah ini menggantikan langkah klik manual itu:
| bot sendiri yang mencari tombol trigger, mengkliknya, menunggu
| modal terbuka, lalu mencari kolom input di dalamnya.
|
| Login manual Facebook TETAP diperlukan (tidak diotomatisasi) —
| ini cuma menghilangkan langkah klik filter lokasi setelah login.
|
*/

/**
 * Mengecek apakah input lokasi SUDAH terlihat di layar tanpa
 * perlu klik apa pun. Berguna kalau modal "Ubah Lokasi" kebetulan
 * sudah terbuka (mis. sisa sesi sebelumnya, atau Facebook
 * langsung menampilkannya).
 *
 * Mengembalikan locator jika ditemukan, atau null jika tidak.
 */
async function findAlreadyOpenLocationInput(page) {
  const input = page.locator(LOCATION_INPUT_SELECTOR).first();

  try {
    await input.waitFor({
      state: "visible",
      timeout: LOCATION_ALREADY_OPEN_CHECK_TIMEOUT,
    });

    return input;
  } catch {
    // Belum ada / belum terlihat — nanti bot yang buka lewat trigger.
    return null;
  }
}

/**
 * Mencari & mengklik tombol trigger lokasi di sidebar
 * (mis. "Suruhan, Jawa Timur, Indonesia · Dalam 5 km"),
 * lalu menunggu modal "Ubah Lokasi" terbuka.
 */
async function openLocationModal(page) {
  const trigger = page.locator(LOCATION_TRIGGER_SELECTOR).first();

  console.log("🔍 Mencari tombol filter lokasi di sidebar...");

  await trigger.waitFor({
    state: "visible",
    timeout: LOCATION_MODAL_TIMEOUT,
  });

  console.log("🖱️ Klik tombol filter lokasi...");

  await trigger.click();

  console.log("⏳ Menunggu modal 'Ubah Lokasi' terbuka...");

  const input = page.locator(LOCATION_INPUT_SELECTOR).first();

  await input.waitFor({
    state: "visible",
    timeout: LOCATION_MODAL_TIMEOUT,
  });

  return input;
}

/**
 * Fungsi utama: memastikan input lokasi siap dipakai, dengan
 * urutan berikut —
 *
 * 1. Cek dulu apakah input sudah terbuka (tanpa klik apa pun).
 * 2. Kalau belum, cari & klik tombol trigger, lalu tunggu modal.
 *
 * Ini yang dipanggil dari main() menggantikan waitFor pasif
 * yang lama.
 */
async function ensureLocationInput(page) {
  const alreadyOpen = await findAlreadyOpenLocationInput(page);

  if (alreadyOpen) {
    console.log("✅ Input lokasi sudah terbuka, lanjut tanpa klik trigger.");

    return alreadyOpen;
  }

  const input = await openLocationModal(page);

  console.log("✅ Input Location ditemukan.");

  return input;
}

/*
|--------------------------------------------------------------------------
| SCRAPE AUTOCOMPLETE
|--------------------------------------------------------------------------
*/

async function scrapeAutocomplete(page, locationInput, keyword) {
  await locationInput.click();

  await locationInput.selectText();
  await locationInput.fill("");
  await locationInput.fill(keyword);

  console.log(`⌨️ Input: ${keyword}`);

  await page.waitForTimeout(AUTOCOMPLETE_WAIT);

  const options = page.locator('[role="option"]:visible');
  const count = await options.count();

  console.log(`📋 Option ditemukan (mentah): ${count}`);

  const results = [];

  // Facebook kadang merender opsi autocomplete yang SAMA lebih dari
  // sekali di DOM (mis. elemen lama belum benar-benar hilang saat
  // yang baru muncul), jadi selector [role="option"]:visible bisa
  // menghitung 1 lokasi sebagai 2 elemen berbeda. Kita dedupe
  // berdasarkan isi (nama+detail) supaya hasil akhirnya tetap sesuai
  // jumlah lokasi ASLI, bukan jumlah elemen DOM.
  const seenSignatures = new Set();

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const spans = option.locator("span");
    const spanCount = await spans.count();
    const values = [];

    for (let j = 0; j < spanCount; j++) {
      const text = (await spans.nth(j).innerText()).replace(/\s+/g, " ").trim();

      if (text && !values.includes(text)) {
        values.push(text);
      }
    }

    if (values.length === 0) {
      continue;
    }

    const name = values[0] ?? "";
    const detail = values[1] ?? "";
    const signature = `${name}|||${detail}`.toLowerCase();

    if (seenSignatures.has(signature)) {
      continue;
    }

    seenSignatures.add(signature);

    results.push({ name, detail });
  }

  if (count !== results.length) {
    console.log(
      `🧹 ${count - results.length} opsi duplikat (elemen DOM ganda) dibuang — hasil final: ${results.length}`,
    );
  }

  return results;
}

/*
|--------------------------------------------------------------------------
| RETRY
|--------------------------------------------------------------------------
*/

async function scrapeWithRetry(page, locationInput, keyword) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    console.log(`🔄 Percobaan ${attempt}/${MAX_RETRIES + 1}`);

    try {
      const results = await scrapeAutocomplete(page, locationInput, keyword);

      return {
        success: true,
        results,
      };
    } catch (error) {
      lastError = error;

      console.error(`❌ Percobaan ${attempt} gagal:`);
      console.error(error.message);

      if (attempt <= MAX_RETRIES) {
        console.log(`⏳ Retry dalam ${RETRY_DELAY}ms...`);
        await page.waitForTimeout(RETRY_DELAY);
      }
    }
  }

  return {
    success: false,
    error: lastError?.message ?? "Unknown error",
  };
}

/*
|--------------------------------------------------------------------------
| VERIFIKASI APPLY + URL (KHUSUS KEYWORD DENGAN ≤ 2 HASIL)
|--------------------------------------------------------------------------
|
| Alur ini HANYA dijalankan kalau jumlah hasil autocomplete untuk
| 1 keyword ≤ VERIFY_MAX_RESULTS (default 2). Kalau lebih banyak
| dari itu, keyword tersebut di-skip dari alur ini sepenuhnya dan
| cuma disimpan data autocomplete-nya saja (perilaku scraper lama,
| tidak berubah) — logic percabangan ini ada di main().
|
| Untuk tiap hasil autocomplete yang diverifikasi:
|   1. Buka lagi kolom lokasi, ketik ulang keyword (perlu diulang
|      karena setelah "Terapkan" diklik, page refresh dan modal
|      lama + locator lama jadi stale).
|   2. Cari lagi opsi yang cocok (match by name+detail).
|   3. Klik opsi tsb, lalu klik tombol Terapkan/Apply.
|   4. Tunggu URL berubah, baca URL barunya. Facebook menyimpan
|      data kota di URL pakai deretan angka yang konstan untuk
|      kota yang sama.
|   5. Kalau URL ini BELUM pernah dilihat sepanjang run ini →
|      tandai "sukses dicek" (urlStatus: "new").
|      Kalau URL SAMA dengan yang sudah pernah dicek sebelumnya →
|      tandai "url sudah pernah dicek" (urlStatus: "duplicate").
|
*/

/**
 * Buka ulang kolom lokasi, ketik ulang keyword, tunggu autocomplete
 * muncul lagi, lalu cari locator opsi yang cocok dengan target
 * name+detail. Dipakai untuk re-locate opsi setelah locator lama
 * jadi stale (mis. setelah page refresh akibat klik Terapkan).
 */
async function reopenAndFindOption(page, keyword, targetName, targetDetail) {
  const locationInput = await ensureLocationInput(page);

  await locationInput.click();
  await locationInput.selectText();
  await locationInput.fill("");
  await locationInput.fill(keyword);

  await page.waitForTimeout(AUTOCOMPLETE_WAIT);

  const options = page.locator('[role="option"]:visible');
  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const spans = option.locator("span");
    const spanCount = await spans.count();
    const values = [];

    for (let j = 0; j < spanCount; j++) {
      const text = (await spans.nth(j).innerText()).replace(/\s+/g, " ").trim();

      if (text && !values.includes(text)) {
        values.push(text);
      }
    }

    const name = values[0] ?? "";
    const detail = values[1] ?? "";

    if (name === targetName && detail === targetDetail) {
      return option;
    }
  }

  return null;
}

/**
 * Berapa lama bot menunggu tombol trigger lokasi terlihat lagi
 * setelah Terapkan diklik, sebelum dianggap "macet" dan di-reload
 * paksa oleh bot.
 */
const PAGE_READY_TIMEOUT = 10_000;

// Maksimal berapa kali bot boleh reload paksa kalau halamannya
// tetap macet, sebelum menyerah dan lanjut apa adanya.
const MAX_RECOVERY_RELOADS = 2;

/**
 * Setelah "Terapkan" diklik, Facebook KADANG macet (transisi SPA-nya
 * gagal, tampilannya kayak error server) dan cuma bisa normal lagi
 * kalau di-refresh manual (F5) oleh user. Fungsi ini niruin refresh
 * manual itu secara otomatis: kalau elemen kunci Marketplace (tombol
 * trigger lokasi di pojok kanan-atas) belum muncul lagi dalam waktu
 * wajar, bot reload halamannya sendiri — bisa lebih dari sekali —
 * sampai halaman beneran termuat normal.
 */
async function waitForMarketplaceReady(page) {
  for (let attempt = 0; attempt <= MAX_RECOVERY_RELOADS; attempt++) {
    try {
      await page
        .locator(LOCATION_TRIGGER_SELECTOR)
        .first()
        .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT });

      return;
    } catch {
      if (attempt < MAX_RECOVERY_RELOADS) {
        console.log(
          `⚠️ Halaman kelihatan macet setelah Terapkan — reload otomatis (percobaan ${
            attempt + 1
          }/${MAX_RECOVERY_RELOADS})...`,
        );

        try {
          await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } catch (reloadError) {
          console.log(`⚠️ Reload gagal: ${reloadError.message}`);
        }
      }
    }
  }

  console.log(
    "⚠️ Halaman masih belum termuat normal setelah beberapa kali reload, lanjut apa adanya.",
  );
}

/**
 * Klik satu opsi autocomplete, klik tombol Terapkan/Apply, lalu
 * tunggu URL berubah. Marketplace adalah SPA (biasanya tidak full
 * reload), jadi kita pakai waitForURL berbasis fungsi, dengan
 * fallback fixed-wait kalau URL tidak berubah dalam waktu yang
 * diharapkan (supaya tetap lanjut, bukan gagal total). Setelah itu
 * dicek juga apakah halamannya beneran termuat normal (lihat
 * waitForMarketplaceReady di atas) — kalau macet, di-reload otomatis.
 */
async function applyOptionAndGetUrl(page, optionLocator) {
  const previousUrl = page.url();

  console.log("🖱️ Klik opsi autocomplete...");
  await optionLocator.click();

  const applyButton = page
    .getByRole("button", { name: APPLY_BUTTON_NAME })
    .first();

  console.log("🖱️ Klik tombol Terapkan/Apply...");
  await applyButton.click();

  console.log("⏳ Menunggu URL berubah (page refresh)...");

  try {
    await page.waitForURL((url) => url.href !== previousUrl, {
      timeout: URL_CHANGE_TIMEOUT,
    });
  } catch {
    // Fallback: kasih waktu tambahan lalu ambil URL apa adanya —
    // lebih baik lanjut dengan URL yang mungkin belum 100% final
    // daripada bikin seluruh keyword gagal.
    await page.waitForTimeout(2000);
  }

  await waitForMarketplaceReady(page);

  return page.url();
}

/**
 * Baca teks biru "📍 <kota> · <radius>" yang tampil di pojok
 * kanan-atas Marketplace setelah lokasi berhasil di-apply — ini
 * adalah elemen yang SAMA dengan LOCATION_TRIGGER_SELECTOR (tombol
 * yang bot klik untuk buka modal Ubah Lokasi), tapi sekarang kita
 * baca teksnya untuk dijadikan "kota resmi/terverifikasi" dari
 * hasil autocomplete yang baru saja di-apply.
 *
 * Dipanggil SETELAH applyOptionAndGetUrl() supaya labelnya sudah
 * update ke lokasi yang baru.
 */
async function readActiveLocationLabel(page) {
  const trigger = page.locator(LOCATION_TRIGGER_SELECTOR).first();

  try {
    await trigger.waitFor({ state: "visible", timeout: 8000 });

    const rawText = (await trigger.innerText()).replace(/\s+/g, " ").trim();

    // Formatnya biasanya "<kota> · <radius>" (mis. "Tulungagung · 65 km").
    // Kalau suatu saat formatnya beda (tanpa "·"), rawText tetap
    // disimpan utuh dan activeCity fallback ke rawText itu sendiri.
    const [cityPart, radiusPart] = rawText
      .split("·")
      .map((part) => part?.trim());

    return {
      activeLocationLabel: rawText,
      activeCity: cityPart || rawText || null,
      activeRadius: radiusPart || null,
    };
  } catch (error) {
    console.log(`⚠️ Tidak bisa membaca label lokasi aktif: ${error.message}`);

    return {
      activeLocationLabel: null,
      activeCity: null,
      activeRadius: null,
    };
  }
}

/**
 * Bikin "tanda pengenal" unik dari 1 hasil autocomplete, gabungan
 * nama + detail (termasuk teks "X orang pernah singgah di sini").
 * Dua hasil autocomplete dengan signature yang sama = lokasi yang
 * SAMA PERSIS, walaupun keyword pencariannya beda (mis. "Abar-Abir"
 * vs "Abar-abir" menghasilkan signature yang identik).
 */
function buildOptionSignature(name, detail) {
  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  return `${normalize(name)}|||${normalize(detail)}`;
}

/**
 * Jalankan verifikasi apply+URL untuk semua hasil autocomplete
 * 1 keyword (dipanggil hanya kalau jumlah hasil ≤ VERIFY_MAX_RESULTS).
 *
 * `seenUrls`       — Set URL yang sudah "sukses dicek" sepanjang run.
 * `seenSignatures` — Map signature (nama+detail) -> URL yang sudah
 *                     pernah di-APPLY sepanjang run. Dicek DULU
 *                     sebelum klik apa pun, supaya lokasi yang
 *                     sudah pernah diproses (mis. gara-gara CSV
 *                     punya baris duplikat/beda kapitalisasi) tidak
 *                     diklik Terapkan lagi — cukup dipakai ulang
 *                     hasilnya.
 */
async function verifyOptionsWithUrl(
  page,
  keyword,
  autocompleteResults,
  seenUrls,
  seenSignatures,
) {
  const verified = [];

  for (let i = 0; i < autocompleteResults.length; i++) {
    const item = autocompleteResults[i];

    console.log(`🔎 Verifikasi opsi: ${item.name} (${item.detail})`);

    const signature = buildOptionSignature(item.name, item.detail);

    if (seenSignatures.has(signature)) {
      const cached = seenSignatures.get(signature);

      console.log(
        `♻️ Lokasi "${item.name}" sudah pernah di-apply sebelumnya di run ini — skip klik Terapkan, pakai ulang URL: ${cached.url}`,
      );

      verified.push({
        ...item,
        url: cached.url,
        urlStatus: "duplicate",
        activeLocationLabel: cached.activeLocationLabel,
        activeCity: cached.activeCity,
        activeRadius: cached.activeRadius,
      });

      continue;
    }

    let option = null;

    if (i === 0) {
      // Opsi PERTAMA: dropdown autocomplete kemungkinan besar masih
      // terbuka dari proses scrape sebelumnya (scrapeAutocomplete)
      // untuk keyword yang sama persis — jadi TIDAK perlu ketik ulang
      // keyword-nya lagi, cukup ambil opsi yang sedang tampil di
      // layar. Ini yang sebelumnya bikin bot "mencari 2x" walau
      // hasil autocomplete cuma 1.
      const currentOptions = page.locator('[role="option"]:visible');
      const stillOpen = (await currentOptions.count()) > 0;

      if (stillOpen) {
        option = currentOptions.nth(0);
      }
    }

    if (!option) {
      // Opsi ke-2 dst (dropdown pasti sudah tertutup karena page
      // refresh akibat opsi sebelumnya di-apply), atau dropdown opsi
      // pertama ternyata sudah keburu tertutup — baru di sini kita
      // buka ulang kolom lokasi & ketik ulang keyword-nya.
      try {
        option = await reopenAndFindOption(
          page,
          keyword,
          item.name,
          item.detail,
        );
      } catch (error) {
        console.error(`❌ Gagal membuka ulang kolom lokasi: ${error.message}`);

        verified.push({
          ...item,
          url: null,
          urlStatus: "error",
          error: error.message,
        });

        continue;
      }
    }

    if (!option) {
      console.log(
        `⚠️ Opsi "${item.name}" tidak ditemukan lagi saat dibuka ulang, skip verifikasi.`,
      );

      verified.push({
        ...item,
        url: null,
        urlStatus: "not_found",
      });

      continue;
    }

    try {
      const url = await applyOptionAndGetUrl(page, option);
      const activeLocation = await readActiveLocationLabel(page);

      if (seenUrls.has(url)) {
        console.log(`♻️ URL sudah pernah dicek: ${url}`);

        verified.push({
          ...item,
          url,
          urlStatus: "duplicate",
          ...activeLocation,
        });
      } else {
        seenUrls.add(url);

        console.log(`✅ URL baru, sukses dicek: ${url}`);

        if (activeLocation.activeCity) {
          console.log(`🏷️ Kota terverifikasi: ${activeLocation.activeCity}`);
        }

        verified.push({
          ...item,
          url,
          urlStatus: "new",
          ...activeLocation,
        });
      }

      // Simpan signature -> data lengkap (url + label lokasi aktif)
      // TERLEPAS dari baru/duplikat, supaya keyword lain yang
      // menghasilkan opsi identik di masa depan (dalam run yang
      // sama) bisa langsung skip klik Terapkan tapi tetap dapat
      // data kota-nya.
      seenSignatures.set(signature, { url, ...activeLocation });
    } catch (error) {
      console.error(
        `❌ Gagal verifikasi opsi "${item.name}": ${error.message}`,
      );

      verified.push({
        ...item,
        url: null,
        urlStatus: "error",
        error: error.message,
      });
    }
  }

  return verified;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  const results = [];
  const errors = [];

  // URL yang sudah pernah "sukses dicek" sepanjang run ini —
  // dipakai untuk dedupe di verifyOptionsWithUrl().
  const seenUrls = new Set();

  // Signature (nama+detail hasil autocomplete) yang sudah pernah
  // di-APPLY sepanjang run ini — dicek SEBELUM klik Terapkan, biar
  // lokasi yang sama (mis. gara-gara CSV ada baris duplikat/beda
  // kapitalisasi) tidak diklik Terapkan berkali-kali.
  const seenSignatures = new Map();

  try {
    console.log("");
    console.log("========================================");
    console.log(" FB MARKETPLACE LOCATION SCRAPER");
    console.log("========================================");

    const locations = await loadLocations();

    console.log("");
    console.log("🚀 Menjalankan Chromium...");
    console.log(`💾 Profil browser: ${USER_DATA_DIR}`);

    // launchPersistentContext = browser + context jadi satu, dan
    // datanya (cookies, login, dll) disimpan ke USER_DATA_DIR di disk.
    // Ini menggantikan chromium.launch() + browser.newContext() yang
    // lama, yang sesinya selalu hilang tiap browser ditutup.
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      slowMo: 50,
      viewport: {
        width: 1366,
        height: 768,
      },
    });

    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(FACEBOOK_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    console.log("✅ Marketplace terbuka.");
    console.log("🔐 Login Facebook jika diperlukan (cukup sekali saja).");

    await page.waitForTimeout(5000);

    for (let i = 0; i < locations.length; i++) {
      const keyword = locations[i];

      console.log("");
      console.log("========================================");
      console.log(`📍 ${i + 1}/${locations.length}`);
      console.log(`🔎 ${keyword}`);
      console.log("========================================");

      // Dibuka ulang tiap iterasi (bukan sekali di luar loop seperti
      // sebelumnya) karena verifyOptionsWithUrl() bisa membuat page
      // refresh/navigasi, yang bikin locator lama jadi stale.
      // ensureLocationInput() sendiri sudah murah kalau modal masih
      // terbuka (cek dulu sebelum klik trigger lagi).
      const locationInput = await ensureLocationInput(page);

      const response = await scrapeWithRetry(page, locationInput, keyword);

      if (response.success) {
        let finalResults = response.results;

        if (
          response.results.length > 0 &&
          response.results.length <= VERIFY_MAX_RESULTS
        ) {
          console.log(
            `🧪 ${response.results.length} hasil (≤${VERIFY_MAX_RESULTS}) — lanjut ke verifikasi apply+URL...`,
          );

          finalResults = await verifyOptionsWithUrl(
            page,
            keyword,
            response.results,
            seenUrls,
            seenSignatures,
          );
        } else {
          console.log(
            `⏭️ ${response.results.length} hasil (>${VERIFY_MAX_RESULTS}) — skip verifikasi apply+URL, simpan data autocomplete saja.`,
          );
        }

        const record = {
          keyword,
          results: finalResults,
          resultCount: finalResults.length,
          status: "success",
        };

        results.push(record);

        console.log(`✅ ${finalResults.length} hasil`);
      } else {
        const errorRecord = {
          keyword,
          status: "failed",
          error: response.error,
        };

        errors.push(errorRecord);

        console.log(`❌ Gagal: ${keyword}`);

        results.push({
          keyword,
          results: [],
          resultCount: 0,
          status: "failed",
        });
      }

      saveResults(results);
      saveErrors(errors);
      writeResultsCsv(results, CSV_OUTPUT_FILE);

      console.log("💾 JSON + CSV progress tersimpan.");

      await page.waitForTimeout(BETWEEN_LOCATION_WAIT);
    }

    const successCount = results.filter(
      (item) => item.status === "success",
    ).length;

    const failedCount = results.filter(
      (item) => item.status === "failed",
    ).length;

    const totalAutocomplete = results.reduce(
      (total, item) => total + item.resultCount,
      0,
    );

    console.log("");
    console.log("========================================");
    console.log("🏁 SCRAPING SELESAI");
    console.log("========================================");
    console.log(`📍 Total lokasi : ${locations.length}`);
    console.log(`✅ Berhasil     : ${successCount}`);
    console.log(`❌ Gagal        : ${failedCount}`);
    console.log(`📋 Total hasil  : ${totalAutocomplete}`);
    console.log("");
    console.log(`💾 CSV     : ${CSV_OUTPUT_FILE}`);
    console.log(`💾 JSON    : ${OUTPUT_FILE}`);
    console.log(`⚠️ Errors  : ${ERROR_FILE}`);
    console.log("");
    console.log("⏳ Browser tetap terbuka.");

    await new Promise(() => {});
  } catch (error) {
    console.error("");
    console.error("❌ FATAL ERROR");
    console.error("----------------------------------------");
    console.error(error.message);
    console.error("----------------------------------------");
  }
}

main();
