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
    sources: [], systems: [], reviewSystems: [], ocrSystems: [], delayMs: 100,
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
      state.ocrSystems.push(body.system?.[0]?.text || "");
      const arabicBook = (body.system?.[0]?.text || "").includes("written in Arabic");
      await route.fulfill({
        status: 200, headers: cors, contentType: "text/event-stream",
        body: sse(arabicBook
          ? `صفحة ممسوحة تجريبية رقم ${state.ocrCalls}. تُقرأ مثل صفحة حقيقية.`
          : `Scanned page mock text number ${state.ocrCalls}. It reads like a real page.`),
      });
      return;
    }

    const system = body.system?.[0]?.text || "";
    const isReview = system.includes("bilingual editor");
    if (isReview) {
      state.reviewCalls++;
      state.reviewSystems.push(system);
    } else {
      state.translateCalls++;
      state.sources.push(String(content));
      state.systems.push(system);
    }
    // output in the requested target language, same paragraph count as the source passage
    const tgt = targetOf(system);
    const passage = isReview
      ? String(content).split(/DRAFT [A-Z]+ TRANSLATION:\n\n/).pop()
      : String(content).split(/Translate (?:ONLY the following passage|this passage):\n\n/).pop();
    const nPars = passage.split("\n\n").filter((p) => p.trim()).length || 1;
    const out = Array.from({ length: nPars }, (_, i) => OUT_TEXT[tgt](i)).join("\n\n");
    await route.fulfill({
      status: 200, headers: cors, contentType: "text/event-stream",
      body: sse(isReview ? `${out}${REVIEW_SUFFIX[tgt]}` : out),
    });
  };
  return state;
}

/** Which language the system prompt asks for. */
function targetOf(system) {
  const m = system.match(/book into ([^.\n]+)/) || system.match(/reviewing an? (\w+) translation/);
  const name = m ? m[1] : "Arabic";
  if (/Chinese/.test(name)) return "zh";
  if (/Ukrainian/.test(name)) return "uk";
  if (/German/.test(name)) return "de";
  if (/English/.test(name)) return "en";
  return "ar";
}

// mock translations (original test sentences); paragraph 2 of each mixes scripts
const OUT_TEXT = {
  ar: (i) => (i === 1
    ? `فقرة مترجمة رقم ${i + 1} فيها اسم أجنبي Baker Street 221 وسط النص العربي.`
    : `فقرة مترجمة رقم ${i + 1} — نصٌ عربيّ تجريبي.`),
  en: (i) => (i === 1
    ? `Translated paragraph ${i + 1} keeps the Arabic word صبر inside an English sentence.`
    : `Translated paragraph ${i + 1} — a plain English test sentence.`),
  uk: (i) => `Перекладений абзац ${i + 1} — український текст із літерами ї, є, ґ та словом м’ята.`,
  zh: (i) => `这是第${i + 1}段译文，包含中文标点符号：逗号、句号，以及英文名称 Baker Street 221。` +
    (i === 1 ? "为了测试自动换行，这一段特意写得很长很长，".repeat(6) + "到此结束。" : ""),
  de: (i) => `Übersetzter Absatz ${i + 1} — mit „Anführungszeichen“, Umlauten äöü und dem Buchstaben ß.`,
};
const REVIEW_SUFFIX = { ar: " (مراجَعة)", en: " (reviewed)", uk: " (перевірено)", zh: "（已校对）", de: " (geprüft)" };

// ------------------------------------------------------------------ helpers

async function newPage(browser, mock) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.route("https://api.anthropic.com/**", mock.handler);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/`);
  return { context, page };
}

async function setup(page, file, { review = false, txt = false, pdf = false, speed = null, pair = null } = {}) {
  await page.click("#open-key");
  await page.fill("#api-key", "sk-ant-mock-key");
  await page.click("#key-save");
  if (pair) await page.selectOption("#pair", pair);
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

// Playwright's own Chromium if installed, else Edge/Chrome already on the machine
async function launchBrowser() {
  for (const opts of [{}, { channel: "msedge" }, { channel: "chrome" },
                      { executablePath: "/opt/pw-browsers/chromium" }]) {
    try {
      return await chromium.launch(opts);
    } catch { /* try the next one */ }
  }
  throw new Error("No Chromium-based browser available for the tests.");
}
async function idbHeaderIds(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("book-translator");
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction("headers", "readonly").objectStore("headers").getAllKeys();
      r.onsuccess = () => { db.close(); resolve(r.result); };
    };
    req.onerror = () => resolve([]);
  }));
}

const browser = await launchBrowser();

// A correct digital Arabic PDF, printed by the browser from the sample HTML
// (PyMuPDF's own Arabic PDF has a corrupted character map — kept as the
// corrupted-text-layer fixture).
for (const name of ["sample_ar", "sample_en_quotes"]) {
  const p = await browser.newPage();
  await p.goto(`http://localhost:${PORT}/test/samples/${name}.html`);
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: join(SAMPLES, `${name}.pdf`), format: "A4" });
  await p.close();
}

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
  check("scanned pages detected", /2 of 3 pages need OCR/.test(log), log.split("\n")[2]);
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
  const keys = await idbHeaderIds(page);
  check("English→Arabic keeps its pre-language-pairs key (old runs still resume)",
    keys.length === 1 && /^tr:[0-9a-f]{16}$/.test(keys[0]), JSON.stringify(keys));

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

