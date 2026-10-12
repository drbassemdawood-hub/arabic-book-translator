/* The translation engine — a faithful port of the desktop app's
 * TranslationEngine: chunked streaming requests, sequential mode with
 * translated-text context continuity, parallel mode, two-pass review, Claude
 * vision OCR for scanned PDF pages, cost estimate, and resume-safe progress
 * persistence — for every supported language pair.
 */

import { callModel, countTokens, imageContent, RefusalError, CancelledError, ApiError } from "./api.js";
import { chunkText } from "./chunk.js";
import { extractSimple, openPdf, joinPdfPages, fileExtension } from "./extract.js";
import { ProgressStore, fingerprintText, fingerprintFile, translationJobsFor } from "./state.js";
import {
  DEFAULT_PAIR, parsePair, translationPrompt, reviewPrompt, reviewLabels, ocrPrompt, outputTokenRatio,
} from "./languages.js";
import { sourceMismatch, textLayerLooksBroken, religiousContext } from "./detect.js";

// model id -> [label, $/M input, $/M output]
export const MODELS = {
  "claude-opus-5": ["Claude Opus 5 — best quality (default)", 5.0, 25.0],
  "claude-sonnet-5": ["Claude Sonnet 5 — fast, cheaper", 3.0, 15.0],
  "claude-haiku-4-5": ["Claude Haiku 4.5 — fastest, cheapest", 1.0, 5.0],
};
export const DEFAULT_MODEL = "claude-opus-5";

export const SPEEDS = {
  "Careful — one passage at a time, best continuity": 1,
  "Fast — 3 passages in parallel": 3,
  "Fastest — 6 passages in parallel": 6,
};
export const DEFAULT_SPEED = "Careful — one passage at a time, best continuity";

export const OCR_MODES = {
  "Claude vision OCR — reads scanned pages (uses API, adds cost)": "claude",
  "Off — translate the text layer only": "off",
};
export const DEFAULT_OCR = "Claude vision OCR — reads scanned pages (uses API, adds cost)";

const SECONDS_PER_CHUNK = 50; // rough, for the up-front time estimate
const TOKEN_SAMPLE_CHARS = 150000; // cost estimate samples this much, then extrapolates
const OCR_MAX_EDGE = 1500; // px long edge sent to Claude vision

/** Arabic presentation forms (common in text pulled from PDFs and old files)
 * → standard Arabic letters, so the model reads normal Arabic. */
function normalizeSource(text, src) {
  if (src !== "ar") return text;
  return text.replace(/[ﭐ-﷿ﹰ-﻾]+/g, (s) => s.normalize("NFKC"));
}

/** The book's language does not match the chosen language pair. */
export class LanguageMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "LanguageMismatchError";
  }
}

/**
 * ui callbacks: { log(msg), status(msg), progress(done, total),
 *                 askResume(done, total) -> Promise<bool>,
 *                 confirmLanguage(looksLike, chosenSource) -> Promise<bool>,
 *                 isCancelled() -> bool }
 */
export class TranslationEngine {
  constructor(ui) {
    this.ui = ui;
    this.refusalCount = 0;
    this.ocrCache = null;
    this.setPair(DEFAULT_PAIR);
  }

  /** `religion`: the book's religious context (Arabic sources), which fixes
   * how الله, honorifics and prophets' names are rendered in every passage. */
  setPair(pair, religion = null) {
    const { src, tgt, source, target } = parsePair(pair);
    this.pair = pair;
    this.src = src;
    this.tgt = tgt;
    this.source = source;
    this.target = target;
    this.religion = religion;
    this.prompts = {
      translate: translationPrompt(pair, { religion }),
      review: reviewPrompt(pair, { religion }),
      reviewLabels: reviewLabels(pair),
      ocr: ocrPrompt(src),
    };
  }

  log(msg) {
    this.ui.log(msg);
  }

  checkCancel() {
    if (this.ui.isCancelled()) throw new CancelledError();
  }

