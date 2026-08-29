import fs from "node:fs";
import path from "node:path";

/**
 * Escape a value so it is safe inside a CSV cell.
 */
function escapeCsvValue(value) {
  const text = String(value ?? "");

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/*
|--------------------------------------------------------------------------
| KOLOM CSV
|--------------------------------------------------------------------------
|
| "Kota Terverifikasi" & "Radius" diambil dari teks biru
| "📍 <kota> · <radius>" yang tampil di Marketplace setelah lokasi
| di-apply (dibaca oleh readActiveLocationLabel() di scraper.js) —
| ini dianggap sebagai kota RESMI dari hasil autocomplete tersebut,
| bukan sekadar teks mentah dari dropdown autocomplete.
|
| Kolom ini HANYA terisi untuk keyword yang lolos verifikasi
| apply+URL (hasil autocomplete <= 2). Untuk keyword yang di-skip
| dari verifikasi (>2 hasil), kolom ini dikosongkan.
|
*/
const HEADERS = [
  "Keyword Dicari",
  "Nama (Autocomplete)",
  "Detail (Autocomplete)",
  "Kota Terverifikasi",
  "Radius",
  "Status Scrape",
  "Status URL",
  "URL Marketplace",
];

/**
 * Convert scraper records into a flat, mudah-dibaca CSV.
 * Satu hasil autocomplete = satu baris CSV.
 *
 * "Status URL" yang mungkin muncul:
 *   - "new"       -> URL baru, sukses dicek
 *   - "duplicate" -> lokasi ini sudah pernah di-apply sebelumnya
 *                    di run yang sama (URL atau signature-nya sama)
 *   - "not_found" -> opsi autocomplete tidak ketemu lagi saat verifikasi
 *   - "error"     -> proses verifikasi gagal (detail error ada di JSON)
 *   - "" (kosong) -> keyword ini punya >2 hasil autocomplete, jadi
 *                    verifikasi apply+URL di-skip sepenuhnya
 */
export function writeResultsCsv(results, outputFile) {
  const rows = [HEADERS];

  for (const record of results) {
    if (record.results?.length) {
      for (const item of record.results) {
        rows.push([
          record.keyword,
          item.name,
          item.detail,
          item.activeCity ?? "",
          item.activeRadius ?? "",
          record.status,
          item.urlStatus ?? "",
          item.url ?? "",
        ]);
      }
    } else {
      rows.push([record.keyword, "", "", "", "", record.status, "", ""]);
    }
  }

  const csv = rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `\ufeff${csv}\r\n`, "utf8");
}