// ====================================================== language pairs
const MARKERS = {
  en: MARKER,
  ar: "عاد الصقر الذهبي عند الفجر.",
  zh: "金色的猎鹰在黎明时分归来。",
  uk: "Золотий сокіл повернувся на світанку.",
  de: "Der goldene Falke kehrte im Morgengrauen zurück.",
};
const NAMES = { en: "English", ar: "Arabic", zh: "Chinese", uk: "Ukrainian", de: "German" };
const PAIRS = ["en-ar", "ar-en", "ar-uk", "uk-ar", "ar-zh", "zh-ar", "ar-de", "de-ar"];

console.log("\nFlow 7 — every language pair: PDF in the source language → Word + PDF + text in the target");
{
  const { context, page } = await newPage(browser, makeMock());
  const options = await page.$$eval("#pair option", (os) => os.map((o) => [o.value, o.textContent]));
  check("menu offers exactly the 8 directions",
    JSON.stringify(options.map(([v]) => v)) === JSON.stringify(PAIRS), JSON.stringify(options));
  check("menu labels read naturally", options.some(([v, t]) => v === "ar-zh" && t === "Arabic → Chinese (Mandarin)"));
  check("English → Arabic is the default", (await page.inputValue("#pair")) === "en-ar");
  await context.close();
}
for (const pair of PAIRS) {
  const [src, tgt] = pair.split("-");
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  const sample = src === "en" ? "sample.pdf" : `sample_${src}.pdf`;
  await setup(page, join(SAMPLES, sample), { pair, review: true, txt: true, pdf: true });
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#start-btn");
  await doneLog(page);
  await page.waitForTimeout(3000); // PDF build + downloads (the Chinese font is ~3 MB)

  const log = await page.textContent("#log");
  check(`${pair}: translate prompt is ${NAMES[src]} → ${NAMES[tgt]}`,
    mock.systems.length > 0 && mock.systems.every((s) => s.includes(`${NAMES[src]} book into`) && s.includes(NAMES[tgt])),
    mock.systems[0]?.split("\n")[0]);
  check(`${pair}: review pass ran with matching labels`,
    mock.reviewCalls >= 1 && mock.reviewSystems.every((s) => s.includes(`${NAMES[src]} source`)));
  check(`${pair}: source marker extracted from the PDF`,
    mock.sources.join("\n").includes(MARKERS[src]),
    mock.sources.join("\n").slice(0, 300).replace(/\n/g, " ⏎ "));
  check(`${pair}: no false language warning`, !/looks like/.test(log));
  check(`${pair}: no missing-glyph warning in the PDF`, !/no glyph/.test(log), log.split("\n").filter((l) => /glyph/.test(l)).join(" | "));
  const names = downloads.map((d) => d.suggestedFilename());
  check(`${pair}: downloads named .${tgt}.docx/.pdf/.txt`,
    ["docx", "pdf", "txt"].every((ext) => names.some((n) => n.endsWith(`.${tgt}.${ext}`))), JSON.stringify(names));
  for (const d of downloads) {
    const ext = d.suggestedFilename().split(".").pop();
    await d.saveAs(join(ARTIFACTS, `pair-${pair}.${ext}`));
  }
  // print view direction follows the target language
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#dl-print")]);
  await popup.waitForLoadState("domcontentloaded");
  const dir = await popup.getAttribute("html", "dir");
  check(`${pair}: print view is ${tgt === "ar" ? "rtl" : "ltr"}`, dir === (tgt === "ar" ? "rtl" : "ltr"), dir);
  await popup.close();
  await context.close();
}

