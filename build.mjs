/* Assemble the static site into dist/ (used by the Vercel build).
 *
 * The site itself needs no compilation — this script just copies the source
 * files and refreshes vendor/ from node_modules (falling back to the committed
 * vendor/ copies if node_modules is absent).
 */
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "vendor"), { recursive: true });

for (const f of ["index.html", "styles.css"]) cpSync(join(ROOT, f), join(DIST, f));
cpSync(join(ROOT, "js"), join(DIST, "js"), { recursive: true });

// vendor libraries: prefer node_modules (pdf.js "legacy" build = wider browser support)
const VENDOR = [
  ["node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", "pdf.min.mjs"],
  ["node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["node_modules/jszip/dist/jszip.min.js", "jszip.min.js"],
];
for (const [src, name] of VENDOR) {
  const from = existsSync(join(ROOT, src)) ? join(ROOT, src) : join(ROOT, "vendor", name);
  cpSync(from, join(DIST, "vendor", name));
}
console.log("built dist/");
