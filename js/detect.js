/* Which language is this book in? A cheap, offline guess used only to catch
 * a wrong language-pair choice BEFORE any paid request is made. */

const SAMPLE_CHARS = 60000;

const EN_WORDS = new Set(["the", "and", "of", "to", "is", "was", "that", "with", "for", "his", "her", "it", "you", "he", "she", "this", "have", "not", "but", "they"]);
const DE_WORDS = new Set(["der", "die", "und", "das", "ist", "nicht", "mit", "ein", "eine", "sich", "zu", "den", "dem", "auf", "ich", "sie", "es", "war", "auch", "aber"]);

/**
 * Returns { lang, confidence } where lang is one of "en", "de", "ar", "zh",
 * "uk", or a broader "latin" / "cyrillic" / "unknown" when the script is
 * clear but the specific language is not (e.g. Russian vs Ukrainian).
 */
export function detectLanguage(text) {
  const sample = text.slice(0, SAMPLE_CHARS);
  let arabic = 0, han = 0, cyr = 0, latin = 0, ukOnly = 0, ruOnly = 0;
  for (const ch of sample) {
    if (/\p{Script=Arabic}/u.test(ch)) { if (/\p{L}/u.test(ch)) arabic++; }
    else if (/\p{Script=Han}/u.test(ch)) han++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) {
      cyr++;
      if (/[іїєґІЇЄҐ]/.test(ch)) ukOnly++;
      else if (/[ыэъёЫЭЪЁ]/.test(ch)) ruOnly++;
    } else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  const letters = arabic + han + cyr + latin;
  if (letters < 40) return { lang: "unknown", confidence: 0 };

  const top = Math.max(arabic, han, cyr, latin);
  const share = top / letters;
  if (top === arabic) return { lang: "ar", confidence: share };
  if (top === han) return { lang: "zh", confidence: share };
  if (top === cyr) {
    // і/ї/є/ґ are frequent in Ukrainian and absent from Russian; ы/э/ъ/ё the reverse
    if (ukOnly > 0 && ukOnly >= ruOnly) return { lang: "uk", confidence: share };
    return { lang: ruOnly > 0 ? "cyrillic" : "uk", confidence: ruOnly > 0 ? share : share * 0.5 };
  }
  // Mis-decoded legacy text (Arabic/Chinese/Ukrainian read as windows-1252, or
  // a broken text layer) is almost all Latin-1 letters; real German/French <20%.
  const latin1 = (sample.match(/[À-ÖØ-öø-ÿ]/g) || []).length;
  if (latin1 / latin > 0.3) return { lang: "garbled", confidence: 1 };
  // Latin script: English or German?
  let en = 0, de = 0;
  for (const w of sample.toLowerCase().match(/\p{L}+/gu) || []) {
    if (EN_WORDS.has(w)) en++;
    if (DE_WORDS.has(w)) de++;
  }
  de += (sample.match(/[äöüß]/gi) || []).length / 4;
  if (en + de < 10) return { lang: "latin", confidence: share };
  if (en > de * 2) return { lang: "en", confidence: share };
  if (de > en * 2) return { lang: "de", confidence: share };
  return { lang: "latin", confidence: share };
}

const SCRIPT_OF = { en: "latin", de: "latin", uk: "cyrillic", ar: "arabic", zh: "han" };

// Scripts real books are written or quote in. A page may mix them freely (an
// English book quoting Arabic, a German one quoting Greek) — only letters
// outside them signal a corrupted text layer.
const BOOK_SCRIPTS = /[\p{Script=Latin}\p{Script=Arabic}\p{Script=Han}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}]/u;
const ZH_EXTRA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u; // fine in a Chinese book
const JUNK = /[-�]/u; // private-use glyph codes, replacement character
// Arabic/Ukrainian code-page bytes shown through WinAnsi ('ÇáÍãÏ ááå'): Latin-1 letters
const MOJIBAKE = /[À-ÖØ-öø-ÿ]/u;

