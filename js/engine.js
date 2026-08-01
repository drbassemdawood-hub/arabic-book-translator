/* The translation engine — a faithful port of the desktop app's
 * TranslationEngine: chunked streaming requests, sequential mode with Arabic
 * context continuity, parallel mode, two-pass review, Claude vision OCR for
 * scanned PDF pages, cost estimate, and resume-safe progress persistence.
 */

import { callModel, countTokens, imageContent, RefusalError, CancelledError, ApiError } from "./api.js";
import { chunkText, CHUNK_MAX_CHARS } from "./chunk.js";
import { extractSimple, openPdf, joinPdfPages, fileExtension } from "./extract.js";
import { ProgressStore, fingerprintText, fingerprintFile } from "./state.js";

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

const SYSTEM_PROMPT = `You are an expert literary translator translating an English book into Arabic.

Rules:
- Translate into clear, elegant Modern Standard Arabic (الفصحى).
- Preserve the author's tone, register, imagery, and literary devices. Translate meaning, not word-for-word.
- Transliterate proper names (people, places) into Arabic script and keep them consistent throughout.
- Keep chapter titles and headings as headings, translated.
- Preserve paragraph breaks exactly: each source paragraph becomes one Arabic paragraph.
- Dialogue keeps its quotation structure using Arabic-appropriate punctuation.
- Do NOT summarize, omit, or add anything. Do NOT add translator notes or commentary.
- Output ONLY the Arabic translation of the text you are given — no preamble, no explanations.
`;

const REVIEW_SYSTEM_PROMPT = `You are a meticulous bilingual editor reviewing an Arabic translation of an English book passage.

Compare the draft translation against the English source, sentence by sentence, and produce a corrected final version. Fix:
- any omitted, added, or mistranslated content — every sentence of the source must be fully represented;
- misread idioms, false friends, and errors of meaning;
- inconsistent transliteration of names;
- awkward or unnatural Arabic phrasing (the result must read as elegant الفصحى);
- broken paragraph structure — the paragraph breaks must match the source exactly.

If the draft is already correct, keep it. Output ONLY the final corrected Arabic translation — no notes, no explanations, no preamble.
`;

const OCR_SYSTEM_PROMPT = `You transcribe scanned book pages exactly.

- Output the complete text of the page precisely as printed — do not translate, summarize, correct, or modernize it.
- Preserve paragraph breaks: put a blank line between paragraphs. Join words that are hyphen-split across lines.
- Skip page headers, footers, and bare page numbers.
- If the page contains no text at all, output exactly [BLANK].
- Output ONLY the transcription — no commentary, no preamble.
`;

const UNTRANSLATED_MARKER = "[لم يُترجَم هذا المقطع تلقائيًا — النص الأصلي أدناه]";

/**
 * ui callbacks: { log(msg), status(msg), progress(done, total),
 *                 askResume(done, total) -> Promise<bool>, isCancelled() -> bool }
 */
export class TranslationEngine {
  constructor(ui) {
    this.ui = ui;
    this.refusalCount = 0;
    this.ocrCache = null;
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

    let arabic;
    try {
      arabic = await this.call(apiKey, model, SYSTEM_PROMPT, content);
    } catch (err) {
      if (err instanceof RefusalError) {
        // one declined passage must not wedge a 2000-page run: keep the
        // original English, flag it, and keep going
        this.refusalCount += 1;
        this.log("  ⚠ passage declined by the safety filter — keeping the original English text for this passage");
        return `${UNTRANSLATED_MARKER}\n\n${chunk}`;
      }
      throw err;
    }

    if (review) {
      try {
        arabic = await this.call(
          apiKey, model, REVIEW_SYSTEM_PROMPT,
          `ENGLISH SOURCE:\n\n${chunk}\n\n---\n\nDRAFT ARABIC TRANSLATION:\n\n${arabic}`,
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
    const outPars = arabic.split("\n\n").filter((p) => p.trim()).length;
    if (srcPars > 3 && Math.abs(srcPars - outPars) > Math.max(2, Math.floor(srcPars / 5))) {
      this.log(
        `  ⚠ paragraph count differs (source ${srcPars}, translation ${outPars}) — ` +
        "worth spot-checking this passage"
      );
    }
    return arabic;
  }

  // ----------------------------------------------------------- cost estimate

  async estimate(apiKey, model, text, nChunks, workers, review) {
    try {
      const sample = text.slice(0, TOKEN_SAMPLE_CHARS);
      const sampleTokens = await countTokens(apiKey, model, sample);
      const inTok = Math.floor((sampleTokens * text.length) / sample.length);
      const outTok = Math.floor(inTok * 1.4); // Arabic usually expands
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
      text = await this.call(apiKey, model, OCR_SYSTEM_PROMPT,
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
    const pdf = await openPdf(file);
    try {
      const { numPages, pageTexts, scannedPages } = pdf;

      if (scannedPages.length && ocrMode === "off") {
        this.log(
          `⚠ ${scannedPages.length} of ${numPages} pages look scanned (no text layer) ` +
          "but OCR is off — those pages will be skipped."
        );
      } else if (scannedPages.length) {
        this.log(
          `${scannedPages.length} of ${numPages} pages have no text layer — running OCR (Claude vision).`
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

      return joinPdfPages(pageTexts);
    } finally {
      pdf.destroy();
    }
  }

  // ------------------------------------------------------------------- runs

  async runSequential(apiKey, model, chunks, done, state, review) {
    // One request at a time; each passage sees the previous ARABIC tail,
    // which gives the best name/style continuity.
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      if (i in done) continue;
      this.checkCancel();
      this.log(`Translating passage ${i + 1}/${total} …`);
      const tail = i ? (done[i - 1] || "").slice(-400) : "";
      const arabic = await this.translateChunk(apiKey, model, chunks[i], tail, review);
      done[i] = arabic;
      await state.append(i, arabic);
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
          const arabic = await this.translateChunk(apiKey, model, chunks[i], srcTail(i), review);
          done[i] = arabic;
          await state.append(i, arabic);
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
  async run({ apiKey, model, workers, review, ocrMode, file }) {
    this.refusalCount = 0;
    this.ocrCache = null;
    try {
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
    this.log(`Reading ${file.name} …`);
    const text = ext === ".pdf"
      ? await this.extractPdf(apiKey, model, workers, ocrMode, file)
      : await extractSimple(file);
    if (!text.trim()) throw new Error("No text could be extracted from this file.");
    this.log(`Extracted ${text.length.toLocaleString()} characters (~${Math.floor(text.length / 2000).toLocaleString()} pages).`);

    const chunks = chunkText(text);
    const total = chunks.length;
    this.log(`Split into ${total} passages of ~${CHUNK_MAX_CHARS.toLocaleString()} characters.`);

    await this.estimate(apiKey, model, text, total, workers, review);

    const fp = await fingerprintText(text);
    const state = new ProgressStore(`tr:${fp}`, {
      source: file.name, nChunks: total, fingerprint: fp,
    });
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
        `⚠ ${this.refusalCount} passage(s) were declined by the safety filter and kept in English — ` +
        "search the output for 'لم يُترجَم' to review them."
      );
    }

    await state.delete();
    if (this.ocrCache) await this.ocrCache.delete();
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
