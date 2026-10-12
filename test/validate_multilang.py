"""Validate the Word / PDF / text files produced for every language pair
(test/artifacts/pair-<src>-<tgt>.*) — run after e2e.mjs.

Checks, per target language:
- Word: right-to-left document settings only for Arabic; language tags;
  a mixed-script paragraph in a left-to-right book stays left-to-right.
- PDF: the right fonts are embedded; target text is present; every glyph
  sits inside the page margins (wrapping works, also for Chinese, which
  has no spaces); no Chinese line starts with closing punctuation; an Arabic
  word inside an English sentence is drawn right-to-left.
- Text file: content present.
"""
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

import pymupdf

ART = Path(__file__).parent / "artifacts"
PAIRS = ["en-ar", "ar-en", "ar-uk", "uk-ar", "ar-zh", "zh-ar", "ar-de", "de-ar"]
EXPECT = {  # text that must appear (Word / text file)
    "ar": "فقرة مترجمة رقم 1",
    "en": "Translated paragraph 1",
    "uk": "Перекладений абзац 1",
    "zh": "这是第1段译文",
    "de": "Übersetzter Absatz 1",
}
DOC_LANG = {"ar": "ar-SA", "en": "en-US", "uk": "uk-UA", "zh": "zh-CN", "de": "de-DE"}
FONTS = {  # embedded font families expected in the PDF
    "ar": {"amiri"},
    "en": {"notoserif", "amiri"},  # the mock English text contains one Arabic word
    "uk": {"notoserif"},
    "de": {"notoserif"},
    "zh": {"notoserifsc"},
}
MARGIN_PT = 18 / 25.4 * 72  # 18 mm
NO_LINE_START = set("，。、；：！？）》」』”’")

failures = []


def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + ("" if cond else f"  {extra}"))
    if not cond:
        failures.append(name)


def font_families(doc):
    fams = set()
    for pno in range(doc.page_count):
        for f in doc.get_page_fonts(pno):
            base = re.sub(r"^[A-Z]{6}\+", "", f[3]).lower().replace("-regular", "")
            fams.add("notoserifsc" if "notoserifsc" in base else "notoserif" if "notoserif" in base
                     else "amiri" if "amiri" in base else base)
    return fams


def rows(page):
    """Visual lines, grouped by BASELINE (glyph tops differ between fonts
    mixed on one line, e.g. Amiri inside Noto Serif)."""
    out = {}
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for ch in span["chars"]:
                    out.setdefault(round(ch["origin"][1]), []).append((ch["bbox"][0], ch["bbox"][2], ch["c"]))
    return [sorted(v) for _, v in sorted(out.items())]


for pair in PAIRS:
    src, tgt = pair.split("-")
    print(f"\n{pair}")

    # ---- Word
    with zipfile.ZipFile(ART / f"pair-{pair}.docx") as z:
        xml = z.read("word/document.xml").decode("utf-8")
        names = z.namelist()
        settings = z.read("word/settings.xml").decode("utf-8") if "word/settings.xml" in names else ""
        doc_rels = z.read("word/_rels/document.xml.rels").decode("utf-8") if "word/_rels/document.xml.rels" in names else ""
        types = z.read("[Content_Types].xml").decode("utf-8")
    check("docx: verse lines are not stretched (doNotExpandShiftReturn, wired up)",
          "<w:doNotExpandShiftReturn/>" in settings and 'Target="settings.xml"' in doc_rels
          and "/word/settings.xml" in types)
    sect = xml[xml.rfind("<w:sectPr"):]
    check("docx: section RTL only for Arabic", ("<w:bidi/>" in sect) == (tgt == "ar"))
    check("docx: language tag", f'w:val="{DOC_LANG[tgt]}"' in xml)
    check("docx: translated text present", EXPECT[tgt] in xml)
    if tgt == "en":
        par = next(p for p in xml.split("<w:p>") if "صبر" in p)
        check("docx: English paragraph with an Arabic word stays LTR", "<w:bidi/>" not in par)
    if tgt == "ar":
        body = [p for p in xml.split("<w:p>")[2:] if "فقرة" in p]
        check("docx: Arabic paragraphs are RTL", body and all("<w:bidi/>" in p for p in body))
    # Word reads jc left/right in a bidi paragraph as start/end: "right" would
    # put Arabic text against the LEFT margin; no jc = start = the right edge
    check("docx: RTL paragraphs are not end-aligned",
          not any("<w:bidi/>" in p and 'w:jc w:val="right"' in p for p in xml.split("<w:p>")))
    if tgt == "zh":
        check("docx: Chinese punctuation uses the East-Asian font (w:hint)", 'w:hint="eastAsia"' in xml)
        check("docx: Chinese paragraphs indented 2 characters and justified",
              'w:firstLineChars="200"' in xml and 'w:jc w:val="both"' in xml)
    else:
        check("docx: no East-Asian hint outside Chinese", "w:hint=" not in xml)

    # ---- text file
    txt = (ART / f"pair-{pair}.txt").read_text(encoding="utf-8")
    check("txt: translated text present", EXPECT[tgt] in txt)

    # ---- PDF
    doc = pymupdf.open(ART / f"pair-{pair}.pdf")
    fams = font_families(doc)
    check(f"pdf: fonts {sorted(FONTS[tgt])}", FONTS[tgt] <= fams, f"embedded: {sorted(fams)}")
    text = "".join(p.get_text() for p in doc)
    if tgt == "ar":
        check("pdf: shaped Arabic present", any(0xFB50 <= ord(c) <= 0xFEFF for c in text))
        check("pdf: Latin island intact", "Baker Street 221" in text)
    else:
        check("pdf: translated text present", EXPECT[tgt] in text.replace("\n", ""),
              text[:200].replace("\n", " ⏎ "))
    width = doc[0].rect.width
    out_of_bounds = [
        (pno, c) for pno in range(doc.page_count) for row in rows(doc[pno]) for x0, x1, c in row
        if c.strip() and (x0 < MARGIN_PT - 2 or x1 > width - MARGIN_PT + 2)
    ]
    check("pdf: every glyph inside the margins", not out_of_bounds, str(out_of_bounds[:5]))
    if tgt == "zh":
        all_rows = [r for pno in range(doc.page_count) for r in rows(doc[pno])]
        long_rows = [r for r in all_rows if any(c == "很" for _, _, c in r)]
        check("pdf: long Chinese paragraph wraps onto several lines", len(long_rows) >= 2, str(len(long_rows)))
        bad = ["".join(c for _, _, c in r)[:8] for r in all_rows if r and r[0][2] in NO_LINE_START]
        check("pdf: no Chinese line starts with closing punctuation", not bad, str(bad[:5]))
    if tgt == "en":
        row = next(r for r in rows(doc[0]) if "keeps" in "".join(c for _, _, c in r))
        arabic = "".join(unicodedata.normalize("NFKC", c) for _, _, c in row if 0x0600 <= ord(unicodedata.normalize("NFKC", c)[0]) <= 0x06FF)
        check("pdf: Arabic word inside English drawn right-to-left", arabic == "ربص", repr(arabic))

print(f"\nvalidate_multilang: {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
