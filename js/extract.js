/* Text extraction: .txt, .docx, .epub, .pdf — all in the browser. */

import { plausibility } from "./detect.js";

const OCR_MIN_TEXT_CHARS = 30; // a PDF page with less text than this + an image = scanned

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL("vendor/pdf.min.mjs", document.baseURI).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", document.baseURI).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

// ------------------------------------------------------------------- plain text

// Legacy (pre-Unicode) encodings books in the supported languages come in.
const LEGACY_ENCODINGS = ["windows-1256", "windows-1251", "gb18030", "big5", "windows-1252"];
const MULTI_BYTE = new Set(["gb18030", "big5"]);

function hanShare(text) {
  let han = 0;
  let letters = 0;
  for (const ch of text.slice(0, 60000)) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (/\p{Script=Han}/u.test(ch)) han++;
  }
  return letters ? han / letters : 0;
}

/**
 * Decode a non-UTF-8 file — whatever the chosen pair, the language check
 * afterwards must see the book's TRUE language.
 * Plausibility scores of different scripts are not comparable (random bytes
 * read as cp1251/cp1256 score as high as real Chinese prose), so the
 * double-byte Chinese encodings are judged first by validity: real GBK/Big5
 * text decodes with (almost) no U+FFFD, while Arabic, Cyrillic or Latin
 * code-page bytes give ~14 % U+FFFD there. A few stray bad bytes are allowed.
 * Big5 bytes are also valid GB18030 — the more plausible of the two wins.
 * Among the single-byte code pages, the one expected for the chosen source
 * language wins unless another is clearly more plausible.
 */
export function decodeLegacy(bytes, preferred = "windows-1252") {
  const cands = LEGACY_ENCODINGS.map((enc) => {
    const text = new TextDecoder(enc).decode(bytes);
    const sample = text.slice(0, 200000);
    return {
      enc,
      text,
      badShare: (sample.match(/�/g) || []).length / Math.max(1, sample.length),
      score: plausibility(text),
    };
  });
  const best = (list) => list.reduce((a, b) => (b.score > a.score ? b : a));
  const cjk = cands.filter((c) => MULTI_BYTE.has(c.enc) && c.badShare <= 0.002 && hanShare(c.text) > 0.2);
  if (cjk.length) return best(cjk).text;
  const single = cands.filter((c) => !MULTI_BYTE.has(c.enc));
  const top = best(single);
  const pref = single.find((c) => c.enc === preferred);
  return pref && pref.score >= top.score - 0.05 ? pref.text : top.text;
}

/** `legacyEncoding`: what to assume first for a non-UTF-8 file (depends on
 * the book's language — e.g. windows-1256 for Arabic, gb18030 for Chinese). */
export async function extractTxt(file, legacyEncoding = "windows-1252") {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // UTF-8 with a few stray or truncated bytes: keep it. Real legacy-encoded
    // books turn almost every non-ASCII byte into U+FFFD when read as UTF-8.
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    const bad = (utf8.match(/�/g) || []).length;
    const multi = (utf8.match(/[^\x00-\x7F�]/g) || []).length;
    if (multi >= 20 && bad <= multi * 0.01) return utf8;
    return decodeLegacy(bytes, legacyEncoding); // legacy files
  }
}

// ------------------------------------------------------------------------ docx

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function extractDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx file (no word/document.xml).");
  const xml = new DOMParser().parseFromString(await docFile.async("string"), "application/xml");
  const paragraphs = [];
  for (const p of xml.getElementsByTagNameNS(W_NS, "p")) {
    let text = "";
    const walker = xml.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.namespaceURI !== W_NS) continue;
      if (node.localName === "t") text += node.textContent;
      else if (node.localName === "tab") text += "\t";
      else if (node.localName === "br" || node.localName === "cr") text += "\n";
    }
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}

// ------------------------------------------------------------------------ epub

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "blockquote",
]);
const SKIP_TAGS = new Set(["script", "style", "head", "title"]);

/** HTML -> text with paragraph breaks at block boundaries. */
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName;
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push("\n\n");
    for (const child of node.childNodes) walk(child);
    if (block) parts.push("\n\n");
  };
  walk(doc.documentElement);
  let raw = parts.join("");
  raw = raw.replace(/[ \t\u00A0]+/g, " ");
  raw = raw.replace(/ ?\n ?/g, "\n");
  raw = raw.replace(/\n{3,}/g, "\n\n");
  return raw.trim();
}

