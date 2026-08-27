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
  const uniqueLocations = [...new Set(locations)];

  if (uniqueLocations.length === 0) {
    throw new Error("Tidak ada lokasi di dalam CSV.");
  }

  console.log(`📊 Total lokasi: ${uniqueLocations.length}`);

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

  console.log(`📋 Option ditemukan: ${count}`);

  const results = [];

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

    results.push({
      name: values[0] ?? "",
      detail: values[1] ?? "",
    });
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
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  let browser;

  const results = [];
  const errors = [];

  try {
    console.log("");
    console.log("========================================");
    console.log(" FB MARKETPLACE LOCATION SCRAPER");
    console.log("========================================");

    const locations = await loadLocations();

    console.log("");
    console.log("🚀 Menjalankan Chromium...");

    browser = await chromium.launch({
      headless: false,
      slowMo: 50,
    });

    const context = await browser.newContext({
      viewport: {
        width: 1366,
        height: 768,
      },
    });

    const page = await context.newPage();

    await page.goto(FACEBOOK_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    console.log("✅ Marketplace terbuka.");
    console.log("🔐 Login Facebook jika diperlukan.");

    await page.waitForTimeout(5000);

    const locationInput = page
      .locator('input[role="combobox"][aria-label="Location"]')
      .first();

    await locationInput.waitFor({
      state: "visible",
      timeout: 60_000,
    });

    console.log("✅ Input Location ditemukan.");

    for (let i = 0; i < locations.length; i++) {
      const keyword = locations[i];

      console.log("");
      console.log("========================================");
      console.log(`📍 ${i + 1}/${locations.length}`);
      console.log(`🔎 ${keyword}`);
      console.log("========================================");

      const response = await scrapeWithRetry(page, locationInput, keyword);

      if (response.success) {
        const record = {
          keyword,
          results: response.results,
          resultCount: response.results.length,
          status: "success",
        };

        results.push(record);

        console.log(`✅ ${response.results.length} hasil`);
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