// letters that belong to no particular script: tatweel (kashida), the
// mathematical letters 𝑥 𝛼 of Word/LaTeX equations, modifier letters ʿ ʾ
const SCRIPTLESS = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Does a PDF page's text layer look corrupted? Many PDFs (Arabic ones above
 * all) map their glyphs to the wrong characters, so the "text" is gibberish
 * in unrelated scripts, private-use codes, or Latin-1 mojibake — such a page
 * must be read with OCR from its image instead. `src` is the chosen source
 * language.
 * For English/German books only private-use codes and U+FFFD count: their
 * pages may legitimately quote any script (Sanskrit, Japanese, …).
 */
export function textLayerLooksBroken(text, src) {
  let letters = 0;
  let bad = 0;
  // GBK/Big5 bytes shown through WinAnsi contain no Han at all, while a real
  // Chinese page — even one with tone-marked pinyin (Latin-1) — is mostly Han
  const checkMojibake = src === "ar" || src === "uk" ||
    (src === "zh" && (text.match(/\p{Script=Han}/gu) || []).length < 0.1 * (text.match(/\p{L}/gu) || []).length);
  for (const ch of text) {
    if (JUNK.test(ch)) { bad++; letters++; continue; }
    if (!/\p{L}/u.test(ch) || SCRIPTLESS.test(ch)) continue;
    letters++;
    if (src === "en" || src === "de") continue;
    if (checkMojibake && MOJIBAKE.test(ch)) { bad++; continue; }
    if (!BOOK_SCRIPTS.test(ch) && !(src === "zh" && ZH_EXTRA.test(ch))) bad++;
  }
  return letters >= 30 && bad / letters > 0.15;
}

// ----------------------------------------- religious context of an Arabic book

// Honorifics an author writes in his OWN voice. A Christian author does not put
// عليه السلام after the Messiah or ﷺ after the Prophet, while a Muslim author
// writing about Christianity freely says يسوع, الكنيسة, الكتاب المقدس.
// ("ألقى/رد عليه السلام" = "greeted him / returned his greeting", not the honorific.)
const MUSLIM_VOICE = [
  "ﷺ", "صلى الله عليه وسلم", "صلى الله عليه و سلم", "رضي الله عن", "رحمه الله", "رحمها الله", "رحمهم الله",
  "(?<!(?:ألقى|ألقت|ألقوا|ألقيت|ألقينا|يلقي|تلقي|نلقي|رد|ردت|ردوا|رددت|رددنا|يرد|ترد|نرد|أرد) )(?:عليه|عليها|عليهم) السلام",
  "سبحانه وتعالى", "سبحانه و تعالى", "عز وجل", "جل جلاله", "قال تعالى", "قوله تعالى", "قال الله تعالى",
];
const MUSLIM_VOICE_RE = new RegExp(MUSLIM_VOICE.join("|"), "gu");
// ... plus scripture and isnad wording typical of Islamic religious writing
// (isnad verbs as whole words only: not تحدثنا "we talked", يحدثنا "he tells us")
const ISLAMIC_MARKERS = new RegExp([
  ...MUSLIM_VOICE, "﴿", "رسول الله", "(?<!\\p{L})[وف]?(?:حدثنا|أخبرنا)(?!\\p{L})",
].join("|"), "gu");
// Wording only Christian writing uses. No words with an everyday secular sense:
// الأب والابن (father and son), العهد الجديد/القديم (the new/old regime,
// ولي العهد), الكاهن (pagan priests), الأسقف (also "the ceilings").
const CHRISTIAN_MARKERS = new RegExp([
  "يسوع", "الروح القدس", "الكنيسة", "الكنائس", "الكتاب المقدس", "أسفار العهد القديم", "أسفار العهد الجديد",
  "القديس", "المعمودية", "الأساقفة", "المطران", "البطريرك", "السيد المسيح", "الآب والابن",
  "الأب والابن والروح القدس",
].join("|"), "g");
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/**
 * What kind of book is this ARABIC text, for rendering الله, honorifics and
 * prophets' names? Decided ONCE from the whole book, so every passage —
 * translated separately — follows the same convention:
 * "christian" (Christian wording), "islamic" (dense Islamic formulas,
 * scripture and hadith — a religious work), or "general" (anything else,
 * e.g. a novel whose characters swear by God now and then). Both religious
 * classes need a real density: a few incidental mentions of a church or of
 * the Prophet in a 300-page novel do not make it a religious book.
 */
