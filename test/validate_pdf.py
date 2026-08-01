"""Validate the browser-generated Arabic PDF (test/artifacts/sample.ar.pdf):
glyph-level RTL correctness — run after e2e.mjs has produced the artifact."""
import sys
import unicodedata

import fitz

doc = fitz.open("artifacts/sample.ar.pdf")
assert doc.page_count >= 1, "PDF has no pages"
page = doc[0]

chars = []
for block in page.get_text("rawdict")["blocks"]:
    for line in block.get("lines", []):
        for span in line["spans"]:
            for ch in span["chars"]:
                chars.append((round(ch["bbox"][1]), round(ch["bbox"][0]), ch["c"]))

rows: dict[int, list] = {}
for y, x, c in chars:
    rows.setdefault(y, []).append((x, c))
ys = sorted(rows)

# row 0: title; row 1: first body line "فقرة مترجمة رقم 1 — نصٌ عربيّ تجريبي."
row1 = sorted(rows[ys[1]])
x_period = next(x for x, c in row1 if c == ".")
x_digit = next(x for x, c in row1 if c == "1")
x_dash = next(x for x, c in row1 if c == "—")
x_raqam = max(x for x, c in row1 if unicodedata.normalize("NFKC", c) in "رقم")
x_arabic_min = min(x for x, c in row1 if unicodedata.normalize("NFKC", c) not in ".1")

assert x_period < x_arabic_min, "sentence-final period must render leftmost (RTL line end)"
assert x_dash < x_digit < x_raqam, "digit must sit visually between — and رقم"

# mixed-direction row: Baker Street 221 must read LTR inside the RTL line
row2 = sorted(rows[ys[2]])
text2 = "".join(c for _, c in row2)
assert "Baker Street 221" in text2, f"Latin island must appear in visual LTR order, got: {text2!r}"

# Arabic must be shaped (presentation forms), not isolated base letters
all_text = "".join(c for _, _, c in chars)
assert any(0xFB50 <= ord(c) <= 0xFEFF for c in all_text), "Arabic must use shaped presentation forms"

print("validate_pdf: all glyph-position checks passed")
sys.exit(0)
