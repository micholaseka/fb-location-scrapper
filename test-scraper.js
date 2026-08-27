import { runScraper } from "./scraper.js";

const csvPath = process.argv[2];

if (!csvPath) {
  console.error("Gunakan:");
  console.error("node test-scraper.js lokasi.csv");
  process.exit(1);
}

console.log("TEST SCRAPER");
console.log("CSV:", csvPath);

try {
  const result = await runScraper(csvPath, {
    onProgress(progress) {
      console.log(
        `[PROGRESS] ${progress.current}/${progress.total} - ${progress.keyword}`
      );
    },
  });

  console.log("");
  console.log("TEST BERHASIL");
  console.log(result);

} catch (error) {
  console.error("");
  console.error("TEST GAGAL");
  console.error(error);
  process.exit(1);
}
