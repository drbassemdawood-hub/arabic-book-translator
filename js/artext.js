/* Arabic text layout for PDF output: contextual shaping + full Unicode
 * bidirectional reordering, applied per wrapped line.
 *
 * The pipeline mirrors what proper typesetters do:
 *   1. shape the LOGICAL paragraph into presentation forms (joined letters,
 *      lam-alef ligatures) — widths are then real glyph widths;
 *   2. wrap into lines by measuring the shaped text;
 *   3. per line, run the Unicode bidi algorithm (bidi-js): mirror brackets,
 *      then reorder to VISUAL order — Latin words and numbers inside Arabic
 *      keep their left-to-right direction, punctuation lands where an Arabic
 *      reader expects it;
 *   4. the caller draws each visual line right-aligned.
 *
 * Verified against the reference Python implementations (arabic-reshaper +
 * python-bidi) in test/artext_parity — see that file for the oracle cases.
 */

export const HAS_ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/**
 * deps:
 *  - reshape(s): logical Arabic -> presentation forms (ArabicReshaper.convertArabic)
 *  - bidi: a bidi-js instance (bidiFactory())
 *  - measure(s): rendered width of a string in the current font/size
 */
export function makeArabicLayout({ reshape, bidi, measure }) {
  function toVisual(line) {
    // getReorderedString applies the full UBA: visual reordering AND bracket
    // mirroring ("(" facing the right way in RTL context)
    return bidi.getReorderedString(line, bidi.getEmbeddingLevels(line, "rtl"));
  }

  /** Greedy word-wrap by measured width (works on shaped or plain text). */
  function wrap(text, maxWidth) {
    const words = text.split(/ +/).filter(Boolean);
    if (!words.length) return [];
    const spaceW = measure(" ") || measure("i");
    const lines = [];
    let line = [];
    let lineW = 0;
    for (const word of words) {
      let w = measure(word);
      if (w > maxWidth && word.length > 4) {
        // pathological single over-wide word: hard-split it
        if (line.length) {
          lines.push(line.join(" "));
          line = [];
          lineW = 0;
        }
        let piece = "";
        for (const ch of word) {
          if (measure(piece + ch) > maxWidth && piece) {
            lines.push(piece);
            piece = "";
          }
          piece += ch;
        }
        if (piece) {
          line = [piece];
          lineW = measure(piece);
        }
        continue;
      }
      if (line.length && lineW + spaceW + w > maxWidth) {
        lines.push(line.join(" "));
        line = [];
        lineW = 0;
      }
      line.push(word);
      lineW += (line.length > 1 ? spaceW : 0) + w;
    }
    if (line.length) lines.push(line.join(" "));
    return lines;
  }

  /** Returns { rtl, lines } — lines are ready to draw in visual order. */
  function layoutParagraph(par, maxWidth) {
    if (!HAS_ARABIC.test(par)) {
      return { rtl: false, lines: wrap(par, maxWidth) };
    }
    const shaped = reshape(par);
    return { rtl: true, lines: wrap(shaped, maxWidth).map(toVisual) };
  }

  return { layoutParagraph, toVisual, wrap };
}
