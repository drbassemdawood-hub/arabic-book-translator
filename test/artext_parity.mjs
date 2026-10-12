// Verify js/artext.js (shaping + bidi) against the reference Python
// implementations (arabic-reshaper + python-bidi). Run: node artext_parity.mjs
// (test/gen_artext_oracle.py must have produced /tmp/artext_oracle.json first)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArabicLayout } from "../js/artext.js";

const require = createRequire(import.meta.url);
const reshaper = require("arabic-reshaper");
const bidiFactory = require("bidi-js");

const layout = makeArabicLayout({
  reshape: reshaper.convertArabic,
  bidi: bidiFactory(),
  measure: (s) => s.length, // measurement irrelevant for single-line parity
});

const cases = JSON.parse(readFileSync(join(tmpdir(), "artext_oracle.json"), "utf-8"));
let ok = 0;
let known = 0;
const failures = [];
for (const c of cases) {
  const visual = layout.toVisual(reshaper.convertArabic(c.src));
  if (visual === c.py_visual) {
    ok++;
  } else if (visual.replaceAll("ﻪﻠﻟﺍ", "ﷲ") === c.py_visual) {
    // known cosmetic difference: the Python reshaper substitutes the optional
    // single-glyph Allah ligature (U+FDF2); letter-by-letter is equally valid
    known++;
  } else {
    failures.push({ src: c.src, js: visual, py: c.py_visual });
  }
}
for (const f of failures) {
  console.log("FAIL:", JSON.stringify(f.src));
  console.log("  js:", JSON.stringify(f.js));
  console.log("  py:", JSON.stringify(f.py));
}
console.log(`${ok} exact + ${known} known-cosmetic of ${cases.length} cases, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
