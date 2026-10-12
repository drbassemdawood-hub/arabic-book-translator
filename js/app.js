/* UI wiring for Book Translator — مترجم الكتب */

import {
  TranslationEngine, MODELS, DEFAULT_MODEL, SPEEDS, DEFAULT_SPEED, OCR_MODES, DEFAULT_OCR,
} from "./engine.js";
import { SUPPORTED_EXTENSIONS, fileExtension } from "./extract.js";
import { loadSettings, saveSettings, loadApiKey, saveApiKey } from "./state.js";
import { buildDocxBlob, buildPdfBlob, buildTxtBlob, downloadBlob, openPrintView } from "./output.js";
import { PAIRS, DEFAULT_PAIR, pairLabel, parsePair } from "./languages.js";

const $ = (id) => document.getElementById(id);

const el = {
  apiKey: $("api-key"), toggleKey: $("toggle-key"), rememberKey: $("remember-key"),
  keyModal: $("key-modal"), openKey: $("open-key"), keySave: $("key-save"),
  keyClose: $("key-close"), keyStatus: $("key-status"),
  dropzone: $("dropzone"), fileInput: $("file-input"),
  dropEmpty: $("dropzone-empty"), dropFile: $("dropzone-file"),
  fileName: $("file-name"), fileSize: $("file-size"), clearFile: $("clear-file"),
  pair: $("pair"), model: $("model"), speed: $("speed"), ocr: $("ocr"),
  fmtDocx: $("fmt-docx"), fmtPdf: $("fmt-pdf"), fmtTxt: $("fmt-txt"), review: $("review"),
  startBtn: $("start-btn"), cancelBtn: $("cancel-btn"),
  progressWrap: $("progress-wrap"), progressFill: $("progress-fill"), statusText: $("status-text"),
  results: $("results"), dlDocx: $("dl-docx"), dlPdf: $("dl-pdf"), dlTxt: $("dl-txt"), dlPrint: $("dl-print"),
  log: $("log"), logWrap: $("log-wrap"),
  resumeModal: $("resume-modal"), resumeText: $("resume-text"),
  resumeYes: $("resume-yes"), resumeNo: $("resume-no"),
  langModal: $("lang-modal"), langText: $("lang-text"), langYes: $("lang-yes"), langNo: $("lang-no"),
  toast: $("toast"),
};

// ------------------------------------------------------------------ options

function fillSelect(select, labels, defaultLabel) {
  for (const label of labels) {
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = defaultLabel;
}

for (const pair of PAIRS) { // value = pair id ("en-ar"), text = "English → Arabic"
  const opt = document.createElement("option");
  opt.value = pair;
  opt.textContent = pairLabel(pair);
  el.pair.appendChild(opt);
}
el.pair.value = DEFAULT_PAIR;
fillSelect(el.model, Object.values(MODELS).map(([label]) => label), MODELS[DEFAULT_MODEL][0]);
fillSelect(el.speed, Object.keys(SPEEDS), DEFAULT_SPEED);
fillSelect(el.ocr, Object.keys(OCR_MODES), DEFAULT_OCR);

function selectedModel() {
  const label = el.model.value;
  return Object.keys(MODELS).find((id) => MODELS[id][0] === label) || DEFAULT_MODEL;
}

// ------------------------------------------------------------- persistence

function restoreSettings() {
  const s = loadSettings();
  if (s.pair && PAIRS.includes(s.pair)) el.pair.value = s.pair;
  if (s.model && MODELS[s.model]) el.model.value = MODELS[s.model][0];
  if (s.speed && s.speed in SPEEDS) el.speed.value = s.speed;
  if (s.ocr && s.ocr in OCR_MODES) el.ocr.value = s.ocr;
  if (Array.isArray(s.formats)) {
    el.fmtDocx.checked = s.formats.includes("docx");
    el.fmtPdf.checked = s.formats.includes("pdf");
    el.fmtTxt.checked = s.formats.includes("txt");
  }
  if (typeof s.review === "boolean") el.review.checked = s.review;
  if (typeof s.remember === "boolean") el.rememberKey.checked = s.remember;
  el.apiKey.value = loadApiKey();
}

function persistSettings() {
  saveSettings({
    pair: el.pair.value,
    model: selectedModel(),
    speed: el.speed.value,
    ocr: el.ocr.value,
    formats: selectedFormats(),
    review: el.review.checked,
    remember: el.rememberKey.checked,
  });
  saveApiKey(el.apiKey.value.trim(), el.rememberKey.checked);
}

function selectedFormats() {
  const formats = [];
  if (el.fmtDocx.checked) formats.push("docx");
  if (el.fmtPdf.checked) formats.push("pdf");
  if (el.fmtTxt.checked) formats.push("txt");
  return formats;
}

restoreSettings();

// ------------------------------------------------------------ API key modal

let startAfterKeySave = false;

function updateKeyStatus() {
  const hasKey = !!el.apiKey.value.trim();
  el.keyStatus.textContent = hasKey
    ? (el.rememberKey.checked ? "API key saved ✓" : "API key set for this session ✓")
    : "No API key yet — you'll be asked when you start.";
}

function openKeyModal(forStart = false) {
  startAfterKeySave = forStart;
  el.keyModal.hidden = false;
  el.apiKey.focus();
}

function closeKeyModal() {
  el.keyModal.hidden = true;
  updateKeyStatus();
}

el.openKey.addEventListener("click", () => openKeyModal(false));
el.keyClose.addEventListener("click", closeKeyModal);
el.keySave.addEventListener("click", () => {
  saveApiKey(el.apiKey.value.trim(), el.rememberKey.checked);
  closeKeyModal();
  if (startAfterKeySave && el.apiKey.value.trim()) {
    startAfterKeySave = false;
    start();
  }
});

el.toggleKey.addEventListener("click", () => {
  el.apiKey.type = el.apiKey.type === "password" ? "text" : "password";
});

updateKeyStatus();

// --------------------------------------------------------------- file input

let chosenFile = null;

function setFile(file) {
  if (file && !SUPPORTED_EXTENSIONS.includes(fileExtension(file.name))) {
    showToast("Unsupported file type. Use .txt, .docx, .epub, or .pdf.");
    return;
  }
  chosenFile = file;
  el.dropEmpty.hidden = !!file;
  el.dropFile.hidden = !file;
  if (file) {
    el.fileName.textContent = file.name;
    const mb = file.size / (1024 * 1024);
    el.fileSize.textContent = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
  }
}

el.dropzone.addEventListener("click", (e) => {
  if (e.target !== el.clearFile) el.fileInput.click();
});
el.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener("change", () => setFile(el.fileInput.files[0] || null));
el.clearFile.addEventListener("click", (e) => {
  e.stopPropagation();
  el.fileInput.value = "";
  setFile(null);
});

for (const ev of ["dragenter", "dragover"]) {
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("dragover");
  });
}
for (const ev of ["dragleave", "drop"]) {
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("dragover");
  });
}
el.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file);
});