function resolveHref(baseDir, href) {
  // resolve "../text/ch1.xhtml" against the OPF's directory, drop #fragments
  const clean = decodeURIComponent(href.split("#")[0]);
  const stack = baseDir ? baseDir.split("/") : [];
  for (const part of clean.split("/")) {
    if (part === "..") stack.pop();
    else if (part !== "." && part !== "") stack.push(part);
  }
  return stack.join("/");
}

export async function extractEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  let docPaths = [];
  try {
    const container = new DOMParser().parseFromString(
      await zip.file("META-INF/container.xml").async("string"), "application/xml");
    const opfPath = container.getElementsByTagName("rootfile")[0].getAttribute("full-path");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
    const opf = new DOMParser().parseFromString(await zip.file(opfPath).async("string"), "application/xml");

    const manifest = {}; // id -> { href, type }
    for (const item of opf.getElementsByTagName("item")) {
      manifest[item.getAttribute("id")] = {
        href: item.getAttribute("href"),
        type: item.getAttribute("media-type") || "",
      };
    }
    for (const ref of opf.getElementsByTagName("itemref")) {
      const item = manifest[ref.getAttribute("idref")];
      if (item && (item.type.includes("html") || /\.x?html?$/i.test(item.href))) {
        docPaths.push(resolveHref(opfDir, item.href));
      }
    }
  } catch {
    docPaths = [];
  }
  if (!docPaths.length) {
    // fallback: every HTML file in the archive, in zip order
    zip.forEach((path) => {
      if (/\.x?html?$/i.test(path)) docPaths.push(path);
    });
  }

  const parts = [];
  for (const path of docPaths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const text = htmlToText(await entry.async("string"));
    if (text) parts.push(text);
  }
  if (!parts.length) throw new Error("No readable chapters found in this EPUB.");
  return parts.join("\n\n");
}

// ------------------------------------------------------------------------- pdf

// Chinese/Japanese characters and full-width punctuation: no spaces between them
const CJK = /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{2FA1F}]/u;
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const LETTER = /\p{L}/u;

/** True if the text on both sides of a break is Chinese — then no space goes between. */
function cjkPair(before, after) {
  return CJK.test(before.slice(-1)) && CJK.test(after.slice(0, 1));
}