console.log("\nFlow 8 — legacy-encoded .txt and .docx books in other languages");
for (const [file, pair] of [["sample_ar_legacy.txt", "ar-en"], ["sample_zh_legacy.txt", "zh-ar"],
                            ["sample_uk_legacy.txt", "uk-ar"], ["sample_ar.docx", "ar-de"],
                            ["sample_zh.docx", "zh-ar"], ["sample_de.txt", "de-ar"]]) {
  const src = pair.split("-")[0];
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, file), { pair });
  await page.click("#start-btn");
  await doneLog(page);
  check(`${file}: decoded and extracted (marker found)`, mock.sources.join("\n").includes(MARKERS[src]));
  await context.close();
}

console.log("\nFlow 9 — wrong language pair is caught BEFORE any paid request");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample.txt"), { pair: "ar-en" }); // an English book, "Arabic → English"
  await page.click("#start-btn");
  await page.waitForSelector("#lang-modal", { state: "visible", timeout: 15000 });
  check("mismatch dialog names the real language", (await page.textContent("#lang-text")).includes("looks like English"));
  await page.click("#lang-no");
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Stopped before translating"),
    null, { timeout: 15000 });
  check("stopping costs nothing (no translate / token-count calls)",
    mock.translateCalls === 0 && mock.countTokensCalls === 0, `translate=${mock.translateCalls} count=${mock.countTokensCalls}`);
  check("start re-enabled after stopping", !(await page.isDisabled("#start-btn")));
  // and "Translate anyway" proceeds
  await page.click("#start-btn");
  await page.waitForSelector("#lang-modal", { state: "visible", timeout: 15000 });
  await page.click("#lang-yes");
  await doneLog(page);
  check("'Translate anyway' completes the run", mock.translateCalls >= 1);
  await context.close();
}

console.log("\nFlow 10 — Arabic PDF with a corrupted text layer is read with OCR");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_ar_garbled.pdf"), { pair: "ar-en" });
  await page.click("#start-btn");
  await doneLog(page);
  const log = await page.textContent("#log");
  check("corrupted text layer detected", /2 of 2 pages have a corrupted text layer/.test(log),
    log.split("\n").slice(0, 4).join(" | "));
  check("both pages sent to OCR", mock.ocrCalls === 2, `got ${mock.ocrCalls}`);
  check("OCR told the book is Arabic", mock.ocrSystems.every((s) => s.includes("written in Arabic")));
  check("OCR text (not gibberish) was translated", mock.sources.join("\n").includes("صفحة ممسوحة تجريبية") &&
    !/[܀-ݏঀ-৿]/.test(mock.sources.join("\n")));
  await context.close();
}

console.log("\nFlow 11 — progress is kept per language pair; the choice is remembered");
{
  const big = Array.from({ length: 900 },
    (_, i) => `Абзац номер ${i}. Він має кілька речень. Вони заповнюють місце.`).join("\n\n");
  const bigPath = join(ARTIFACTS, "big_uk.txt");
  writeFileSync(bigPath, big);
  const mock = makeMock();
  mock.delayMs = 250;
  const { context, page } = await newPage(browser, mock);
  await setup(page, bigPath, { pair: "uk-ar" });
  await page.click("#start-btn");
  await page.waitForFunction(
    () => /^1\/\d+ passages/.test(document.getElementById("status-text").textContent), null, { timeout: 30000 });
  await page.click("#cancel-btn");
  await page.waitForFunction(
    () => document.getElementById("log").textContent.includes("Cancelled. Progress saved"), null, { timeout: 30000 });
  const keys = await idbHeaderIds(page);
  check("progress key carries the pair", keys.some((k) => /^tr:[0-9a-f]{16}:uk-ar$/.test(k)), JSON.stringify(keys));
  await page.reload();
  check("pair choice remembered after reload", (await page.inputValue("#pair")) === "uk-ar");
  await context.close();
}

console.log("\nFlow 12 — wrong pair on a GOOD Arabic PDF: dialog first, zero OCR / translation spend");
for (const ocrOff of [false, true]) {
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_ar.pdf"), { pair: "en-ar" }); // the default pair, an Arabic book
  if (ocrOff) await page.selectOption("#ocr", { index: 1 });
  await page.click("#start-btn");
  await page.waitForSelector("#lang-modal", { state: "visible", timeout: 15000 });
  const label = ocrOff ? "OCR off" : "OCR on";
  check(`${label}: dialog says the book looks like Arabic`, (await page.textContent("#lang-text")).includes("looks like Arabic"));
  check(`${label}: no OCR paid before the dialog`, mock.ocrCalls === 0, `ocr=${mock.ocrCalls}`);
  await page.click("#lang-no");
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Stopped before translating"),
    null, { timeout: 15000 });
  check(`${label}: stopping costs nothing at all`,
    mock.ocrCalls + mock.translateCalls + mock.countTokensCalls === 0,
    `ocr=${mock.ocrCalls} translate=${mock.translateCalls} count=${mock.countTokensCalls}`);
  check(`${label}: no misleading 'corrupted text layer' message`,
    !/corrupted text layer/.test(await page.textContent("#log")));
  await context.close();
}