// ----------------------------------------------------------------- helpers

let toastTimer = null;
function showToast(message, ok = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("ok", ok);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
}

function appendLog(msg) {
  el.log.textContent += msg + "\n";
  el.log.scrollTop = el.log.scrollHeight;
}

function askResume(done, total) {
  return new Promise((resolve) => {
    el.resumeText.textContent =
      `A previous run translated ${done} of ${total} passages of this book. ` +
      "Resume where it left off? (“Start over” restarts from the beginning.)";
    el.resumeModal.hidden = false;
    const finish = (answer) => {
      el.resumeModal.hidden = true;
      el.resumeYes.onclick = el.resumeNo.onclick = null;
      resolve(answer);
    };
    el.resumeYes.onclick = () => finish(true);
    el.resumeNo.onclick = () => finish(false);
  });
}

/** The book does not look like the chosen source language: translate anyway? */
function confirmLanguage(looksLike, chosenSource) {
  return new Promise((resolve) => {
    el.langText.textContent =
      `This book looks like ${looksLike}, but the chosen direction translates from ${chosenSource}. ` +
      "Nothing has been sent for translation yet. Stop and choose the matching language pair, " +
      "or translate anyway if you are sure.";
    el.langModal.hidden = false;
    const finish = (answer) => {
      el.langModal.hidden = true;
      el.langYes.onclick = el.langNo.onclick = null;
      resolve(answer);
    };
    el.langYes.onclick = () => finish(true);
    el.langNo.onclick = () => finish(false);
  });
}

// --------------------------------------------------------------------- run

let running = false;
let cancelled = false;
let lastResult = null; // { translated, stem, tgt }

function setRunning(state) {
  running = state;
  el.startBtn.disabled = state;
  el.cancelBtn.disabled = !state;
  for (const input of [el.openKey, el.pair, el.model, el.speed, el.ocr,
                       el.fmtDocx, el.fmtPdf, el.fmtTxt, el.review]) {
    input.disabled = state;
  }
}

/** PDF problems worth telling the user about (e.g. characters no font can draw). */
function pdfOptions() {
  return { onWarning: (msg) => { appendLog(`⚠ ${msg}`); showToast(msg); } };
}

window.addEventListener("beforeunload", (e) => {
  if (running) {
    e.preventDefault();
    e.returnValue = ""; // progress is saved, but warn before killing the run
  }
});

