/* Output generation for every target language: Word (.docx), PDF, plain
 * text, and a print view (the browser's own text engine, as an alternative
 * way to make a PDF).
 *
 * Arabic output is right-to-left throughout; English, German, Ukrainian and
 * Chinese output is left-to-right. Any paragraph kept untranslated (safety-
 * refusal fallback) gets the direction of its own script.
 */

import { makeArabicLayout, paragraphIsRtl, CJK, HAS_ARABIC } from "./artext.js";
import { LANGUAGES } from "./languages.js";

function xmlEscape(s) {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split translated chunks into clean paragraphs. */
function toParagraphs(translatedChunks) {
  const out = [];
  for (const text of translatedChunks) {
    for (const par of text.split("\n\n")) {
      const p = par.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

function targetLang(tgt) {
  return LANGUAGES[tgt] || LANGUAGES.ar;
}

// ------------------------------------------------------------------------ docx

const DOCX_STYLE = {
  ar: { latin: "Traditional Arabic", size: 14, titleSize: 20 },
  en: { latin: "Times New Roman", size: 12, titleSize: 18 },
  de: { latin: "Times New Roman", size: 12, titleSize: 18 },
  uk: { latin: "Times New Roman", size: 12, titleSize: 18 },
  zh: { latin: "Times New Roman", size: 12, titleSize: 18 },
};
const EAST_ASIAN_FONT = "SimSun";      // Chinese body text (宋体)
const ARABIC_FONT = "Traditional Arabic";

function runProps(tgt, points, bold, rtl) {
  const style = DOCX_STYLE[tgt] || DOCX_STYLE.ar;
  const half = points * 2;
  // Arabic ("complex script") text inside a 12-pt Latin document is set a
  // little larger, as Arabic typography expects
  const csHalf = tgt === "ar" ? half : half + 4;
  // Chinese: shared punctuation (“ ” ‘ ’ … — ·) must use the East-Asian font,
  // or Word draws it as narrow Western glyphs
  const hint = tgt === "zh" ? 'w:hint="eastAsia" ' : "";
  return (
    `<w:rPr><w:rFonts ${hint}w:ascii="${style.latin}" w:hAnsi="${style.latin}" ` +
    `w:eastAsia="${EAST_ASIAN_FONT}" w:cs="${ARABIC_FONT}"/>` +
    (bold ? "<w:b/><w:bCs/>" : "") +
    `<w:sz w:val="${half}"/><w:szCs w:val="${csHalf}"/>` +
    (rtl ? "<w:rtl/>" : "") +
    `<w:lang w:val="${targetLang(tgt).docLang}" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr>`
  );
}

/** One paragraph; its direction follows the document language and its own script.
 * Single line breaks inside the paragraph (verse, addresses) are kept. */
function paragraphXml(text, tgt, { points, bold = false, center = false } = {}) {
  const docRtl = targetLang(tgt).rtl;
  const rtl = paragraphIsRtl(text, docRtl);
  const rpr = runProps(tgt, points, bold, rtl);
  // Chinese body text: justified, first line indented by two characters (首行缩进)
  const chineseBody = tgt === "zh" && !center && !rtl;
  // RTL: no jc — its default is "start", the right edge. In a bidi paragraph
  // Word reads left/right as start/end, so "right" would put the text on the left.
  const jc = center ? "center" : rtl ? null : chineseBody ? "both" : "left";
  const ind = chineseBody ? `<w:ind w:firstLineChars="200" w:firstLine="${points * 40}"/>` : "";
  const content = text
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
    .join("<w:br/>");
  return (
    `<w:p><w:pPr>${rtl ? "<w:bidi/>" : ""}${ind}${jc ? `<w:jc w:val="${jc}"/>` : ""}${rpr}</w:pPr>` +
    `<w:r>${rpr}${content}</w:r></w:p>`
  );
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// Justified (Chinese) paragraphs: a line ending in a kept line break (verse)
// must not be stretched across the full width
const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:compat><w:doNotExpandShiftReturn/></w:compat></w:settings>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

/** `tgt`: target language code (default Arabic). */
export async function buildDocxBlob(translatedChunks, title, tgt = "ar") {
  const style = DOCX_STYLE[tgt] || DOCX_STYLE.ar;
  const body = [paragraphXml(title, tgt, { points: style.titleSize, bold: true, center: true })];
  for (const par of toParagraphs(translatedChunks)) body.push(paragraphXml(par, tgt, { points: style.size }));

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}<w:sectPr>${targetLang(tgt).rtl ? "<w:bidi/>" : ""}</w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", documentXml);
  zip.file("word/settings.xml", SETTINGS);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

// ------------------------------------------------------------------------- pdf

function loadScript(src, ready) {
  return new Promise((resolve, reject) => {
    const done = ready();
    if (done) return resolve(done);
    const s = document.createElement("script");
    s.src = new URL(src, document.baseURI).href;
    s.onload = () => resolve(ready());
    s.onerror = () => reject(new Error(`Could not load ${src}.`));
    document.head.appendChild(s);
  });
}

let jsPdfPromise = null;
function loadJsPdf() {
  if (!jsPdfPromise) {
    jsPdfPromise = loadScript("vendor/jspdf.umd.min.js", () => window.jspdf?.jsPDF).then((JsPDF) => {
      // Disable jsPDF's own Arabic pass (shaping-only, naive punctuation
      // handling) — we pre-shape and run the full Unicode bidi algorithm
      // ourselves, so the text we hand jsPDF is already in final visual form.
      // Identify the built-in pass BEHAVIORALLY (function identities are not
      // reliable in the minified build): probe each text hook with joining
      // Arabic letters and drop whichever hook transforms them.
      const PROBE = "بتث"; // بتث — changes under shaping/reordering
      JsPDF.API.events = JsPDF.API.events.filter(([name, fn]) => {
        if (name !== "preProcessText" && name !== "postProcessText") return true;
        try {
          const payload = { text: PROBE, x: 0, y: 0, options: {}, mutex: {} };
          fn.call(null, payload);
          return payload.text === PROBE; // keep hooks that leave Arabic alone
        } catch {
          return true; // hooks needing full document context are not the parser
        }
      });
      return JsPDF;
    });
  }
  return jsPdfPromise;
}

let reshaperPromise = null;
function loadReshaper() {
  if (!reshaperPromise) {
    reshaperPromise = loadScript("vendor/arabic-reshaper.js", () => window.ArabicReshaper);
  }
  return reshaperPromise;
}

let bidiPromise = null;
function loadBidi() {
  if (!bidiPromise) {
    bidiPromise = import(new URL("vendor/bidi.min.mjs", document.baseURI).href)
      .then((m) => (m.default || m)());
  }
  return bidiPromise;
}

// Embedded PDF fonts (all SIL Open Font License — see vendor/FONTS-LICENSE.txt).
// No single font covers every script, so each character is drawn with the
// first font in the target language's chain that has a glyph for it.
const PDF_FONTS = {
  amiri: { url: "vendor/Amiri-Regular.ttf", family: "Amiri" },           // Arabic + Latin
  serif: { url: "vendor/NotoSerif-Regular.ttf", family: "NotoSerif" },   // Latin + Cyrillic
  sc: { url: "vendor/NotoSerifSC-Regular.ttf", family: "NotoSerifSC" },  // Simplified Chinese
};
// arrows, math operators, enclosed numbers, box drawing, shapes, symbols:
// only the Chinese font has these, so load it for them too
const SC_SYMBOLS = /[⅐-↏←-⇿∀-⋿⌀-⏿①-⓿─-◿☀-⛿㈀-㋿]/;
const FONT_CHAIN = {
  ar: ["amiri", "serif", "sc"],
  zh: ["sc", "serif", "amiri"],
  en: ["serif", "amiri", "sc"],
  de: ["serif", "amiri", "sc"],
  uk: ["serif", "amiri", "sc"],
};

/** Codepoints a TrueType font has glyphs for (from its cmap table). */
export function cmapCoverage(buffer) {
  const dv = new DataView(buffer);
  const numTables = dv.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (dv.getUint32(rec) === 0x636d6170) { // "cmap"
      cmap = dv.getUint32(rec + 8);
      break;
    }
  }
  const cps = new Set();
  if (cmap < 0) return cps;
  let fmt4 = -1;
  let fmt12 = -1;
  const n = dv.getUint16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const r = cmap + 4 + i * 8;
    const pid = dv.getUint16(r);
    const eid = dv.getUint16(r + 2);
    const off = cmap + dv.getUint32(r + 4);
    const fmt = dv.getUint16(off);
    const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
    if (!unicode) continue;
    if (fmt === 12 && fmt12 < 0) fmt12 = off;
    if (fmt === 4 && fmt4 < 0) fmt4 = off;
  }
  if (fmt12 >= 0) {
    const groups = dv.getUint32(fmt12 + 12);
    for (let i = 0; i < groups; i++) {
      const g = fmt12 + 16 + i * 12;
      const start = dv.getUint32(g);
      const end = dv.getUint32(g + 4);
      const glyph = dv.getUint32(g + 8);
      for (let c = start; c <= end; c++) if (glyph + (c - start)) cps.add(c);
    }
  } else if (fmt4 >= 0) {
    const segX2 = dv.getUint16(fmt4 + 6);
    const endO = fmt4 + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = dv.getUint16(endO + 2 * s);
      const start = dv.getUint16(startO + 2 * s);
      const delta = dv.getInt16(deltaO + 2 * s);
      const ro = dv.getUint16(rangeO + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (ro === 0) {
          g = (c + delta) & 0xffff;
        } else {
          g = dv.getUint16(rangeO + 2 * s + ro + 2 * (c - start));
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) cps.add(c);
      }
    }
  }
  return cps;
}

const fontCache = {};
function loadFont(key) {
  if (!fontCache[key]) {
    fontCache[key] = (async () => {
      const resp = await fetch(new URL(PDF_FONTS[key].url, document.baseURI).href);
      if (!resp.ok) throw new Error("Could not load a font for the PDF.");
      const buffer = await resp.arrayBuffer();
      const buf = new Uint8Array(buffer);
      let binary = "";
      const CHUNK = 0x8000;
      for (let o = 0; o < buf.length; o += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(o, o + CHUNK));
      }
      return { base64: btoa(binary), coverage: cmapCoverage(buffer) };
    })();
    fontCache[key].catch(() => { delete fontCache[key]; }); // allow a retry
  }
  return fontCache[key];
}

// zero-width / bidi-control characters: they steer the bidi algorithm but
// are not drawn
const INVISIBLE = /^[­​-‏‪-‮⁠-⁤⁦-⁩﻿]$/;
const isInvisible = (ch) => INVISIBLE.test(ch);

/** Real .pdf, generated in the browser for any target language: embedded
 * fonts with per-character fallback, Arabic contextual shaping + full Unicode
 * bidi (verified against the reference Python implementations), Chinese line
 * breaking — A4, 18 mm margins, 20 pt title, 13 pt body.
 * `onWarning(message)` reports characters no embedded font can draw. */
export async function buildPdfBlob(translatedChunks, title, tgt = "ar", { onWarning } = {}) {
  const paragraphs = toParagraphs(translatedChunks);
  const allText = title + "\n" + paragraphs.join("\n");
  const chain = FONT_CHAIN[tgt] || FONT_CHAIN.ar;
  const docRtl = targetLang(tgt).rtl;

  const [JsPDF, reshaper, bidi] = await Promise.all([loadJsPdf(), loadReshaper(), loadBidi()]);

  // Load the primary font, then only the fallbacks this text actually needs.
  const loaded = []; // [{ key, family, coverage }]
  const addFont = async (key) => {
    const f = await loadFont(key);
    loaded.push({ key, family: PDF_FONTS[key].family, coverage: f.coverage, base64: f.base64 });
  };
  await addFont(chain[0]);
  const uniqueChars = new Set(allText.replace(/\s/g, ""));
  const uncovered = () => [...uniqueChars].filter(
    (ch) => !isInvisible(ch) && !loaded.some((f) => f.coverage.has(ch.codePointAt(0))));
  for (const key of chain.slice(1)) {
    const missing = uncovered();
    if (!missing.length) break;
    const wanted =
      key === "sc" ? missing.some((ch) => CJK.test(ch) || SC_SYMBOLS.test(ch)) :
      key === "amiri" ? missing.some((ch) => HAS_ARABIC.test(ch)) :
      missing.some((ch) => !CJK.test(ch) && !HAS_ARABIC.test(ch));
    if (wanted) await addFont(key);
  }
  // order the loaded fonts by the chain (fallback priority)
  loaded.sort((a, b) => chain.indexOf(a.key) - chain.indexOf(b.key));

  const doc = new JsPDF({ unit: "mm", format: "a4", compress: true });
  for (const f of loaded) {
    const file = `${f.family}.ttf`;
    doc.addFileToVFS(file, f.base64);
    doc.addFont(file, f.family, "normal");
  }
  const primary = loaded[0];

  // which font draws a character (cached), and how wide it is (cached, in em)
  const fontFor = new Map();
  let missingCount = 0;
  const missingSample = new Set();
  const pickFont = (ch) => {
    let f = fontFor.get(ch);
    if (f) return f;
    const cp = ch.codePointAt(0);
    f = loaded.find((x) => x.coverage.has(cp));
    if (!f) {
      f = primary;
      if (!isInvisible(ch) && ch !== " ") {
        missingCount++;
        if (missingSample.size < 12) missingSample.add(ch);
      }
    }
    fontFor.set(ch, f);
    return f;
  };
  const unitWidth = new Map(); // family -> Map(char -> em width)
  for (const f of loaded) unitWidth.set(f.family, new Map());
  let currentFamily = null;
  const useFont = (family) => {
    if (family !== currentFamily) {
      doc.setFont(family, "normal");
      currentFamily = family;
    }
  };
  const charWidth = (ch) => {
    if (isInvisible(ch)) return 0;
    const f = pickFont(ch);
    const cache = unitWidth.get(f.family);
    let w = cache.get(ch);
    if (w === undefined) {
      useFont(f.family);
      w = doc.getStringUnitWidth(ch);
      cache.set(ch, w);
    }
    return w;
  };
  let fontSize = 13;
  const k = doc.internal.scaleFactor;
  const measure = (s) => {
    let em = 0;
    for (const ch of s) em += charWidth(ch);
    return (em * fontSize) / k;
  };

  const layout = makeArabicLayout({
    reshape: (s) => reshaper.convertArabic(s),
    bidi,
    measure,
  });

  /** Draw one visual line as runs of same-font characters. */
  const drawLine = (line, y, align, pageW, margin) => {
    const runs = [];
    for (const ch of line) {
      if (isInvisible(ch)) continue;
      const f = pickFont(ch);
      const last = runs[runs.length - 1];
      if (last && last.family === f.family) last.text += ch;
      else runs.push({ family: f.family, text: ch });
    }
    let total = 0;
    for (const r of runs) {
      r.w = measure(r.text);
      total += r.w;
    }
    let x = align === "right" ? pageW - margin - total
      : align === "center" ? (pageW - total) / 2
      : margin;
    for (const r of runs) {
      useFont(r.family);
      doc.text(r.text, x, y);
      x += r.w;
    }
  };

  const MARGIN = 18;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usableW = pageW - 2 * MARGIN;
  const PT = 0.352778; // mm per point
  let y = MARGIN;

  const writePar = (par, { points, center = false, spacingAfter }) => {
    fontSize = points;
    doc.setFontSize(points);
    const lineH = points * PT * 1.65;
    // keep single line breaks inside a paragraph (verse, addresses)
    for (const hardLine of par.split("\n")) {
      const clean = hardLine.replace(/\t/g, " ").trim();
      if (!clean) continue;
      const { rtl, lines } = layout.layoutParagraph(clean, usableW, docRtl);
      for (const line of lines) {
        if (y + lineH > pageH - MARGIN) {
          doc.addPage();
          y = MARGIN;
        }
        y += lineH;
        drawLine(line, y, center ? "center" : rtl ? "right" : "left", pageW, MARGIN);
      }
    }
    y += spacingAfter;
  };

  writePar(title, { points: 20, center: true, spacingAfter: 6 });
  for (const par of paragraphs) {
    // paragraphs kept untranslated (safety-refusal fallback) follow their own script's direction
    writePar(par, { points: 13, spacingAfter: 3 });
  }

  if (missingCount && onWarning) {
    onWarning(
      `${missingCount} distinct character(s) have no glyph in the PDF's embedded fonts ` +
      `(e.g. ${[...missingSample].join(" ")}) and show as boxes — the Word file and the Print view display them correctly.`
    );
  }
  return doc.output("blob");
}

// ------------------------------------------------------------------------- txt

export function buildTxtBlob(translatedChunks) {
  return new Blob([translatedChunks.join("\n\n")], { type: "text/plain;charset=utf-8" });
}

// -------------------------------------------------------------------- download

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------------ print view

const ARABIC_FONTS = `"Traditional Arabic", "Amiri", "Scheherazade New", "Noto Naskh Arabic"`;
const PRINT_FONTS = {
  ar: `${ARABIC_FONTS}, "Times New Roman", serif`,
  en: `"Noto Serif", Georgia, "Times New Roman", ${ARABIC_FONTS}, serif`,
  de: `"Noto Serif", Georgia, "Times New Roman", ${ARABIC_FONTS}, serif`,
  uk: `"Noto Serif", Georgia, "Times New Roman", ${ARABIC_FONTS}, serif`,
  zh: `"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, ${ARABIC_FONTS}, serif`,
};
const PRINT_WEBFONTS = {
  ar: "family=Amiri:wght@400;700",
  en: "family=Noto+Serif:wght@400;700&family=Amiri:wght@400;700",
  de: "family=Noto+Serif:wght@400;700&family=Amiri:wght@400;700",
  uk: "family=Noto+Serif:wght@400;700&family=Amiri:wght@400;700",
  zh: "family=Noto+Serif+SC:wght@400;700&family=Amiri:wght@400;700",
};

/** Open the translation in a print-ready window; the user saves it as a PDF
 * with the browser's print dialog (perfect shaping for every script, free,
 * offline-capable). */
export function openPrintView(translatedChunks, title, tgt = "ar") {
  const lang = targetLang(tgt);
  const docRtl = lang.rtl;
  const paragraphs = toParagraphs(translatedChunks);
  const win = window.open("", "_blank");
  if (!win) return false; // popup blocked
  const dir = (p) => (paragraphIsRtl(p, docRtl) ? "rtl" : "ltr");
  const doc = win.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html dir="${docRtl ? "rtl" : "ltr"}" lang="${lang.docLang}">
<head>
<meta charset="utf-8">
<title>${htmlEscape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?${PRINT_WEBFONTS[tgt] || PRINT_WEBFONTS.ar}&display=swap" rel="stylesheet">
<style>
  @page { margin: 2cm; }
  body {
    font-family: ${PRINT_FONTS[tgt] || PRINT_FONTS.ar};
    font-size: ${docRtl ? 15 : 13}pt; line-height: ${docRtl ? 2 : 1.75}; color: #1a1a1a;
    max-width: 17.5cm; margin: 0 auto; padding: 24px 16px;
    text-align: start;
  }
  h1 { text-align: center; font-size: ${docRtl ? 23 : 21}pt; font-weight: 700; margin: 0 0 1.2em; }
  p { margin: 0 0 0.65em; white-space: pre-line; }
  p[dir="rtl"] { font-family: ${PRINT_FONTS.ar}; }
  ${tgt === "zh" ? 'p[dir="ltr"] { text-indent: 2em; text-align: justify; }' : ""}
  .toolbar {
    position: sticky; top: 0; background: #0d5c4d; color: #fff;
    padding: 10px 16px; border-radius: 10px; margin-bottom: 20px;
    font-family: system-ui, sans-serif; font-size: 12pt; direction: ltr; text-align: left;
  }
  .toolbar button {
    font: inherit; margin-inline-end: 10px; padding: 4px 14px; border: 0;
    border-radius: 7px; background: #fff; color: #0d5c4d; cursor: pointer; font-weight: 600;
  }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">🖨 Print / Save as PDF</button>
  Choose “Save as PDF” as the destination in the print dialog.
</div>
<h1 dir="${dir(title)}">${htmlEscape(title)}</h1>
${paragraphs.map((p) => `<p dir="${dir(p)}">${htmlEscape(p)}</p>`).join("\n")}
</body>
</html>`);
  doc.close();
  return true;
}
