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

/**
 * Convert scraper records into a flat CSV.
 * One autocomplete result = one CSV row.
 */
export function writeResultsCsv(results, outputFile) {
  const rows = [
    ["Keyword", "Name", "Detail", "Status"],
  ];

  for (const record of results) {
    if (record.results?.length) {
      for (const item of record.results) {
        rows.push([
          record.keyword,
          item.name,
          item.detail,
          record.status,
        ]);
      }
    } else {
      rows.push([
        record.keyword,
        "",
        "",
        record.status,
      ]);
    }
  }

  const csv = rows
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\r\n");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `\ufeff${csv}\r\n`, "utf8");
}
