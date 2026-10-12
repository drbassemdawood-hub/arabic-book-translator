"""Build the fonts embedded in PDF output (vendor/).

The PDF writer (jsPDF) needs TrueType fonts, and no single font covers every
script the app outputs, so three are embedded with per-character fallback:

  Amiri-Regular.ttf       Arabic + Latin          (committed as-is)
  NotoSerif-Regular.ttf   Latin + Cyrillic         (copied as-is, 0.5 MB)
  NotoSerifSC-Regular.ttf Simplified Chinese      (SUBSET, see below)

Noto Serif SC is 15 MB, so it is subset to the GB2312 character set (6,763
characters) united with the 2013 Table of General Standard Chinese Characters
(通用规范汉字表, 8,105 characters, list in tools/tongyong-8105.txt) — together
they cover modern Simplified Chinese — plus punctuation, symbols, full-width
forms and Latin, Basic Multilingual Plane only (jsPDF cannot draw
supplementary-plane characters reliably). Characters outside it still appear
in the Word and Print outputs; the PDF builder reports any it cannot draw.

All three fonts are licensed under the SIL Open Font License 1.1; their
license texts are collected into vendor/FONTS-LICENSE.txt.

Usage (source fonts come from the npm packages @expo-google-fonts/noto-serif
and @expo-google-fonts/noto-serif-sc):

    npm install --prefix <dir> @expo-google-fonts/noto-serif@0.4.2 @expo-google-fonts/noto-serif-sc@0.4.4
    python tools/make_fonts.py <dir>/node_modules/@expo-google-fonts
"""
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"


def gb2312_codepoints() -> set[int]:
    out = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(ord(bytes([hi, lo]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    return out


def tongyong_codepoints() -> set[int]:
    """The 8,105 characters of the 2013 general standard table (tools/tongyong-8105.txt)."""
    text = (Path(__file__).parent / "tongyong-8105.txt").read_text(encoding="utf-8")
    cps = {int(tok, 16) for line in text.splitlines() if not line.startswith("#") for tok in line.split()}
    assert len(cps) == 8105, len(cps)
    return cps


def build_chinese(src: Path, dst: Path) -> None:
    keep = (
        gb2312_codepoints()             # includes symbols: ≤ ≥ → ① ● ★ …
        | tongyong_codepoints()
        | set(range(0x20, 0x7F))        # ASCII
        | set(range(0xA0, 0x180))       # Latin-1 + Latin Extended-A
        | set(range(0x2000, 0x2070))    # general punctuation (— … “ ” ‘ ’)
        | set(range(0x3000, 0x3040))    # CJK symbols and punctuation (，。「」《》)
        | set(range(0xFF00, 0xFFF0))    # full-width forms (！？：；（）)
    )
    font = TTFont(str(src))
    cmap = font.getBestCmap()
    keep = sorted(cp for cp in keep if cp in cmap and cp <= 0xFFFF)
    opts = subset.Options()
    opts.layout_features = []           # jsPDF does no OpenType shaping
    opts.hinting = False
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "DSIG"]
    opts.name_IDs = ["*"]               # keep copyright/license names
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=keep)
    sub.subset(font)
    font.save(str(dst))
    han = sum(1 for cp in keep if 0x4E00 <= cp <= 0x9FFF)
    print(f"{dst.name}: {len(keep)} characters ({han} hanzi), {dst.stat().st_size / 1e6:.2f} MB")


def main() -> None:
    pkgs = Path(sys.argv[1])
    serif_pkg = pkgs / "noto-serif"
    sc_pkg = pkgs / "noto-serif-sc"

    shutil.copyfile(serif_pkg / "400Regular" / "NotoSerif_400Regular.ttf", VENDOR / "NotoSerif-Regular.ttf")
    print(f"NotoSerif-Regular.ttf: {(VENDOR / 'NotoSerif-Regular.ttf').stat().st_size / 1e6:.2f} MB")
    build_chinese(sc_pkg / "400Regular" / "NotoSerifSC_400Regular.ttf", VENDOR / "NotoSerifSC-Regular.ttf")

    amiri_notice = TTFont(str(VENDOR / "Amiri-Regular.ttf")).get("name").getDebugName(0) or "Amiri"
    sections = [
        "Fonts embedded in PDF output — all licensed under the SIL Open Font License, Version 1.1.",
        "NotoSerifSC-Regular.ttf is a character subset of Noto Serif SC (GB2312 + the 2013 general standard "
        "table), built by tools/make_fonts.py.",
        "",
        "=" * 70,
        "Amiri-Regular.ttf",
        "=" * 70,
        amiri_notice,
        "Licensed under the SIL Open Font License, Version 1.1 (full text below).",
        "",
        "=" * 70,
        "NotoSerif-Regular.ttf (Noto Serif)",
        "=" * 70,
        (serif_pkg / "LICENSE_FONT").read_text(encoding="utf-8").strip(),
        "",
        "=" * 70,
        "NotoSerifSC-Regular.ttf (Noto Serif SC, subset)",
        "=" * 70,
        (sc_pkg / "LICENSE_FONT").read_text(encoding="utf-8").strip(),
        "",
    ]
    (VENDOR / "FONTS-LICENSE.txt").write_text("\n".join(sections), encoding="utf-8", newline="\n")
    print("FONTS-LICENSE.txt written")


if __name__ == "__main__":
    main()
