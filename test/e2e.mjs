/* End-to-end tests: run the real UI in headless Chromium with the Anthropic
 * API mocked at the network layer (SSE), covering every input format, the
 * scanned-PDF OCR path, cancel + resume, downloads, and the print view.
 *
 *   node e2e.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = join(ROOT, "test", "samples");
const ARTIFACTS = join(ROOT, "test", "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

const PORT = 8077;
const MARKER = "The golden falcon returned at dawn.";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// ------------------------------------------------------------ static server

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const file = join(ROOT, path === "/" ? "index.html" : path.slice(1));
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

// ---------------------------------------------------------------- API mock

function sse(text) {
  const events = [
    { type: "message_start", message: { id: "msg_mock", usage: { input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ];
  // split the text into a few deltas to exercise the SSE parser
  const step = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += step) {
    events.push({
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: text.slice(i, i + step) },
    });
  }
  events.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join("\n") + "\n";
}

function makeMock() {
  const state = {
    translateCalls: 0, reviewCalls: 0, ocrCalls: 0, countTokensCalls: 0,
    sources: [], delayMs: 100,
  };
  state.handler = async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        },
      });
      return;
    }
    const url = req.url();
    const cors = { "access-control-allow-origin": "*" };
    await new Promise((r) => setTimeout(r, state.delayMs));

    if (url.endsWith("/count_tokens")) {
      state.countTokensCalls++;
      await route.fulfill({
        status: 200, headers: cors, contentType: "application/json",
        body: JSON.stringify({ input_tokens: 1000 }),
      });
      return;
    }

    const body = JSON.parse(req.postData());
    const content = body.messages[0].content;

    if (Array.isArray(content) && content.some((b) => b.type === "image")) {
      state.ocrCalls++;
      await route.fulfill({
        status: 200, headers: cors, contentType: "text/event-stream",
        body: sse(`Scanned page mock text number ${state.ocrCalls}. It reads like a real page.`),
      });
      return;
    }

    const isReview = (body.system?.[0]?.text || "").includes("bilingual editor");
    if (isReview) state.reviewCalls++;
    else {
      state.translateCalls++;
      state.sources.push(String(content));
    }
    // Arabic output with the same paragraph count as the source passage
    const passage = String(content).split(/Translate (?:ONLY the following passage|this passage):\n\n/).pop();
    const nPars = passage.split("\n\n").filter((p) => p.trim()).length || 1;
    const arabic = Array.from({ length: nPars }, (_, i) =>
      i === 1
        ? `فقرة مترجمة رقم ${i + 1} فيها اسم أجنبي Baker Street 221 وسط النص العربي.`
        : `فقرة مترجمة رقم ${i + 1} — نصٌ عربيّ تجريبي.`).join("\n\n");
    await route.fulfill({
      status: 200, headers: cors, contentType: "text/event-stream",
      body: sse(isReview ? `${arabic} (مراجَعة)` : arabic),
    });
  };
  return state;
}

// ------------------------------------------------------------------ helpers

async function newPage(browser, mock) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.route("https://api.anthropic.com/**", mock.handler);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/`);
  return { context, page };
}

async function setup(page, file, { review = false, txt = false, pdf = false, speed = null } = {}) {
  await page.click("#open-key");
  await page.fill("#api-key", "sk-ant-mock-key");
  await page.click("#key-save");
  await page.setInputFiles("#file-input", file);
  if (!review) await page.uncheck("#review");
  else await page.check("#review");
  if (txt) await page.check("#fmt-txt");
  if (!pdf) await page.uncheck("#fmt-pdf");
  if (speed) await page.selectOption("#speed", speed);
}

const doneLog = (page) =>
  page.waitForFunction(() => document.getElementById("log").textContent.includes("Translation complete"),
    null, { timeout: 60000 });

async function idbCounts(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("book-translator");
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(["headers", "records"], "readonly");
      const out = {};
      t.objectStore("headers").count().onsuccess = (e) => { out.headers = e.target.result; };
      t.objectStore("records").count().onsuccess = (e) => { out.records = e.target.result; };
      t.oncomplete = () => { db.close(); resolve(out); };
    };
    req.onerror = () => resolve({ headers: -1, records: -1 });
  }));
}

const browser = await chromium.launch().catch(() =>
  chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }));

// ====================================================== flow 0: key modal UX
console.log("\nFlow 0 — API key lives in a modal, not on the page");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  check("key input hidden on load", !(await page.isVisible("#api-key")));
  await page.setInputFiles("#file-input", join(SAMPLES, "sample.txt"));
  await page.click("#start-btn");
  check("start without key opens the key modal", await page.isVisible("#key-modal"));
  await page.fill("#api-key", "sk-ant-mock-key");
  await page.click("#key-save");
  // saving from that modal auto-continues the start
  await doneLog(page);
  check("run continued automatically after saving the key", true);
  await context.close();
}

// ================================================================ flow 1: txt
console.log("\nFlow 1 — .txt book, two-pass review, docx+pdf+txt downloads");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample.txt"), { review: true, txt: true, pdf: true });

  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#start-btn");
  await doneLog(page);

  check("results panel visible", await page.isVisible("#results"));
  check("one translate call (single chunk)", mock.translateCalls === 1, `got ${mock.translateCalls}`);
  check("one review call", mock.reviewCalls === 1, `got ${mock.reviewCalls}`);
  check("cost estimate ran", mock.countTokensCalls === 1);
  const log = await page.textContent("#log");
  check("estimate in log", /Estimated size .* rough cost/.test(log));
  check("source reached the API", mock.sources[0].includes("ancient") || mock.sources[0].includes("library"));

  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Writing the PDF"),
    null, { timeout: 20000 });
  await page.waitForTimeout(2500); // let the pdf build + downloads land
  check("auto-downloads fired (docx+pdf+txt)", downloads.length === 3, `got ${downloads.length}`);
  for (const d of downloads) {
    await d.saveAs(join(ARTIFACTS, d.suggestedFilename()));
  }
  check("pdf among downloads", downloads.some((d) => d.suggestedFilename().endsWith(".ar.pdf")));

  // manual download buttons too
  const [docxDl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-docx")]);
  await docxDl.saveAs(join(ARTIFACTS, "manual-" + docxDl.suggestedFilename()));

  // print view
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#dl-print")]);
  await popup.waitForLoadState("domcontentloaded");
  const popupText = await popup.textContent("body");
  check("print view shows Arabic", popupText.includes("فقرة مترجمة"));
  check("print view has title", (await popup.textContent("h1")).includes("sample"));
  await popup.close();

  const counts = await idbCounts(page);
  check("state cleared after completion", counts.headers === 0 && counts.records === 0,
    JSON.stringify(counts));

  await page.screenshot({ path: join(ARTIFACTS, "ui-done.png"), fullPage: true });
  await context.close();
}

// ===================================================== flow 2: docx/epub/pdf
for (const name of ["sample.docx", "sample.epub", "sample.pdf"]) {
  console.log(`\nFlow 2 — extraction pipeline: ${name}`);
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, name));
  await page.click("#start-btn");
  await doneLog(page);
  const allSources = mock.sources.join("\n");
  check(`${name}: marker phrase extracted`, allSources.includes(MARKER));
  check(`${name}: chapter title extracted`, allSources.includes("The Lantern"));
  await context.close();
}

// ======================================================= flow 3: scanned pdf
console.log("\nFlow 3 — scanned PDF → Claude vision OCR");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "scanned.pdf"));
  await page.click("#start-btn");
  await doneLog(page);
  const log = await page.textContent("#log");
  check("scanned pages detected", /2 of 3 pages have no text layer/.test(log), log.split("\n")[2]);
  check("OCR cost estimate shown", /vision OCR of 2 pages ≈ \$/.test(log));
  check("two OCR vision calls", mock.ocrCalls === 2, `got ${mock.ocrCalls}`);
  const allSources = mock.sources.join("\n");
  check("OCR text fed into translation", allSources.includes("Scanned page mock text"));
  check("digital page text kept", allSources.includes("real text layer"));
  await context.close();
}

// ===================================================== flow 4: cancel+resume
console.log("\nFlow 4 — cancel mid-run, then resume without re-paying");
{
  // a book big enough for 6 chunks
  const big = Array.from({ length: 900 },
    (_, i) => `Paragraph number ${i}. It has several sentences. They fill space nicely.`).join("\n\n");
  const bigPath = join(ARTIFACTS, "big.txt");
  writeFileSync(bigPath, big);

  const mock = makeMock();
  mock.delayMs = 250;
  const { context, page } = await newPage(browser, mock);
  await setup(page, bigPath);
  await page.click("#start-btn");

  await page.waitForFunction(
    () => /^2\/\d+ passages/.test(document.getElementById("status-text").textContent),
    null, { timeout: 30000 });
  await page.click("#cancel-btn");
  await page.waitForFunction(
    () => document.getElementById("log").textContent.includes("Cancelled. Progress saved"),
    null, { timeout: 30000 });

  const callsBefore = mock.translateCalls;
  const counts = await idbCounts(page);
  check("progress persisted on cancel", counts.records >= 2, JSON.stringify(counts));

  await page.click("#start-btn");
  await page.waitForSelector("#resume-modal", { state: "visible", timeout: 15000 });
  const resumeText = await page.textContent("#resume-text");
  const m = resumeText.match(/translated (\d+) of (\d+) passages/);
  check("resume modal reports progress", !!m, resumeText);
  await page.click("#resume-yes");
  await doneLog(page);

  const total = Number(m[2]);
  const doneBefore = Number(m[1]);
  const log = await page.textContent("#log");
  check("log shows resuming", log.includes(`Resuming: ${doneBefore}/${total}`));
  check("no passage paid twice",
    mock.translateCalls === callsBefore + (total - doneBefore),
    `before=${callsBefore} after=${mock.translateCalls} total=${total} done=${doneBefore}`);
  const after = await idbCounts(page);
  check("state cleared after resumed completion", after.headers === 0 && after.records === 0);
  await context.close();
}

// ====================================================== flow 5: parallel mode
console.log("\nFlow 5 — Fastest (6 parallel) still completes and orders output");
{
  const big = Array.from({ length: 600 },
    (_, i) => `Passage paragraph ${i}. More filler text to reach several chunks.`).join("\n\n");
  const bigPath = join(ARTIFACTS, "big2.txt");
  writeFileSync(bigPath, big);
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, bigPath, { txt: true, speed: "Fastest — 6 passages in parallel" });
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#start-btn");
  await doneLog(page);
  check("multiple chunks translated", mock.translateCalls >= 4, `got ${mock.translateCalls}`);
  await page.waitForTimeout(700);
  const txtDl = downloads.find((d) => d.suggestedFilename().endsWith(".txt"));
  check("txt produced in parallel mode", !!txtDl);
  if (txtDl) await txtDl.saveAs(join(ARTIFACTS, "parallel.ar.txt"));
  await context.close();
}

// =================================================== flow 6: error handling
console.log("\nFlow 6 — invalid API key shows the friendly desktop message");
{
  const mock = makeMock();
  const orig = mock.handler;
  mock.handler = async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return orig(route);
    await route.fulfill({
      status: 401, headers: { "access-control-allow-origin": "*" },
      contentType: "application/json",
      body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    });
  };
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample.txt"));
  await page.click("#start-btn");
  await page.waitForFunction(
    () => document.getElementById("log").textContent.includes("Invalid API key"),
    null, { timeout: 20000 });
  check("friendly auth error", true);
  check("start re-enabled after failure", !(await page.isDisabled("#start-btn")));
  await context.close();
}

// ------------------------------------------------------------------- report
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