console.log("\nFlow 13 — legacy encodings are detected, not guessed");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_zh_big5.txt"), { pair: "zh-ar" });
  await page.click("#start-btn");
  await doneLog(page);
  check("Big5 Traditional Chinese book decoded correctly", mock.sources.join("\n").includes("金色的獵鷹在黎明時分歸來。"));
  await context.close();
}
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_ar_legacy.txt"), { pair: "en-ar" }); // old-encoding Arabic, wrong pair
  await page.click("#start-btn");
  await page.waitForSelector("#lang-modal", { state: "visible", timeout: 15000 });
  check("old-encoding Arabic .txt under the wrong pair: dialog names Arabic (not 'German')",
    (await page.textContent("#lang-text")).includes("looks like Arabic"), await page.textContent("#lang-text"));
  await page.click("#lang-no");
  await context.close();
}

console.log("\nFlow 14 — English PDF quoting Arabic: no OCR, text layer used (English → Arabic regression)");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_en_quotes.pdf"), { pair: "en-ar" });
  await page.click("#start-btn");
  await doneLog(page);
  const log = await page.textContent("#log");
  check("no page sent to OCR", mock.ocrCalls === 0, `ocr=${mock.ocrCalls}`);
  check("no 'corrupted text layer' message", !/corrupted text layer/.test(log));
  check("no language warning", !/looks like/.test(log));
  check("English text and the Arabic quotation both reached the translator",
    mock.sources.join("\n").includes(MARKER) && mock.sources.join("\n").includes("وقفت المكتبة القديمة"));
  await context.close();
}

console.log("\nFlow 15 — scanned Arabic book with one English notice page: no false warning before OCR");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_ar_scan_notice.pdf"), { pair: "ar-en" });
  await page.click("#start-btn");
  const modal = page.waitForSelector("#lang-modal", { state: "visible", timeout: 60000 }).then(() => "modal");
  const outcome = await Promise.race([doneLog(page).then(() => "done"), modal.catch(() => "none")]);
  check("no language dialog — the notice page does not decide the book's language", outcome === "done", outcome);
  if (outcome === "modal") await page.click("#lang-no");
  else {
    const log = await page.textContent("#log");
    check("all 6 scanned pages read with OCR", mock.ocrCalls === 6, `ocr=${mock.ocrCalls}`);
    check("no language warning at all", !/looks like/.test(log));
  }
  await context.close();
}

console.log("\nFlow 16 — mostly digital English PDF under Arabic → English: caught before any OCR is paid");
{
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, "sample_en_mostly_digital.pdf"), { pair: "ar-en" });
  await page.click("#start-btn");
  await page.waitForSelector("#lang-modal", { state: "visible", timeout: 30000 });
  check("dialog says the book looks like English", (await page.textContent("#lang-text")).includes("looks like English"));
  check("no OCR paid before the dialog", mock.ocrCalls === 0, `ocr=${mock.ocrCalls}`);
  await page.click("#lang-no");
  await context.close();
}

console.log("\nFlow 17 — one religious convention per book, in every passage and in the review");
for (const [file, pair, want, logWant] of [
  ["sample_ar_islamic.txt", "ar-en", "render الله as \"Allah\" everywhere", "Islamic religious work"],
  ["sample_ar.txt", "ar-de", "Render الله as „Gott“ everywhere", "rendered the same way throughout"],
]) {
  const mock = makeMock();
  const { context, page } = await newPage(browser, mock);
  await setup(page, join(SAMPLES, file), { pair, review: true });
  await page.click("#start-btn");
  await doneLog(page);
  const log = await page.textContent("#log");
  check(`${file} (${pair}): marker translated`, mock.sources.join("\n").includes(MARKERS.ar));
  check(`${file} (${pair}): every translate prompt carries the book's convention`,
    mock.systems.length > 0 && mock.systems.every((s) => s.includes(want)), mock.systems[0]?.slice(0, 80));
  check(`${file} (${pair}): every review prompt enforces it`,
    mock.reviewSystems.length > 0 && mock.reviewSystems.every((s) =>
      s.split("\n").some((l) => l.startsWith("- violations of this rule:") && l.includes(want))));
  check(`${file} (${pair}): the choice is logged`, log.includes(logWant), log.split("\n").slice(0, 6).join(" | "));
  await context.close();
}

// ------------------------------------------------------------------- report
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