  call(apiKey, model, system, content) {
    return callModel(apiKey, model, system, content, {
      isCancelled: this.ui.isCancelled,
      log: this.ui.log,
    });
  }

  // ---------------------------------------------------------------- translate

  async translateChunk(apiKey, model, chunk, contextTail, review) {
    const content = contextTail
      ? `Continue the translation. For continuity, the book immediately before ` +
        `this passage read:\n…${contextTail}\n\nTranslate ONLY the following passage:\n\n${chunk}`
      : `Translate this passage:\n\n${chunk}`;

    let translated;
    try {
      translated = await this.call(apiKey, model, this.prompts.translate, content);
    } catch (err) {
      if (err instanceof RefusalError) {
        // one declined passage must not wedge a 2000-page run: keep the
        // original text, flag it, and keep going
        this.refusalCount += 1;
        this.log(`  ⚠ passage declined by the safety filter — keeping the original ${this.source.name} text for this passage`);
        return `${this.target.marker}\n\n${chunk}`;
      }
      throw err;
    }

    if (review) {
      const labels = this.prompts.reviewLabels;
      try {
        translated = await this.call(
          apiKey, model, this.prompts.review,
          `${labels.source}:\n\n${chunk}\n\n---\n\n${labels.draft}:\n\n${translated}`,
        );
      } catch (err) {
        if (err instanceof RefusalError) {
          this.log("  ⚠ review pass declined by the safety filter — keeping the first draft");
        } else {
          throw err;
        }
      }
    }

    // completeness guard: paragraph structure should survive translation
    const srcPars = chunk.split("\n\n").filter((p) => p.trim()).length;
    const outPars = translated.split("\n\n").filter((p) => p.trim()).length;
    if (srcPars > 3 && Math.abs(srcPars - outPars) > Math.max(2, Math.floor(srcPars / 5))) {
      this.log(
        `  ⚠ paragraph count differs (source ${srcPars}, translation ${outPars}) — ` +
        "worth spot-checking this passage"
      );
    }
    return translated;
  }

  // ----------------------------------------------------------- cost estimate

  async estimate(apiKey, model, text, nChunks, workers, review) {
    try {
      const sample = text.slice(0, TOKEN_SAMPLE_CHARS);
      const sampleTokens = await countTokens(apiKey, model, sample);
      const inTok = Math.floor((sampleTokens * text.length) / sample.length);
      const outTok = Math.floor(inTok * outputTokenRatio(this.pair)); // e.g. Arabic output expands
      const [, pIn, pOut] = MODELS[model];
      let cost = (inTok / 1e6) * pIn + (outTok / 1e6) * pOut;
      let perChunk = SECONDS_PER_CHUNK;
      if (review) {
        cost *= 2.2; // review pass re-reads source + draft, rewrites output
        perChunk *= 2;
      }
      const hours = (nChunks * perChunk) / workers / 3600;
      const eta = hours >= 1 ? `${hours.toFixed(1)} hours` : `${Math.round(hours * 60)} minutes`;
      this.log(
        `Estimated size ~${inTok.toLocaleString()} input tokens → rough cost ≈ $${cost.toFixed(2)}; ` +
        `estimated time ≈ ${eta} (${model}, ${workers} parallel request${workers > 1 ? "s" : ""}` +
        `${review ? ", two-pass accuracy review" : ""}).`
      );
    } catch {
      this.log("Could not estimate cost (continuing anyway).");
    }
  }

  // ------------------------------------------------- PDF extraction with OCR

  async claudeOcrPage(apiKey, model, pngBase64) {
    let text;
    try {
      text = await this.call(apiKey, model, this.prompts.ocr,
        imageContent(pngBase64, "Transcribe this scanned book page."));
    } catch (err) {
      if (err instanceof RefusalError) {
        this.log("  ⚠ a page was declined by the safety filter — leaving it empty");
        return "";
      }
      throw err;
    }
    return text.trim() === "[BLANK]" ? "" : text;
  }

