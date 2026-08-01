// Compare the JS chunker's output against the Python original's.
import { readFileSync } from "node:fs";
import { chunkText } from "../js/chunk.js";

const cases = JSON.parse(readFileSync(process.argv[2], "utf-8"));
let failures = 0;

for (const [name, { text, chunks: expected }] of Object.entries(cases)) {
  const got = chunkText(text);
  const same =
    got.length === expected.length && got.every((c, i) => c === expected[i]);
  if (same) {
    console.log(`OK   ${name} (${got.length} chunks)`);
  } else {
    failures++;
    console.log(`FAIL ${name}: js=${got.length} chunks, py=${expected.length}`);
    for (let i = 0; i < Math.max(got.length, expected.length); i++) {
      if (got[i] !== expected[i]) {
        console.log(`  first diff at chunk ${i}:`);
        console.log(`    js: ${JSON.stringify((got[i] || "").slice(0, 120))}`);
        console.log(`    py: ${JSON.stringify((expected[i] || "").slice(0, 120))}`);
        break;
      }
    }
  }
}
process.exit(failures ? 1 : 0);
