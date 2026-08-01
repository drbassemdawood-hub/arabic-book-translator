/* Smoke test against the LIVE production site (API mocked). */
import { chromium } from "playwright";
import { join } from "node:path";

const SITE = "https://arabic-book-translator.vercel.app";
const SAMPLES = join(process.cwd(), "samples");
let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch().catch(() => chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }));
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const failures = [];
page.on("requestfailed", r => { if (!r.url().includes("fonts.g")) failures.push(r.url()); });
page.on("pageerror", e => failures.push("pageerror: " + e.message));

let translateCalls = 0;
await page.route("https://api.anthropic.com/**", async route => {
  const req = route.request();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.url().endsWith("/count_tokens"))
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: '{"input_tokens":1000}' });
  translateCalls++;
  const text = "ترجمة تجريبية من الموقع المنشور.";
  const body = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
  return route.fulfill({ status: 200, headers: cors, contentType: "text/event-stream", body });
});

const resp = await page.goto(SITE, { waitUntil: "networkidle" });
check("site loads (HTTP 200)", resp.status() === 200, String(resp.status()));
check("title correct", (await page.title()).includes("Book Translator"));
check("GitHub link points to repo", (await page.getAttribute("#github-link", "href")).includes("drbassemdawood-hub/arabic-book-translator"));

// full mocked run on the live site — proves js/ + vendor/ all deployed correctly
await page.fill("#api-key", "sk-ant-smoke");
await page.setInputFiles("#file-input", join(SAMPLES, "sample.pdf")); // PDF exercises vendored pdf.js + worker
await page.uncheck("#review");
const downloads = [];
page.on("download", d => downloads.push(d));
await page.click("#start-btn");
await page.waitForFunction(() => document.getElementById("log").textContent.includes("Translation complete"), null, { timeout: 60000 });
check("full mocked translation on live site", true);
check("pdf.js worker loaded from live vendor/", translateCalls >= 1);
await page.waitForTimeout(700);
check("docx download produced", downloads.some(d => d.suggestedFilename().endsWith(".ar.docx")));
check("no failed asset requests / page errors", failures.length === 0, failures.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
