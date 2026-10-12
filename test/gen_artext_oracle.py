"""Generate the bidi/shaping oracle with the reference Python implementations."""
import json
import os
import tempfile

import arabic_reshaper
from bidi.algorithm import get_display

CASES = [
    "فقرة مترجمة رقم 1 — نصٌ عربيّ تجريبي.",
    "فقرة فيها اسم أجنبي Baker Street 221 وسط النص العربي.",
    "السلام عليكم ورحمة الله",
    "قال: «أهلاً وسهلاً» ثم غادر.",
    "هل تريد (الشاي) أم القهوة؟",
    "الفصل الأول",
    "عام 2026 كان مميزًا بنسبة 75% تقريبًا.",
    "لا إله إلا الله، ولا حول ولا قوة إلا بالله.",
    "كلمة إنجليزية English وسط الجملة.",
    "أرقام عربية ١٢٣٤٥ وأرقام لاتينية 12345.",
    "نصٌ مُشكَّلٌ بالحركاتِ الكاملةِ تجريبيٌّ.",
    "«اقتباس كامل بين علامات»",
    "سؤال؟ جواب! نهاية.",
    "التاريخ: 2026-08-01 والوقت 7:30 مساءً.",
    "قائمة: أولاً، ثانياً، ثالثاً (مع أقواس) [ومعقوفات].",
    "نسبة 50% من الكتاب — أي النصف تقريباً.",
    "اسمه Dr. Bassem وعنوانه معروف.",
    "يا لَيتَ قَومي يَعلَمونَ بِما غَفَرَ لي رَبّي.",
]
resh = arabic_reshaper.ArabicReshaper({"delete_harakat": False, "support_ligatures": True})
out = [{"src": s, "py_shaped": resh.reshape(s), "py_visual": get_display(resh.reshape(s), base_dir="R")} for s in CASES]
with open(os.path.join(tempfile.gettempdir(), "artext_oracle.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print(f"{len(out)} oracle cases written")