// Sentence-final punctuation at the end of a page, by language. A page that
// ends with one starts a new paragraph on the next page; otherwise the next
// page continues the same paragraph.
const SENTENCE_END = {
  default: /[.!?:؟”"']\s*$/,
  ar: /[.!?:؟”“"'»«…]\s*$/,
  de: /[.!?:…”"'“«»]\s*$/,
  uk: /[.!?:…”"'»]\s*$/,
  zh: /[.!?:…”"'。！？：」』]\s*$/,
};
// A single line break survives (stays a line break) after these; otherwise
// the line is merged into the next. Ukrainian dialogue lines start with a
// dash: such a line stays separate after a line that ends a sentence, or one
// ending in a dash (interrupted speech); a dash inside a sentence
// ('Київ\n— столиця') is merged as usual.
const KEEP_NEWLINE_AFTER = {
  default: /(?<![.!?:؟”"\n])\n(?!\n)/g,
  ar: /(?<![.!?:؟”“"»«…\n])\n(?!\n)/g,
  de: /(?<![.!?:…”"“«»\n])\n(?!\n)/g,
  uk: /(?<![.!?:…”"»\n])\n(?!\n)(?!(?<=[—–][ \t   ]*\n)[ \t   ]*[—–](?:[\s   ]|\p{L}))/gu,
  zh: /(?<![.!?:…”"\n。！？：」』])\n(?!\n)/g,
};

// common German words whose normal syllable break leaves noch/wie/bis/als on the next line
const NOT_SUSPENDED = new Set(["dennoch", "sowie", "kürbis", "materials", "potenzials", "potentials",
  "rituals", "ideals", "individuals", "initials", "areals", "manuals"]);

/** Join per-page text into flowing prose (same rules as the desktop app):
 * - a page that ends mid-sentence continues into the next page;
 * - hyphen-split words (exam-\nple) are stitched back together;
 * - remaining single newlines inside sentences become spaces (or nothing,
 *   between Chinese characters).
 * `src` is the book's language code (optional).
 */
export function joinPdfPages(pages, src) {
  const sentenceEnd = SENTENCE_END[src] || SENTENCE_END.default;
  const parts = [];
  for (let pageText of pages) {
    pageText = pageText.trim();
    if (!pageText) continue;
    if (parts.length) {
      parts.push(sentenceEnd.test(parts[parts.length - 1]) ? "\n\n" : "\n");
    }
    parts.push(pageText);
  }
  let text = parts.join("");
  if (src === "de") {
    // German breaks lines at REAL hyphens too: a syllable break never continues
    // with a capital letter (Max-\nPlanck, EU-\nKommission, 100-\nMeter-Lauf keep
    // it; all-caps KAPI-\nTEL is joined), and a hyphen before und/oder/… is a
    // suspended compound (Ein-\nund Ausgang → Ein- und Ausgang) — unless the
    // joined word is a common one (den-\nnoch, so-\nwie). Not 'statt':
    // Werk-\nstatt is a syllable break far more often.
    text = text.replace(/([\p{Ll}\p{N}])-\n(?!\n)(?=\p{Lu})/gu, "$1-");
    text = text.replace(/(\p{Lu})-\n(?!\n)(?=\p{Lu}\p{Ll})/gu, "$1-");
    text = text.replace(
      /([\p{L}\p{N}])-\n(?!\n)(?=(und|oder|bis|sowie|bzw|noch|wie|als|beziehungsweise)(?!\p{L})|u\.)/gu,
      (m, last, word, offset, whole) => {
        const head = /\p{L}*$/u.exec(whole.slice(Math.max(0, offset - 40), offset))[0];
        return word && NOT_SUSPENDED.has((head + last + word).toLowerCase()) ? m : last + "- ";
      });
  }
  text = text.replace(/(\p{N})-\n(?!\n)(?=\p{N})/gu, "$1-"); // number ranges (12-\n15) keep their hyphen
  text = text.replace(/([\p{L}\p{N}_])-\n(?!\n)(?=[\p{L}\p{N}_])/gu, "$1"); // de-hyphenate
  const merge = KEEP_NEWLINE_AFTER[src] || KEEP_NEWLINE_AFTER.default;
  return text.replace(merge, (_, offset, whole) => // merge broken lines
    (cjkPair(whole.slice(0, offset), whole.slice(offset + 1)) ? "" : " "));
}

// scripts written right to left (Unicode bidi class R or AL)
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

/** In an ARABIC book, a line containing Arabic — or written only in another
 * right-to-left script (a Hebrew or Syriac quotation) — is a right-to-left line. */
function isRtlLine(items, src) {
  if (src !== "ar") return false;
  const letters = items.flatMap((it) => [...it.str].filter((ch) => LETTER.test(ch)));
  return letters.some((ch) => ARABIC_SCRIPT.test(ch)) ||
    (letters.length > 0 && letters.every((ch) => RTL_SCRIPT.test(ch)));
}

// an item that reads left to right: letters or digits, none of them in a right-to-left script
const STRONG_LTR = /[\p{L}\p{N}]/u;
const isLtrItem = (it) => !RTL_SCRIPT.test(it.str) && [...it.str].some((ch) => STRONG_LTR.test(ch));
const hasLtrLetter = (it) => !RTL_SCRIPT.test(it.str) && [...it.str].some((ch) => LETTER.test(ch));

/** An Arabic line: pdf.js gives each item in logical order, but PDFs often
 * draw the items (words) left to right — so order them by position, right to
 * left, keeping each embedded left-to-right run (English words, citations)
 * in its own reading order, and re-insert word gaps.
 * Only a letter of a left-to-right script makes a run left-to-right (as in the
 * Unicode bidi algorithm): numbers next to Arabic text alone — verse lists
 * '12، 13، 14', ranges '1990 – 2000' — are laid out right to left, so position
 * order is already their reading order. */
function rtlLineText(items) {
  const sorted = items.filter((it) => it.str).sort(
    (a, b) => (b.transform?.[4] ?? 0) - (a.transform?.[4] ?? 0));
  const ordered = [];
  for (let i = 0; i < sorted.length;) {
    if (!isLtrItem(sorted[i])) {
      ordered.push(sorted[i++]);
      continue;
    }
    // the run ends at the last letter item reachable without crossing right-to-left text
    let end = hasLtrLetter(sorted[i]) ? i + 1 : -1;
    for (let j = i + 1; j < sorted.length && !RTL_SCRIPT.test(sorted[j].str); j++) {
      if (hasLtrLetter(sorted[j])) end = j + 1;
    }
    if (end < 0) { // bare numbers: keep right-to-left order
      ordered.push(sorted[i++]);
      continue;
    }
    ordered.push(...sorted.slice(i, end).reverse()); // the run reads left to right
    i = end;
  }
  let out = "";
  let prev = null;
  for (const it of ordered) {
    if (prev) {
      const px = prev.transform?.[4] ?? 0;
      const ix = it.transform?.[4] ?? 0;
      const gap = Math.max(px - (ix + (it.width || 0)), ix - (px + (prev.width || 0)));
      if (gap > 1 && !/\s$/.test(out) && !/^\s/.test(it.str) && !cjkPair(out, it.str)) out += " ";
    }
    out += it.str;
    prev = it;
  }
  return out;
}

/** Rebuild one page's text from pdf.js text items (line breaks + word gaps).
 * `src` is the book's language: Arabic lines get right-to-left ordering.
 * (Exported for tests.) */
export function pageTextFromItems(items, src) {
  const lines = []; // { parts: string[], items: item[] }
  let line = { parts: [], items: [] };
  const endLine = () => {
    lines.push(line);
    line = { parts: [], items: [] };
  };
  let last = null;
  for (const it of items) {
    if (it.str === undefined) continue;
    if (last && !last.hasEOL) {
      const dy = Math.abs((it.transform?.[5] ?? 0) - (last.transform?.[5] ?? 0));
      if (dy > 2) {
        endLine();
      } else {
        const gap = (it.transform?.[4] ?? 0) - ((last.transform?.[4] ?? 0) + (last.width || 0));
        if (gap > 1 && line.parts.length && !/\s$/.test(last.str) && !/^\s/.test(it.str) &&
            !cjkPair(last.str, it.str)) {
          line.parts.push(" ");
        }
      }
    }
    line.parts.push(it.str);
    line.items.push(it);
    if (it.hasEOL) endLine();
    last = it;
  }
  if (line.parts.length) endLine();
  return lines
    .map((l) => (isRtlLine(l.items, src) ? rtlLineText(l.items) : l.parts.join("")))
    .join("\n");
}

/** True if the operator list paints an image covering ≥ `minFraction` of the
 * page. Tracks only the CTM determinant (all we need for areas). */
async function hasBigImage(pdfjs, page, minFraction) {
  const ops = await page.getOperatorList();
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
  const { OPS } = pdfjs;
  let det = 1;
  const stack = [];
  let found = false;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(det);
    else if (fn === OPS.restore) det = stack.length ? stack.pop() : det;
    else if (fn === OPS.transform) det *= args[0] * args[3] - args[1] * args[2];
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(det);
      const m = args && args[0];
      if (m) det *= m[0] * m[3] - m[1] * m[2];
    } else if (fn === OPS.paintFormXObjectEnd) det = stack.length ? stack.pop() : det;
    else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      if (Math.abs(det) >= minFraction * pageArea) {
        found = true;
        break;
      }
    }
  }
  return found;
}

/** Open a PDF and expose what the engine needs: per-page text, scanned-page
 * detection, and page rendering for OCR. `src`: the book's language code. */
export async function openPdf(file, src) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const numPages = doc.numPages;

  const pageTexts = [];
  const scanned = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = pageTextFromItems(content.items, src).trim();
    pageTexts.push(text);
    // A page needs OCR if it has (almost) no text layer but carries an image —
    // including scans whose only "text" is a watermark on a full-page image.
    if (text.length < 200) {
      try {
        if (text.length < OCR_MIN_TEXT_CHARS) {
          if (await hasBigImage(pdfjs, page, 0.0)) scanned.push(i - 1); // any image at all
        } else if (await hasBigImage(pdfjs, page, 0.8)) {
          scanned.push(i - 1);
        }
      } catch {
        if (text.length < OCR_MIN_TEXT_CHARS) scanned.push(i - 1); // conservative fallback
      }
    }
  }

  return {
    numPages,
    pageTexts,
    scannedPages: scanned,
    /** Render page `i` (0-based) to a PNG, long edge `maxEdge` px; returns base64. */
    async renderPagePngBase64(i, maxEdge) {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = maxEdge / Math.max(base.width, base.height, 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let o = 0; o < buf.length; o += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(o, o + CHUNK));
      }
      return btoa(binary);
    },
    destroy() {
      try {
        Promise.resolve(task.destroy()).catch(() => {});
      } catch {
        /* already destroyed */
      }
    },
  };
}

// -------------------------------------------------------------------- registry

export const SUPPORTED_EXTENSIONS = [".txt", ".docx", ".epub", ".pdf"];

export function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Extract full text for non-PDF files (PDFs go through openPdf + OCR). */
export async function extractSimple(file, legacyEncoding) {
  const ext = fileExtension(file.name);
  if (ext === ".txt") return extractTxt(file, legacyEncoding);
  if (ext === ".docx") return extractDocx(file);
  if (ext === ".epub") return extractEpub(file);
  throw new Error(`Unsupported file type: ${ext}`);
}