export function religiousContext(text) {
  const plain = text.replace(TASHKEEL, "");
  const per10k = (n) => (n * 10000) / Math.max(plain.length, 1);
  const count = (re) => (plain.match(re) || []).length;
  const islamic = count(ISLAMIC_MARKERS);
  const christian = count(CHRISTIAN_MARKERS);
  const voice = count(MUSLIM_VOICE_RE);
  const isl = islamic >= 3 && per10k(islamic) >= 2;
  // a Muslim author discussing Christianity (his own honorifics are dense) stays islamic
  if (isl && voice >= 3 && per10k(voice) >= 2) return "islamic";
  if (christian >= 3 && per10k(christian) >= 2 && christian > islamic) return "christian";
  if (isl) return "islamic";
  return "general";
}

// ------------------------------------------------- is a decoding plausible?

// Most frequent letters/characters of real text in each script. Real text is
// dominated by them; text decoded with the WRONG legacy encoding is not.
const COMMON = {
  latin: new Set("etaoinsrhldcugm"),
  arabic: new Set("اليمونهرتبعدكفقسحأإةى"),
  cyrillic: new Set("оаеиінтрсвлкдмпуяз"),
  han: new Set(
    "的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天" +
    "而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些" +
    "与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相" +
    "次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马" +
    "命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战" +
    "這們說來為時個國過還對會學經發開現問當動頭電話後進點長從實無與覺樣種見親幾聽師東車書門間將給讓難應題麼裡錢關體邊認讀員遠總數"),
};

/** 0..1: how much `text` looks like real writing in its dominant script
 * (0 for gibberish). Used to choose a legacy text encoding. */
export function plausibility(text) {
  const sample = text.slice(0, SAMPLE_CHARS);
  const counts = { latin: 0, arabic: 0, cyrillic: 0, han: 0 };
  const hits = { latin: 0, arabic: 0, cyrillic: 0, han: 0 };
  let other = 0;
  for (const raw of sample) {
    const ch = raw.toLowerCase();
    let s = null;
    if (/\p{Script=Han}/u.test(ch)) s = "han";
    else if (/\p{Script=Arabic}/u.test(ch) && /\p{L}/u.test(ch)) s = "arabic";
    else if (/\p{Script=Cyrillic}/u.test(ch)) s = "cyrillic";
    else if (/\p{Script=Latin}/u.test(ch)) s = "latin";
    else if (/\p{L}/u.test(ch) || ch === "�") { other++; continue; }
    else continue;
    counts[s]++;
    if (COMMON[s].has(ch)) hits[s]++;
  }
  const total = counts.latin + counts.arabic + counts.cyrillic + counts.han + other;
  if (total < 20) return 0;
  const top = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
  return (hits[top] / counts[top]) * (counts[top] / total);
}

/**
 * If the detected language clearly contradicts the chosen source language,
 * returns a human-readable description of what the book looks like;
 * otherwise null.
 */
export function sourceMismatch(text, expectedSrc) {
  const { lang, confidence } = detectLanguage(text);
  if (lang === "unknown" || confidence < 0.6 || lang === expectedSrc) return null;
  const NAMES = {
    en: "English", de: "German", ar: "Arabic", zh: "Chinese", uk: "Ukrainian",
    latin: "a Latin-script language", cyrillic: "a Cyrillic language other than Ukrainian (e.g. Russian)",
    garbled: "text that did not decode correctly (probably Arabic, Chinese or Ukrainian saved in an old " +
      "encoding, or a damaged PDF text layer) — choose the pair whose source is the book's real language",
  };
  // broad classes only contradict a source in a DIFFERENT script
  if (lang === "latin" && SCRIPT_OF[expectedSrc] === "latin") return null;
  if (lang === "cyrillic" && expectedSrc !== "uk" && SCRIPT_OF[expectedSrc] === "cyrillic") return null;
  return NAMES[lang];
}
