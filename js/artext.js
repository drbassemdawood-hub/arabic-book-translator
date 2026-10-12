/* Text layout for PDF output: Arabic contextual shaping + full Unicode
 * bidirectional reordering, and line breaking that also works for Chinese
 * (no spaces between words), applied per wrapped line.
 *
 * The pipeline mirrors what proper typesetters do:
 *   1. shape the LOGICAL paragraph into presentation forms (joined letters,
 *      lam-alef ligatures) — widths are then real glyph widths;
 *   2. wrap into lines by measuring the shaped text — at spaces, and between
 *      Chinese characters (never putting closing punctuation such as ，。」
 *      at the start of a line, nor opening punctuation at the end);
 *   3. per line, run the Unicode bidi algorithm (bidi-js): mirror brackets,
 *      then reorder to VISUAL order — Latin words and numbers inside Arabic
 *      keep their left-to-right direction, Arabic inside a left-to-right
 *      paragraph reads right-to-left, punctuation lands where readers expect;
 *   4. the caller draws each visual line, right-aligned if RTL.
 *
 * Verified against the reference Python implementations (arabic-reshaper +
 * python-bidi) in test/artext_parity — see that file for the oracle cases.
 */

export const HAS_ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HAS_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LETTER = /\p{L}/u;

/** Chinese/Japanese characters and full-width punctuation. */
export const CJK = /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{2FA1F}]/u;
// must not begin a line (closing / trailing punctuation)
const NO_LINE_START = /[，。、；：！？）》」』〉】〕〗〙〛”’…‥·％,.;:!?)\]}%]/;
// must not end a line (opening punctuation)
const NO_LINE_END = /[（《「『〈【〔〖〘〚“‘(\[{]/;

/**
 * Is this paragraph right-to-left? In an Arabic document, a paragraph is RTL
 * if it contains Arabic — or no letters at all (scene breaks, bare numbers
 * follow the page). In a left-to-right document a paragraph is RTL when most
 * of its letters are Arabic — e.g. an untranslated Arabic passage kept in an
 * English book, even if it contains a Latin term such as "(DNA)".
 */
export function paragraphIsRtl(par, docRtl = true) {
  if (docRtl) return HAS_ARABIC.test(par) || !LETTER.test(par);
  let rtlN = 0;
  let ltrN = 0;
  for (const ch of par) {
    if (!LETTER.test(ch)) continue;
    if (RTL_LETTER.test(ch)) rtlN++;
    else ltrN++;
  }
  return rtlN > ltrN;
}

/**
 * Break text into wrap tokens: words separated by spaces — and, inside a
 * word, every position next to a Chinese character (kinsoku rules aside).
 * `sp` says whether a space separates the token from the one before it.
 * Text with no Chinese splits exactly at spaces, as before.
 */
export function wrapTokens(text) {
  const tokens = [];
  for (const word of text.split(/ +/).filter(Boolean)) {
    let piece = "";
    let prev = "";
    let first = true;
    for (const ch of word) {
      if (piece && (CJK.test(prev) || CJK.test(ch)) && !NO_LINE_START.test(ch) && !NO_LINE_END.test(prev)) {
        tokens.push({ t: piece, sp: first && tokens.length > 0 });
        first = false;
        piece = "";
      }
      piece += ch;
      prev = ch;
    }
    if (piece) tokens.push({ t: piece, sp: first && tokens.length > 0 });
  }
  return tokens;
}

/**
 * deps:
 *  - reshape(s): logical Arabic -> presentation forms (ArabicReshaper.convertArabic)
 *  - bidi: a bidi-js instance (bidiFactory())
 *  - measure(s): rendered width of a string in the current font(s)/size
 */
export function makeArabicLayout({ reshape, bidi, measure }) {
  function toVisual(line, dir = "rtl") {
    // getReorderedString applies the full UBA: visual reordering AND bracket
    // mirroring ("(" facing the right way in RTL context)
    return bidi.getReorderedString(line, bidi.getEmbeddingLevels(line, dir));
  }

  /** Greedy wrap by measured width (works on shaped or plain text). */
  function wrap(text, maxWidth) {
    const tokens = wrapTokens(text);
    if (!tokens.length) return [];
    const spaceW = measure(" ") || measure("i");
    const lines = [];
    let line = "";
    let lineW = 0;
    for (const { t, sp } of tokens) {
      const w = measure(t);
      if (w > maxWidth && t.length > 4) {
        // pathological single over-wide word: hard-split it
        if (line) {
          lines.push(line);
          line = "";
          lineW = 0;
        }
        let piece = "";
        for (const ch of t) {
          if (measure(piece + ch) > maxWidth && piece) {
            lines.push(piece);
            piece = "";
          }
          piece += ch;
        }
        if (piece) {
          line = piece;
          lineW = measure(piece);
        }
        continue;
      }
      const gap = line && sp ? spaceW : 0;
      if (line && lineW + gap + w > maxWidth) {
        lines.push(line);
        line = t;
        lineW = w;
        continue;
      }
      line = line ? line + (sp ? " " : "") + t : t;
      lineW += gap + w;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Returns { rtl, lines } — lines are ready to draw in visual order.
   *  `docRtl`: is the document right-to-left (an Arabic translation)? */
  function layoutParagraph(par, maxWidth, docRtl = true) {
    const rtl = paragraphIsRtl(par, docRtl);
    if (!HAS_RTL.test(par)) return { rtl, lines: wrap(par, maxWidth) };
    const shaped = reshape(par);
    return { rtl, lines: wrap(shaped, maxWidth).map((l) => toVisual(l, rtl ? "rtl" : "ltr")) };
  }

  return { layoutParagraph, toVisual, wrap };
}