async function start() {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    showToast("Enter your Claude API key first — it stays in this browser.");
    openKeyModal(true);
    return;
  }
  if (!chosenFile) {
    showToast("Choose a book file to translate.");
    return;
  }
  if (!selectedFormats().length) {
    // formats only control auto-download (the result buttons offer everything),
    // but keep parity with the desktop app: require at least one.
    showToast("Choose at least one output format (Word, PDF, or plain text).");
    return;
  }

  persistSettings();
  cancelled = false;
  lastResult = null;
  el.results.hidden = true;
  el.progressWrap.hidden = false;
  el.progressFill.style.width = "0%";
  el.statusText.textContent = "Starting…";
  setRunning(true);

  const pair = el.pair.value;
  const { tgt } = parsePair(pair);
  const model = selectedModel();
  const workers = SPEEDS[el.speed.value];
  const review = el.review.checked;
  const ocrMode = OCR_MODES[el.ocr.value];
  const formats = selectedFormats();

  appendLog(
    `--- Starting: ${chosenFile.name}, ${pairLabel(pair)} (${model}, ${workers} parallel, ` +
    `formats: ${formats.join(", ")}${review ? ", two-pass accuracy review" : ""}) ---`
  );

  const engine = new TranslationEngine({
    log: appendLog,
    status: (msg) => { el.statusText.textContent = msg; },
    progress: (done, total) => {
      const pct = total ? (done / total) * 100 : 0;
      el.progressFill.style.width = `${pct}%`;
      el.statusText.textContent = `${done}/${total} passages translated and saved`;
    },
    askResume,
    confirmLanguage,
    isCancelled: () => cancelled,
  });

  let outcome = null;
  try {
    outcome = await engine.run({ apiKey, model, workers, review, ocrMode, file: chosenFile, pair });
  } catch (err) {
    appendLog(`✖ ${err.message}`);
    el.statusText.textContent = "Failed.";
    setRunning(false);
    showToast(err.message);
    return;
  }

  setRunning(false);
  if (!outcome) { // cancelled
    el.statusText.textContent = "Cancelled — progress saved. Press Start to resume.";
    return;
  }

  const stem = chosenFile.name.replace(/\.[^.]+$/, "");
  lastResult = { translated: outcome.translated, stem, tgt };
  el.statusText.textContent = "Done.";
  el.results.hidden = false;
  el.results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  showToast("Translation finished! Your downloads are ready below.", true);

  // auto-download the chosen formats (buttons remain as a fallback)
  try {
    if (formats.includes("docx")) {
      downloadBlob(await buildDocxBlob(outcome.translated, stem, tgt), `${stem}.${tgt}.docx`);
    }
    if (formats.includes("pdf")) {
      appendLog("Writing the PDF … (a large book can take a few minutes)");
      downloadBlob(await buildPdfBlob(outcome.translated, stem, tgt, pdfOptions()), `${stem}.${tgt}.pdf`);
    }
    if (formats.includes("txt")) downloadBlob(buildTxtBlob(outcome.translated), `${stem}.${tgt}.txt`);
  } catch (err) {
    appendLog(`⚠ Could not auto-download: ${err.message}. Use the buttons below.`);
  }
}

function cancel() {
  cancelled = true;
  el.statusText.textContent = "Cancelling after the passages in flight finish…";
}

el.startBtn.addEventListener("click", start);
el.cancelBtn.addEventListener("click", cancel);

// ---------------------------------------------------------------- downloads

el.dlDocx.addEventListener("click", async () => {
  if (!lastResult) return;
  const { translated, stem, tgt } = lastResult;
  downloadBlob(await buildDocxBlob(translated, stem, tgt), `${stem}.${tgt}.docx`);
});
el.dlPdf.addEventListener("click", async () => {
  if (!lastResult) return;
  const { translated, stem, tgt } = lastResult;
  el.dlPdf.disabled = true;
  el.dlPdf.textContent = "⏳ Building PDF…";
  try {
    downloadBlob(await buildPdfBlob(translated, stem, tgt, pdfOptions()), `${stem}.${tgt}.pdf`);
  } catch (err) {
    showToast(`Could not build the PDF: ${err.message}`);
  } finally {
    el.dlPdf.disabled = false;
    el.dlPdf.textContent = "⬇ PDF (.pdf)";
  }
});
el.dlTxt.addEventListener("click", () => {
  if (!lastResult) return;
  downloadBlob(buildTxtBlob(lastResult.translated), `${lastResult.stem}.${lastResult.tgt}.txt`);
});
el.dlPrint.addEventListener("click", () => {
  if (!lastResult) return;
  if (!openPrintView(lastResult.translated, lastResult.stem, lastResult.tgt)) {
    showToast("Your browser blocked the print window — allow pop-ups for this site and try again.");
  }
});