  async extractPdf(apiKey, model, workers, ocrMode, file) {
    const pdf = await openPdf(file, this.src);
    try {
      const { numPages, pageTexts } = pdf;
      // pages with a text layer that decodes to gibberish (wrong character
      // mapping — common in Arabic PDFs) are read from their image, like scans
      const brokenPages = [];
      for (let i = 0; i < numPages; i++) {
        if (!pdf.scannedPages.includes(i) && textLayerLooksBroken(pageTexts[i], this.src)) brokenPages.push(i);
      }
      const scannedPages = [...pdf.scannedPages, ...brokenPages].sort((a, b) => a - b);

      // Before paying for any OCR, check the readable text layer against the
      // chosen source language — a wrong language pair must cost nothing.
      // Only when that layer is a real share of the book: a scan with one
      // digital page (e.g. an English library notice) says nothing about its
      // language — the full check after OCR still runs before translation.
      const readable = numPages - scannedPages.length;
      if (scannedPages.length && readable >= Math.max(3, numPages * 0.2)) {
        const layer = pageTexts.filter((_, i) => !scannedPages.includes(i)).join("\n");
        const looksLike = sourceMismatch(layer, this.src);
        if (looksLike) await this.confirmSource(looksLike);
      }

      if (brokenPages.length) {
        this.log(
          `${brokenPages.length} of ${numPages} pages have a corrupted text layer (it decodes to gibberish, ` +
          "a common fault in PDFs) — " + (ocrMode === "off" ? "they need OCR to be read." : "they will be read with OCR.")
        );
      }
      if (scannedPages.length && ocrMode === "off") {
        this.log(
          `⚠ ${scannedPages.length} of ${numPages} pages need OCR (scanned or corrupted text) ` +
          "but OCR is off — those pages will be skipped."
        );
        for (const i of brokenPages) pageTexts[i] = ""; // never translate gibberish
      } else if (scannedPages.length) {
        this.log(
          `${scannedPages.length} of ${numPages} pages need OCR — running OCR (Claude vision).`
        );
        const fp = await fingerprintFile(file);
        const cache = new ProgressStore(`ocr:${fp}`, {
          source: file.name, nPages: numPages, engine: "claude", fingerprint: fp,
        });
        this.ocrCache = cache;
        const done = await cache.load();
        if (Object.keys(done).length) {
          this.log(`Resuming OCR: ${Object.keys(done).length} pages already recognized.`);
        } else {
          await cache.startFresh();
        }
        const missing = scannedPages.filter((i) => !(i in done));

        const [, pIn, pOut] = MODELS[model];
        const est = (missing.length * (2400 * pIn + 700 * pOut)) / 1e6;
        this.log(
          `Claude vision OCR of ${missing.length} pages ≈ $${est.toFixed(2)} ` +
          "(in addition to the translation cost)."
        );

        let completed = scannedPages.length - missing.length;
        let firstError = null;
        let next = 0;
        const workerFn = async () => {
          for (;;) {
            if (firstError || this.ui.isCancelled()) return;
            const idx = next++;
            if (idx >= missing.length) return;
            const i = missing[idx];
            try {
              const png = await pdf.renderPagePngBase64(i, OCR_MAX_EDGE);
              const text = await this.claudeOcrPage(apiKey, model, png);
              // every completed page is PAID — cache it immediately
              done[i] = text;
              await cache.append(i, text);
              completed += 1;
              this.ui.progress(completed, scannedPages.length);
              this.ui.status(`OCR: ${completed}/${scannedPages.length} scanned pages`);
            } catch (err) {
              if (err instanceof CancelledError) return;
              if (!firstError) firstError = err;
              return;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(workers, 1) }, workerFn));

        if (firstError) throw firstError;
        if (this.ui.isCancelled() && scannedPages.some((i) => !(i in done))) {
          throw new CancelledError();
        }
        for (const i of scannedPages) {
          if (i in done) pageTexts[i] = done[i];
        }
      }

      return joinPdfPages(pageTexts, this.src);
    } finally {
      pdf.destroy();
    }
  }

  // ------------------------------------------------------------------- runs

  async runSequential(apiKey, model, chunks, done, state, review) {
    // One request at a time; each passage sees the tail of the previous
    // TRANSLATED passage, which gives the best name/style continuity.
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      if (i in done) continue;
      this.checkCancel();
      this.log(`Translating passage ${i + 1}/${total} …`);
      const tail = i ? (done[i - 1] || "").slice(-400) : "";
      const translated = await this.translateChunk(apiKey, model, chunks[i], tail, review);
      done[i] = translated;
      await state.append(i, translated);
      this.ui.progress(Object.keys(done).length, total);
    }
  }

  async runParallel(apiKey, model, workers, chunks, done, state, review) {
    // N requests in flight; each passage sees the previous SOURCE tail
    // (known up front, so passages don't have to wait for each other).
    // Every completed passage is persisted the moment it finishes, in any
    // order — nothing paid for is ever thrown away.
    const total = chunks.length;
    const todo = [];
    for (let i = 0; i < total; i++) if (!(i in done)) todo.push(i);
    let firstError = null;
    let next = 0;
    const srcTail = (i) => (i > 0 ? chunks[i - 1].slice(-400) : "");

    const workerFn = async () => {
      for (;;) {
        if (firstError || this.ui.isCancelled()) return;
        const idx = next++;
        if (idx >= todo.length) return;
        const i = todo[idx];
        try {
          const translated = await this.translateChunk(apiKey, model, chunks[i], srcTail(i), review);
          done[i] = translated;
          await state.append(i, translated);
          this.log(`Passage ${i + 1}/${total} translated.`);
          this.ui.progress(Object.keys(done).length, total);
        } catch (err) {
          if (err instanceof CancelledError) return;
          if (!firstError) firstError = err;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, workerFn));

    if (firstError) throw firstError;
    if (this.ui.isCancelled() && Object.keys(done).length < total) throw new CancelledError();
  }

  /**
   * Full run. Returns { translated: string[] } on completion,
   * or null if cancelled (progress stays saved for resume).
   * Throws Error with a user-friendly message on failure.
   */
  /** The book looks like `looksLike`, not the chosen source: ask; stop unless confirmed. */
  async confirmSource(looksLike) {
    this.log(`⚠ This book looks like ${looksLike}, but the chosen direction translates from ${this.source.name}.`);
    const goOn = this.ui.confirmLanguage
      ? await this.ui.confirmLanguage(looksLike, this.source.name)
      : false;
    if (!goOn) {
      throw new LanguageMismatchError(
        `Stopped before translating: the book looks like ${looksLike}, not ${this.source.name}. ` +
        "Choose the matching language pair and press Start again."
      );
    }
    this.languageConfirmed = true;
    this.log("Continuing at your request.");
  }

  async run({ apiKey, model, workers, review, ocrMode, file, pair = DEFAULT_PAIR }) {
    this.refusalCount = 0;
    this.ocrCache = null;
    this.languageConfirmed = false;
    try {
      this.setPair(pair);
      return await this._run(apiKey, model, workers, review, ocrMode, file);
    } catch (err) {
      if (err instanceof CancelledError) {
        this.log("Cancelled. Progress saved — press Start again to resume.");
        return null;
      }
      throw friendlyError(err);
    }
  }

  async _run(apiKey, model, workers, review, ocrMode, file) {
    const ext = fileExtension(file.name);
    this.log(`Reading ${file.name} (${this.source.name} → ${this.target.name}) …`);
    let text = ext === ".pdf"
      ? await this.extractPdf(apiKey, model, workers, ocrMode, file)
      : await extractSimple(file, this.source.legacyEncoding);
    text = normalizeSource(text, this.src);
    if (!text.trim()) throw new Error("No text could be extracted from this file.");
    const pages = Math.floor(text.length / this.source.charsPerPage);
    this.log(`Extracted ${text.length.toLocaleString()} characters (~${pages.toLocaleString()} pages).`);

    // A wrong language choice would be billed for nothing — check before any
    // translation request is made (unless already confirmed before OCR).
    if (!this.languageConfirmed) {
      const looksLike = sourceMismatch(text, this.src);
      if (looksLike) await this.confirmSource(looksLike);
    }

    // One convention for الله and the honorifics across the whole book —
    // each passage is translated on its own and cannot judge the book.
    if (this.src === "ar") {
      const religion = religiousContext(text);
      this.setPair(this.pair, religion);
      this.log({
        islamic: "This reads as an Islamic religious work — Islamic terminology will be used throughout.",
        christian: "This reads as a Christian work — Christian terminology will be used throughout.",
        general: "Religious terms (God, honorific formulas) will be rendered the same way throughout the book.",
      }[religion]);
    }

    const limit = this.source.chunkLimit;
    const chunks = chunkText(text, limit);
    const total = chunks.length;
    this.log(`Split into ${total} passages of ~${limit.toLocaleString()} characters.`);

    await this.estimate(apiKey, model, text, total, workers, review);

    // Progress is keyed by the text AND the language pair — the same book in
    // another direction is a different job. English → Arabic keeps the key
    // it had before other pairs existed, so runs in progress still resume.
    const fp = await fingerprintText(text);
    const legacy = this.pair === "en-ar";
    // (the religious convention is part of the job: passages translated under
    // another one are never mixed in)
    const state = new ProgressStore(
      legacy ? `tr:${fp}` : `tr:${fp}:${this.pair}`,
      legacy
        ? { source: file.name, nChunks: total, fingerprint: fp }
        : { source: file.name, nChunks: total, fingerprint: fp, pair: this.pair,
          ...(this.religion ? { religion: this.religion } : {}) },
    );
    let done = await state.load();
    const doneCount = Object.keys(done).length;
    if (doneCount && doneCount < total) {
      const resume = await this.ui.askResume(doneCount, total);
      if (!resume) done = {};
    }
    if (Object.keys(done).length) {
      this.log(`Resuming: ${Object.keys(done).length}/${total} passages already translated.`);
    } else {
      await state.startFresh();
    }

    this.ui.progress(Object.keys(done).length, total);

    if (workers <= 1) {
      await this.runSequential(apiKey, model, chunks, done, state, review);
    } else {
      await this.runParallel(apiKey, model, workers, chunks, done, state, review);
    }

    const translated = [];
    for (let i = 0; i < total; i++) translated.push(done[i]);
    if (this.refusalCount) {
      this.log(
        `⚠ ${this.refusalCount} passage(s) were declined by the safety filter and kept in ` +
        `${this.source.name} — search the output for '${this.target.markerSearch}' to review them.`
      );
    }

    await state.delete();
    // The OCR cache belongs to the FILE, a job to the text AND the pair: a job
    // in another direction for this book still needs the same OCR text to
    // resume (a new OCR run reads slightly differently → a new fingerprint →
    // its paid passages would be orphaned). Delete it once no such job is left.
    if (this.ocrCache && !(await translationJobsFor(fp))) await this.ocrCache.delete();
    this.log("Translation complete. الحمد لله!");
    return { translated };
  }
}

/** Map raw errors to the desktop app's friendly messages. */
function friendlyError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) return new Error("Invalid API key. Check the key and try again.");
    if (err.status === 403) return new Error("This API key does not have permission for the selected model.");
    if (err.status === 404) return new Error("Model not found — the selected model may not be available to your account.");
    if (err.status === 429) {
      return new Error(
        "Rate limited by the API even after retries. Wait a few minutes and press Start again — " +
        "completed passages are saved and will be resumed. Tip: choose the 'Careful' speed to stay under rate limits."
      );
    }
    return new Error(`API error ${err.status}: ${err.message}`);
  }
  if (err instanceof TypeError && /fetch|network|load\s?failed/i.test(err.message || "")) {
    return new Error(
      "Network error — check your internet connection. Progress is saved; press Start again to resume."
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
