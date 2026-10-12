/* Unit tests for the language-pair support (no browser needed).
 *   node multilang_unit.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAIRS, LANGUAGES, parsePair, pairLabel, translationPrompt, reviewPrompt, reviewLabels, ocrPrompt,
  outputTokenRatio,
} from "../js/languages.js";
import { chunkText } from "../js/chunk.js";
import { detectLanguage, sourceMismatch, textLayerLooksBroken, religiousContext } from "../js/detect.js";
import { wrapTokens, paragraphIsRtl, makeArabicLayout } from "../js/artext.js";
import { joinPdfPages, decodeLegacy, pageTextFromItems, extractTxt } from "../js/extract.js";
import { cmapCoverage } from "../js/output.js";

/** Encode a string in a legacy encoding (inverting TextDecoder's tables). */
const encoders = {};
function encodeLegacy(str, enc) {
  if (!encoders[enc]) {
    const map = new Map();
    const dec = new TextDecoder(enc);
    for (let b = 0; b < 256; b++) {
      const ch = dec.decode(new Uint8Array([b]));
      if (ch.length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, [b]);
    }
    if (enc === "gb18030" || enc === "big5") { // double-byte table
      for (let hi = 0x81; hi <= 0xfe; hi++) {
        for (let lo = 0x40; lo <= 0xfe; lo++) {
          const ch = dec.decode(new Uint8Array([hi, lo]));
          if ([...ch].length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, [hi, lo]);
        }
      }
    }
    encoders[enc] = map;
  }
  const out = [];
  for (const ch of str) {
    const bytes = encoders[enc].get(ch);
    if (!bytes) throw new Error(`cannot encode ${ch} in ${enc}`);
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

// ------------------------------------------------------------------ languages
console.log("languages / prompts");
check("eight pairs", PAIRS.length === 8);
const expected = ["en-ar", "ar-en", "ar-uk", "uk-ar", "ar-zh", "zh-ar", "ar-de", "de-ar"];
check("the requested directions, in order", JSON.stringify(PAIRS) === JSON.stringify(expected));
for (const pair of PAIRS) {
  const { source, target } = parsePair(pair);
  const t = translationPrompt(pair);
  const r = reviewPrompt(pair);
  check(`${pair}: translate prompt names both languages`,
    t.includes(`${source.name} book into ${target.targetName}`), t.split("\n")[0]);
  check(`${pair}: review prompt is the bilingual editor`, r.includes("bilingual editor") && r.includes(`${source.name} source`));
  check(`${pair}: labels`, reviewLabels(pair).source === `${source.name.toUpperCase()} SOURCE`);
  check(`${pair}: menu label`, pairLabel(pair).includes("→"));
  check(`${pair}: positive output ratio`, outputTokenRatio(pair) > 0.3 && outputTokenRatio(pair) < 3);
  check(`${pair}: no undefined in prompts`, !/undefined/.test(t + r + ocrPrompt(pair.split("-")[0])));
}
check("grammar: 'an English book'", translationPrompt("en-ar").includes("an English book"));
check("grammar: 'a Ukrainian book'", translationPrompt("uk-ar").includes("a Ukrainian book"));
check("grammar: 'a Chinese book'", translationPrompt("zh-ar").includes("a Chinese book"));
check("Arabic source notes reach the prompt", translationPrompt("ar-en").includes("Qur'an"));
check("Ukrainian target forbids Russian forms", translationPrompt("ar-uk").includes("never Russian"));
check("Chinese target demands Simplified", translationPrompt("ar-zh").includes("Simplified characters only"));
check("German target handles Sie/du", translationPrompt("ar-de").includes("use Sie between adults"));
check("OCR prompt keeps [BLANK] protocol", ocrPrompt("zh").includes("[BLANK]"));
check("every language has a marker", Object.values(LANGUAGES).every((l) => l.marker && l.marker.includes(l.markerSearch)));
let threw = false;
try { parsePair("en-de"); } catch { threw = true; }
check("unsupported pair rejected", threw);

// --------------------------------------------------------------------- chunks
console.log("chunking");
const zhSentence = "他走进了古老的图书馆，看见学者们提着灯笼穿过长长的走廊。";
const zhPar = zhSentence.repeat(400); // one huge paragraph, no spaces at all
const zhChunks = chunkText(zhPar, 3000);
check("Chinese: split into several chunks", zhChunks.length > 1, `got ${zhChunks.length}`);
check("Chinese: no content lost or spaces added", zhChunks.join("").replace(/\n/g, "") === zhPar);
check("Chinese: cuts land after 。", zhChunks.slice(0, -1).every((c) => c.endsWith("。")));
check("Chinese: within limit", zhChunks.every((c) => c.length <= 3000));
const arSentence = "هل رأيتَ المكتبةَ القديمةَ في ضوءِ القمرِ؟ ";
const arPar = arSentence.repeat(300).trim();
const arChunks = chunkText(arPar, 8000);
check("Arabic: long paragraph splits at ؟", arChunks.length > 1 && arChunks.slice(0, -1).every((c) => c.endsWith("؟")));
check("Arabic: nothing lost", arChunks.join(" ").replace(/\s+/g, " ") === arPar.replace(/\s+/g, " "));
const ukPar = "«Ти прийдеш завтра?» — запитала вона. ".repeat(400).trim();
const ukChunks = chunkText(ukPar, 10000);
check("Ukrainian: splits after ?»", ukChunks.length > 1 && ukChunks.slice(0, -1).every((c) => /[.?»]$/.test(c)));
const enPar = "He paused (as one does.) Then he left. ".repeat(500).trim();
check("English: '.)' is still NOT a boundary (unchanged behavior)",
  !chunkText(enPar, 10000).some((c) => c.endsWith(".)")));
const astral = "𠀀".repeat(5000); // supplementary-plane characters, no breaks
check("no surrogate pair split", chunkText(astral, 3001).every((c) => !/[\uD800-\uDBFF]$/.test(c)));

// ------------------------------------------------------------------ detection
console.log("language detection");
const SAMPLES = {
  en: "The old library stood silent beneath the moon, and the scholars carried their lanterns through the corridors of forgotten wisdom. It was the time of the year when the river was high. ",
  de: "Die alte Bibliothek stand still unter dem Mond, und die Gelehrten trugen ihre Laternen durch die Gänge des vergessenen Wissens. Es war die Zeit des Jahres, in der der Fluss hoch stand. ",
  ar: "وقفت المكتبة القديمة صامتةً تحت ضوء القمر، وحمل العلماء فوانيسهم عبر أروقة الحكمة المنسية. كان ذلك في الوقت من السنة الذي يرتفع فيه النهر. ",
  zh: "古老的图书馆在月光下静静地矗立着，学者们提着灯笼穿过被遗忘的智慧长廊。那正是一年中河水上涨的时节。",
  uk: "Стара бібліотека мовчки стояла під місяцем, і вчені несли свої ліхтарі крізь коридори забутої мудрості. Це була та пора року, коли річка була високою. ",
};
for (const [lang, text] of Object.entries(SAMPLES)) {
  check(`detects ${lang}`, detectLanguage(text.repeat(5)).lang === lang, JSON.stringify(detectLanguage(text.repeat(5))));
  check(`no false alarm for ${lang}`, sourceMismatch(text.repeat(5), lang) === null);
}
check("English book with Arabic→English chosen is flagged", sourceMismatch(SAMPLES.en.repeat(5), "ar") === "English");
check("German book chosen as English source is flagged", sourceMismatch(SAMPLES.de.repeat(5), "en") === "German");
check("Arabic book chosen as Chinese source is flagged", sourceMismatch(SAMPLES.ar.repeat(5), "zh") === "Arabic");
const russian = "Старая библиотека молча стояла под луной, и учёные несли свои фонари через коридоры забытой мудрости. Это было время года, когда река была высокой. ";
check("Russian book chosen as Ukrainian is flagged", /Cyrillic/.test(sourceMismatch(russian.repeat(5), "uk") || ""));
check("tiny text: no verdict", sourceMismatch("Hi.", "ar") === null);

// ------------------------------------------------- review fixes: detection
console.log("review fixes: corrupted text / mojibake / quotations");
const arSent = "وقفت المكتبة القديمة صامتة تحت ضوء القمر، وحمل العلماء فوانيسهم عبر أروقة الحكمة المنسية.";
const ukSent = "Стара бібліотека мовчки стояла під місяцем, і вчені несли свої ліхтарі крізь коридори забутої мудрості.";
const zhSent = "古老的图书馆在月光下静静地矗立着，学者们提着灯笼穿过被遗忘的智慧长廊。";
const zhTrad = "古老的圖書館在月光下靜靜地矗立著，學者們提著燈籠穿過被遺忘的智慧長廊。";
const asCp1252 = (s, enc) => new TextDecoder("windows-1252").decode(encodeLegacy(s, enc));
const arMoj = asCp1252(arSent.repeat(4), "windows-1256");
const ukMoj = asCp1252(ukSent.repeat(4), "windows-1251");
const zhMoj = asCp1252(zhSent.repeat(6), "gb18030");
for (const [name, moj] of [["Arabic", arMoj], ["Ukrainian", ukMoj], ["Chinese", zhMoj]]) {
  check(`${name} mojibake is 'garbled', never 'German'`, detectLanguage(moj).lang === "garbled", JSON.stringify(detectLanguage(moj)));
}
check("garbled text is flagged even with an English source chosen", /did not decode/.test(sourceMismatch(arMoj, "en") || ""));
check("garbled text is flagged with a German source chosen", /did not decode/.test(sourceMismatch(zhMoj, "de") || ""));
check("Arabic mojibake page = corrupted text layer (ar)", textLayerLooksBroken(arMoj, "ar"));
check("Ukrainian mojibake page = corrupted text layer (uk)", textLayerLooksBroken(ukMoj, "uk"));
const enQuoting = "The author records the saying in full: " + arSent + " " + arSent +
  " In English, this sentence sets the theme of the whole chapter that follows.";
check("English page quoting Arabic is NOT corrupted (en→ar regression)", !textLayerLooksBroken(enQuoting, "en"));
check("German page quoting Greek is NOT corrupted",
  !textLayerLooksBroken("Der Begriff λόγος bedeutet Wort und Vernunft; Heraklit nennt den λόγος ewig. ".repeat(3), "de"));
check("Arabic page quoting French is NOT corrupted",
  !textLayerLooksBroken(`${arSent} « la liberté, l'égalité et la fraternité » ${arSent}`, "ar"));
check("good Arabic page under a WRONG pair is NOT 'corrupted' (no OCR bill)", !textLayerLooksBroken(arSent.repeat(3), "en"));
const soup = "ܐܒܓܕܗ ސޑޒޓޔ ߊߋߌߍߎ ਅਆਇਈਉ ".repeat(6) + "ﺍﻟﻜﺘﺎﺏ";
check("gibberish in unrelated scripts IS corrupted", textLayerLooksBroken(soup, "ar"));
check("Chinese page with Japanese kana quote is NOT corrupted",
  !textLayerLooksBroken(zhSent + "「ありがとう」と彼は言った。" + zhSent, "zh"));

console.log("review fixes: legacy text encodings");
check("cp1256 Arabic .txt decodes right even with English chosen",
  decodeLegacy(encodeLegacy(arSent.repeat(5), "windows-1256"), "windows-1252") === arSent.repeat(5));
check("cp1251 Ukrainian .txt decodes right even with Arabic chosen",
  decodeLegacy(encodeLegacy(ukSent.repeat(5), "windows-1251"), "windows-1256") === ukSent.repeat(5));
check("GBK Chinese .txt still decodes as GB18030",
  decodeLegacy(encodeLegacy(zhSent.repeat(5), "gb18030"), "gb18030") === zhSent.repeat(5));
check("Big5 Traditional .txt is NOT mistaken for GB18030",
  decodeLegacy(encodeLegacy(zhTrad.repeat(5), "big5"), "gb18030") === zhTrad.repeat(5));
check("GBK Chinese .txt decodes right even with English chosen",
  decodeLegacy(encodeLegacy(zhSent.repeat(5), "gb18030"), "windows-1252") === zhSent.repeat(5));
check("windows-1252 German .txt unchanged",
  decodeLegacy(encodeLegacy(SAMPLES.de.repeat(3), "windows-1252"), "windows-1252") === SAMPLES.de.repeat(3));

console.log("review fixes: PDF line assembly");
const item = (str, x, w, eol = false) => ({ str, transform: [1, 0, 0, 1, x, 700], width: w, hasEOL: eol });
// an Arabic line drawn word by word, left to right, with an English name and a year inside
const arLine = [item("الرواية", 50, 40), item("كان", 95, 20), item("2005", 120, 25), item("إن", 150, 12),
  item("Harry", 165, 30), item("Potter", 200, 35), item("قال", 240, 18), item("وقد", 262, 20, true)];
check("Arabic line: right-to-left order with 'Harry Potter' kept left-to-right",
  pageTextFromItems(arLine, "ar") === "وقد قال Harry Potter إن 2005 كان الرواية", pageTextFromItems(arLine, "ar"));
const enLine = [item("The", 72, 20), item("Prophet", 96, 45), item("said:", 145, 30),
  item("إنما الأعمال بالنيات", 180, 120, true)];
check("English book: a line quoting Arabic keeps its exact old text (no reordering)",
  pageTextFromItems(enLine, "en") === "The Prophet said: إنما الأعمال بالنيات", pageTextFromItems(enLine, "en"));

console.log("review fixes: paragraph direction");
check("Arabic book: '* * *' follows the page (RTL)", paragraphIsRtl("* * *", true));
check("Arabic book: bare chapter number '12' follows the page (RTL)", paragraphIsRtl("12", true));
check("LTR book: Arabic paragraph with '(Hypertension)' is RTL",
  paragraphIsRtl("يعاني المريض من ارتفاع ضغط الدم (Hypertension) منذ سنوات، ويتناول الدواء يوميا.", false));

console.log("review fixes: PDF line joining");
const ukDialog = "— Ти підеш?\n— Ні…\n— Чому?\nВона прошепотіла: «Прощавай!»\nНаступного ранку він поїхав.";
check("Ukrainian dialogue lines stay separate", joinPdfPages([ukDialog], "uk") === ukDialog, JSON.stringify(joinPdfPages([ukDialog], "uk")));
const deDialog = "„Kommst du morgen?“\n„Ja.“\n»Lüg nicht!«\nEr nickte.";
check("German dialogue lines stay separate", joinPdfPages([deDialog], "de") === deDialog, JSON.stringify(joinPdfPages([deDialog], "de")));
const arDialog = "«من أنت؟»\n«أنا جارك.»\n«أهلًا بك»";
check("Arabic dialogue lines stay separate", joinPdfPages([arDialog], "ar") === arDialog);
check("German compounds keep their hyphen, syllable breaks are joined",
  joinPdfPages(["Das Max-\nPlanck-Institut und der Ein-\nund Ausgang mit einer Ver-\nbindung."], "de") ===
    "Das Max-Planck-Institut und der Ein- und Ausgang mit einer Verbindung.",
  JSON.stringify(joinPdfPages(["Das Max-\nPlanck-Institut und der Ein-\nund Ausgang mit einer Ver-\nbindung."], "de")));
check("English hyphenation unchanged", joinPdfPages(["a well-\nknown fact"]) === "a wellknown fact");

console.log("review fixes: language rules");
check("Arabic target restores Qur'an verses in ﴿…﴾ only when certain",
  translationPrompt("en-ar").includes("﴿…﴾") && translationPrompt("en-ar").includes("with certainty"));
check("English target fixes God/Allah + honorific renderings", translationPrompt("ar-en").includes("(peace be upon him)"));
check("English target has one transliteration scheme", translationPrompt("ar-en").includes("al-Ghazali"));
check("Chinese target: Chinese Muslim terminology", translationPrompt("ar-zh").includes("真主") && translationPrompt("ar-zh").includes("穆萨"));
check("German target: German name spelling", translationPrompt("ar-de").includes("Chadidscha"));
check("German target: no Sie in scripture/classics", translationPrompt("ar-de").includes("never use Sie merely"));
check("German target: spaced en dash", translationPrompt("ar-de").includes("en dash ( – )"));
check("German marker uses the German dash", LANGUAGES.de.marker.includes(" – "));
check("review pass enforces the Arabic scripture rule", reviewPrompt("de-ar").includes("﴿…﴾"));

// ------------------------------------------- verification round 2 regressions
console.log("round 2: numbers on Arabic PDF lines keep their order");
// items given in VISUAL left-to-right order, [text, gap to the next item]
const vis = (...parts) => {
  let x = 50;
  return parts.map(([s, gap = 3], k) => {
    const it = item(s, x, s.length * 5, k === parts.length - 1);
    x += s.length * 5 + gap;
    return it;
  });
};
const rtlCases = [
  [vis(["14"], ["،", 0], ["13"], ["،", 0], ["12"], ["الآيات"]), "الآيات 12، 13، 14"],
  [vis(["50"], ["-"], ["45"], ["ص"]), "ص 45 - 50"],
  [vis(["م"], ["2000"], ["–"], ["1990"], ["بين"], ["عاش"]), "عاش بين 1990 – 2000 م"],
  [vis(["السورة"], ["من"], ["7"], ["،", 0], ["6"], ["،", 0], ["5"], ["الآيات"], ["انظر"]),
    "انظر الآيات 5، 6، 7 من السورة"],
  [vis(["Windows"], ["10"], ["نظام"]), "نظام Windows 10"],
  [vis(["(Smith,"], ["2005,"], ["p."], ["23)"], ["قال"]), "قال (Smith, 2005, p. 23)"],
  [vis(["pp."], ["5"], ["–"], ["7"], ["انظر"]), "انظر pp. 5 – 7"],
];
for (const [items, want] of rtlCases) {
  const got = pageTextFromItems(items, "ar");
  check(`Arabic line reads '${want}'`, got === want, JSON.stringify(got));
}
check("'Harry Potter' line unchanged", pageTextFromItems(arLine, "ar") === "وقد قال Harry Potter إن 2005 كان الرواية");

console.log("round 2: corrupted-text-layer detector");
const gita = "The verse reads: धर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः मामकाः पाण्डवाश्चैव किमकुर्वत सञ्जय। " +
  "dharma-kṣetre kuru-kṣetre samavetā yuyutsavaḥ. Dhritarashtra said: O Sanjaya, what did they do?";
check("English page quoting Sanskrit is NOT corrupted", !textLayerLooksBroken(gita, "en"));
const mathPage = "Let 𝑓 ∶ 𝑋 → 𝑌 be continuous. Then 𝑑(𝑓(𝑥𝑛), 𝑓(𝑥)) < 𝜀 for all 𝑛 ≥ 𝑁, and 𝔼[𝑋̄] = 𝜇 with 𝜎² = 𝑉𝑎𝑟(𝑋). ";
check("English equation page (math italic letters) is NOT corrupted", !textLayerLooksBroken(mathPage.repeat(3), "en"));
check("Arabic page with equations is NOT corrupted", !textLayerLooksBroken(arSent + " " + mathPage.repeat(2) + arSent, "ar"));
const kashida = "الفـــــــصـــــــل الأول: الـــــمـــــكـــــتـــــبـــــة الـــــقـــــديـــــمـــــة ";
check("kashida-stretched Arabic heading is NOT corrupted", !textLayerLooksBroken(kashida.repeat(4), "ar"));
check("Chinese mojibake page = corrupted text layer (zh)", textLayerLooksBroken(zhMoj, "zh"));
const pinyinPage = "你好 nǐ hǎo，学习 xuéxí，再见 zàijiàn，谢谢 xièxie，朋友 péngyǒu，老师 lǎoshī。".repeat(4);
check("pinyin-annotated Chinese page is NOT corrupted", !textLayerLooksBroken(pinyinPage, "zh"));
check("private-use junk still IS corrupted for English", textLayerLooksBroken("  ".repeat(20) + "the end", "en"));
check("gibberish in unrelated scripts still IS corrupted (ar)", textLayerLooksBroken(soup, "ar"));

console.log("round 2: legacy decoding is judged by validity, not cross-script scores");
// (each of these was decoded as Cyrillic/Arabic/Latin gibberish by the old
// plausibility-only logic under at least one pair)
const zhMedical = "糖尿病是一组以高血糖为特征的代谢性疾病，高血糖则是由于胰岛素分泌缺陷或其生物作用受损引起的。";
const zhChem = "氢氧化钠溶液与盐酸发生中和反应，生成氯化钠和水，反应过程中释放热量，溶液的酸碱度随之改变。";
const zhNums = "第3章 2005年 第12页 表4-1 图2.3 共计156例 占37.5%";
const big5Novel = "他慢慢地走進房間，看見桌上放著一封信，信封上寫著他的名字，字跡非常熟悉。";
const arHist = "وفي سنة خمس وأربعين ومئتين خرج الخليفة إلى سامراء ومعه القواد والجند، فأقام بها شهورًا ثم عاد إلى بغداد.";
const arMed = "يعاني المريض من ارتفاع ضغط الدم منذ سنوات، ويتناول الدواء يوميًا بانتظام تحت إشراف الطبيب المختص.";
const ENCS = ["windows-1252", "windows-1256", "windows-1251", "gb18030"];
for (const [name, text, enc] of [
  ["GBK medical text", zhMedical, "gb18030"],
  ["GBK chemistry text", zhChem.repeat(3), "gb18030"],
  ["GBK line of numbers", zhNums, "gb18030"],
  ["Big5 novel line", big5Novel, "big5"],
  ["Big5 Traditional text", zhTrad.repeat(5), "big5"],
  ["cp1256 Arabic history", arHist, "windows-1256"],
  ["cp1256 Arabic medical", arMed.repeat(2), "windows-1256"],
  ["cp1251 Ukrainian", ukSent.repeat(5), "windows-1251"],
]) {
  const bytes = encodeLegacy(text, enc);
  const wrong = ENCS.filter((pref) => decodeLegacy(bytes, pref) !== text);
  check(`${name} decodes right whichever pair is chosen`, !wrong.length, `wrong under: ${wrong.join(", ")}`);
}
{
  const bytes = encodeLegacy(zhMedical.repeat(30), "gb18030");
  const half = bytes.length >> 1;
  const stray = new Uint8Array([...bytes.slice(0, half - (half % 2)), 0x81, 0x20, ...bytes.slice(half - (half % 2))]);
  const wrong = ENCS.filter((pref) => !decodeLegacy(stray, pref).includes(zhMedical));
  check("GBK text with one stray bad byte still decodes as Chinese", !wrong.length, `wrong under: ${wrong.join(", ")}`);
}

console.log("round 2: PDF line joining");
check("German 'Werk-\\nstatt' is one word", joinPdfPages(["in der Werk-\nstatt seines Vaters"], "de") === "in der Werkstatt seines Vaters",
  JSON.stringify(joinPdfPages(["in der Werk-\nstatt seines Vaters"], "de")));
check("Ukrainian mid-sentence dash merges",
  joinPdfPages(["Київ\n— столиця України, а Львів\n— місто Лева."], "uk") === "Київ — столиця України, а Львів — місто Лева.",
  JSON.stringify(joinPdfPages(["Київ\n— столиця України, а Львів\n— місто Лева."], "uk")));
check("Ukrainian en-dash variant merges too",
  joinPdfPages(["а Львів\n– місто Лева."], "uk") === "а Львів – місто Лева.");
check("Ukrainian interrupted speech stays two lines",
  joinPdfPages(["— Я думав, що ти —\n— Мовчи!"], "uk") === "— Я думав, що ти —\n— Мовчи!");
check("Ukrainian dialogue fixture unchanged", joinPdfPages([ukDialog], "uk") === ukDialog);

console.log("round 2: one religious convention per book");
const sira = "قال رسول الله صلى الله عليه وسلم: إنما الأعمال بالنيات. وروى أبو هريرة رضي الله عنه أن النبي ﷺ قال كذا. " +
  "قال تعالى: ﴿وما أرسلناك إلا رحمة للعالمين﴾. ثم مضى الحديث في وصف الغزوة وأحوال الناس في المدينة. ";
const gospel = "قال يسوع لتلاميذه: لا تضطرب قلوبكم. وحلّ الروح القدس على الرسل، واجتمعت الكنيسة للصلاة. " +
  "وقرأ الكاهن من الكتاب المقدس فصلًا من العهد الجديد، ثم بارك الجماعة باسم الآب والابن والروح القدس. ";
const novel = "خرج أحمد من البيت مبكرًا، ومشى في الحارة الضيقة حتى وصل إلى المقهى. قال لصديقه: والله لقد تعبت " +
  "من هذا العمل. ضحك صديقه وطلب كوبين من الشاي، وجلسا يتحدثان عن أيام الدراسة وعن المدينة التي تغيرت كثيرًا. ";
check("hadith/sira text → islamic", religiousContext(sira.repeat(20)) === "islamic", religiousContext(sira.repeat(20)));
check("vowelled formulas are recognised", religiousContext("صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ قال ذلك. ".repeat(5)) === "islamic");
check("Christian text → christian", religiousContext(gospel.repeat(10)) === "christian", religiousContext(gospel.repeat(10)));
check("novel with an oath → general", religiousContext(novel.repeat(30)) === "general", religiousContext(novel.repeat(30)));
check("novel with a rare ﷺ → general",
  religiousContext(novel.repeat(60) + "قال النبي ﷺ" + novel.repeat(60)) === "general");
const P = (pair, religion) => translationPrompt(pair, { religion });
const R = (pair, religion) => reviewPrompt(pair, { religion });
check("ar-en general: God, fixed — no per-passage 'book as a whole' test",
  P("ar-en", "general").includes("Render الله as \"God\" everywhere") && !P("ar-en", "general").includes("as a whole"));
check("ar-en islamic: Allah, also inside the formulas",
  P("ar-en", "islamic").includes("render الله as \"Allah\" everywhere") && P("ar-en", "islamic").includes("(may Allah be pleased"));
check("ar-en default prompt = general", P("ar-en", null) === translationPrompt("ar-en"));
check("ar-de general: Gott + fixed formulas + Bible names",
  P("ar-de", "general").includes("Render الله as „Gott“") && P("ar-de", "general").includes("(Gott segne ihn") &&
  P("ar-de", "general").includes("Abraham, Mose"));
check("ar-de islamic: Allah", P("ar-de", "islamic").includes("„Allah“ everywhere") && P("ar-de", "islamic").includes("(Allah segne ihn"));
check("ar-uk: Аллах with fixed formulas", P("ar-uk", "general").includes("«Аллах» everywhere") &&
  P("ar-uk", "general").includes("(хай благословить його Аллах і вітає)"));
check("ar-uk christian: Бог throughout", P("ar-uk", "christian").includes("«Бог» everywhere") &&
  P("ar-uk", "christian").includes("(хай благословить його Бог і вітає)"));
check("ar-zh christian: 上帝 only, never 'or 神'", P("ar-zh", "christian").includes("= 上帝 (never 神") &&
  !P("ar-zh", "christian").includes("上帝 or 神"));
check("ar-zh general: Chinese Muslim usage", P("ar-zh", "general").includes("真主") && P("ar-zh", "general").includes("穆萨"));
check("review pass enforces the same convention",
  R("ar-de", "islamic").includes("violations of this rule: This book is an Islamic religious work") &&
  R("ar-en", "general").includes("violations of this rule: Render الله as \"God\""));
check("Arabic-target prompts carry no God/Allah rule",
  ["en-ar", "uk-ar", "zh-ar", "de-ar"].every((p) => !P(p, "islamic").includes("Render الله")));

// ------------------------------------------- verification round 3 regressions
console.log("round 3: UTF-8 books with a stray or truncated byte");
{
  const books = {
    ar: [Array.from({ length: 300 }, (_, i) => `الفصل ${i}: كان الجو باردًا، وخرج العلماء إلى المكتبة القديمة.`).join("\n\n"), "windows-1256"],
    uk: [Array.from({ length: 300 }, (_, i) => `Розділ ${i}. Він вийшов до старої бібліотеки, і було холодно.`).join("\n\n"), "windows-1251"],
    zh: [Array.from({ length: 300 }, (_, i) => `第${i}章 他推开古老图书馆的门，学者们提着灯笼走过长廊。`).join("\n\n"), "gb18030"],
    en: [Array.from({ length: 300 }, (_, i) => `Chapter ${i}. “Hello,” she said in the café — it was cold.`).join("\n\n"), "windows-1252"],
  };
  for (const [lang, [text, enc]] of Object.entries(books)) {
    const bytes = new TextEncoder().encode(text);
    const mid = text.length >> 1;
    const cut = new TextEncoder().encode(text.slice(0, mid)).length;
    const stray = new Uint8Array([...bytes.slice(0, cut), 0x92, ...bytes.slice(cut)]);
    const truncated = new TextEncoder().encode(text + "é").slice(0, -1); // cut inside the last character
    const a = await extractTxt(new Blob([stray]), enc);
    const b = await extractTxt(new Blob([truncated]), enc);
    check(`${lang}: one stray byte keeps the UTF-8 text`, a.replace("�", "") === text, a.slice(0, 40));
    check(`${lang}: a truncated last character keeps the UTF-8 text`, b === text + "�", b.slice(0, 40));
  }
  const legacy = await extractTxt(new Blob([encodeLegacy(arSent.repeat(5), "windows-1256")]), "windows-1256");
  check("a real cp1256 file is still decoded as cp1256", legacy === arSent.repeat(5));
}

console.log("round 3: Hebrew / Syriac quotations on Arabic lines");
check("inline Syriac quote keeps its word order",
  pageTextFromItems(vis(["الصلاة"], ["في"], ["ܕܒܫܡܝܐ"], ["ܐܒܘܢ"], ["نقول"]), "ar") === "نقول ܐܒܘܢ ܕܒܫܡܝܐ في الصلاة",
  pageTextFromItems(vis(["الصلاة"], ["في"], ["ܕܒܫܡܝܐ"], ["ܐܒܘܢ"], ["نقول"]), "ar"));
check("Hebrew-only line (visual order) reads right to left",
  pageTextFromItems(vis(["אלהים"], ["ברא"], ["בראשית"]), "ar") === "בראשית ברא אלהים",
  pageTextFromItems(vis(["אלהים"], ["ברא"], ["בראשית"]), "ar"));
check("English line with one Hebrew word keeps stream order",
  pageTextFromItems(vis(["The"], ["word"], ["ברא"], ["means"], ["create."]), "ar") === "The word ברא means create.");

console.log("round 3: German hyphenation");
for (const [input, want] of [
  ["ging den-\nnoch weiter", "ging dennoch weiter"],
  ["Bücher so-\nwie Zeitschriften", "Bücher sowie Zeitschriften"],
  ["den Kür-\nbis im Garten", "den Kürbis im Garten"],
  ["des Materi-\nals ist gut", "des Materials ist gut"],
  ["mehr Ein-\nals Ausgänge", "mehr Ein- als Ausgänge"],
  ["Lehrer-\nwie Schülerschaft", "Lehrer- wie Schülerschaft"],
  ["der Ein-\nund Ausgang", "der Ein- und Ausgang"],
  ["Die EU-\nKommission", "Die EU-Kommission"],
  ["Der US-\nPräsident", "Der US-Präsident"],
  ["Der 100-\nMeter-Lauf", "Der 100-Meter-Lauf"],
  ["eine E-\nMail", "eine E-Mail"],
  ["KAPI-\nTEL EINS", "KAPITEL EINS"],
  ["Max-\nPlanck-Institut und Ver-\nbindung", "Max-Planck-Institut und Verbindung"],
]) {
  const got = joinPdfPages([input], "de");
  check(`de: '${input.replace("\n", "⏎")}' → '${want}'`, got === want, JSON.stringify(got));
}
check("number ranges keep their hyphen (every language)",
  joinPdfPages(["see pages 12-\n15 of the book"]) === "see pages 12-15 of the book");

console.log("round 3: religious context — no false alarms");
const church = "ومرّ في طريقه أمام الكنيسة القديمة عند أول الشارع، وسمع أجراسها. ";
check("long novel + 3 church mentions → general",
  religiousContext(novel.repeat(500) + church + novel.repeat(500) + church + novel.repeat(500) + church) === "general");
const sec = (s, n = 5) => novel.repeat(40) + Array(n).fill(s + " " + novel.repeat(40)).join("");
for (const [name, s] of [
  ["father-and-son parenting book", "تقوم العلاقة بين الأب والابن على الحوار."],
  ["father-and-daughter", "وتختلف العلاقة بين الأب والابنة."],
  ["new/old regime history", "وبدأ العهد الجديد في تصفية رجال العهد القديم."],
  ["new crown prince", "وزار ولي العهد الجديد العاصمة."],
  ["Egyptian high priest", "وكان الكاهن الأكبر لآمون ذا نفوذ."],
  ["ceilings (الأسقف)", "ويجب أن يكون ارتفاع الأسقف مناسبًا."],
]) check(`${name} → general`, religiousContext(sec(s)) === "general", religiousContext(sec(s)));
check("'we talked' (تحدثنا) is not an isnad",
  religiousContext((novel.repeat(20) + "ثم تحدثنا عن أيام الدراسة. ").repeat(75)) === "general");
check("a greeting (رددت عليه السلام) is not an honorific",
  religiousContext((novel.repeat(20) + "فرددت عليه السلام وجلس. ").repeat(75)) === "general");
check("vowelled isnad still islamic",
  religiousContext("حَدَّثَنَا سُفْيَانُ قَالَ حَدَّثَنَا يَحْيَى بْنُ سَعِيدٍ. وحدثنا قتيبة قال أخبرنا مالك. ".repeat(10)) === "islamic");
check("hamza-typed Trinity formula still counts",
  religiousContext("قال يسوع ذلك، وصلّت الكنيسة باسم الأب والابن والروح القدس. ".repeat(3)) === "christian");
const polemic = "ويقول النصارى إن يسوع هو الله المتجسد، وإن الأقانيم ثلاثة: الآب والابن والروح القدس. أين قال المسيح عليه السلام ذلك؟ " +
  "إن نصوص العهد الجديد تشهد بأن يسوع كان يصلي لله. وقد قال تعالى: ﴿لقد كفر الذين قالوا إن الله هو المسيح ابن مريم﴾. " +
  "واعترف علماء الكتاب المقدس بأن الكنيسة قررت ذلك في نيقية، ثم أضاف مجمع القسطنطينية ألوهية الروح القدس، ولم يكن القديس بولس من تلاميذه. ";
check("Muslim polemic on Christianity → islamic", religiousContext(polemic.repeat(100)) === "islamic", religiousContext(polemic.repeat(100)));
const fathers = "حدثنا أحد الشيوخ أن القديس أنطونيوس كان يصلي في البرية، وأخبرنا تلميذه أنه كان يقول: يا ربي يسوع المسيح ارحمني. " +
  "وكان ينزل إلى الكنيسة يوم الأحد ثم يعود إلى قلايته صامتًا. ";
check("Christian sayings with حدثنا/أخبرنا → christian", religiousContext(fathers.repeat(50)) === "christian", religiousContext(fathers.repeat(50)));
check("earlier fixtures unchanged", religiousContext(sira.repeat(20)) === "islamic" &&
  religiousContext(gospel.repeat(10)) === "christian" && religiousContext(novel.repeat(30)) === "general");
check("Christian books keep saints' church names (de/uk)",
  P("ar-uk", "christian").includes("Мойсей Мурин") && P("ar-de", "christian").includes("Moses der Äthiopier") &&
  !P("ar-uk", "islamic").includes("Мойсей Мурин") && !P("ar-de", "general").includes("Moses der Äthiopier"));

// ------------------------------------------------------------- layout / wrap
console.log("layout");
check("Latin tokens unchanged", JSON.stringify(wrapTokens("one  two three").map((t) => t.t)) === '["one","two","three"]');
const zhTok = wrapTokens("他说：“你好。”我们走吧！");
check("CJK: breakable between characters", zhTok.length > 5);
check("kinsoku: no token starts with closing punctuation",
  zhTok.every((t) => !/^[，。、；：！？）》」』”’]/.test(t.t)), JSON.stringify(zhTok.map((t) => t.t)));
check("kinsoku: no token ends with opening punctuation", zhTok.every((t) => !/[（《「『“‘]$/.test(t.t)));
check("CJK tokens carry no spaces", zhTok.every((t) => !t.sp));
check("RTL doc: Arabic paragraph is RTL", paragraphIsRtl("مرحبا Baker Street", true));
check("RTL doc: Latin paragraph is LTR", !paragraphIsRtl("Chapter 1", true));
check("LTR doc: mixed paragraph is LTR", !paragraphIsRtl("The word صبر means patience.", false));
check("LTR doc: all-Arabic paragraph is RTL", paragraphIsRtl("لم يُترجَم هذا المقطع.", false));
// wrap with a fixed-width measure: CJK paragraph wraps without spaces
const layout = makeArabicLayout({ reshape: (s) => s, bidi: null, measure: (s) => [...s].length });
const lines = layout.wrap("学者们提着灯笼穿过长长的走廊，看见了月光。", 6);
check("CJK wrap: lines fit", lines.every((l) => [...l].length <= 7), JSON.stringify(lines));
check("CJK wrap: nothing lost", lines.join("") === "学者们提着灯笼穿过长长的走廊，看见了月光。");
check("CJK wrap: no line starts with ，or 。", lines.every((l) => !/^[，。]/.test(l)));

// ------------------------------------------------------------- pdf page join
console.log("pdf page joining");
check("Chinese line breaks merge without spaces",
  joinPdfPages(["学者们提着灯\n笼穿过走廊。"], "zh") === "学者们提着灯笼穿过走廊。");
check("Chinese page ending in 。 starts a new paragraph",
  joinPdfPages(["第一页结束。", "第二页开始"], "zh") === "第一页结束。\n\n第二页开始");
check("English behavior unchanged",
  joinPdfPages(["The end of a\nline. New page", "continues here."]) === "The end of a line. New page continues here.");
check("Arabic ؟ ends a page's paragraph", joinPdfPages(["هل رأيت؟", "نعم"], "ar") === "هل رأيت؟\n\nنعم");

// ------------------------------------------------------------- font coverage
console.log("embedded fonts");
const cov = (f) => {
  const b = readFileSync(join(ROOT, "vendor", f));
  return cmapCoverage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const amiri = cov("Amiri-Regular.ttf");
const serif = cov("NotoSerif-Regular.ttf");
const sc = cov("NotoSerifSC-Regular.ttf");
const has = (set, s) => [...s].every((ch) => set.has(ch.codePointAt(0)));
check("Amiri: Arabic + presentation forms", has(amiri, "ابتثلا") && has(amiri, "ﻻﺑ"));
check("Noto Serif: Ukrainian letters", has(serif, "ЄєІіЇїҐґ"));
check("Noto Serif: German letters", has(serif, "äöüßÄÖÜ„“"));
check("Noto Serif SC: common hanzi + punctuation", has(sc, "的一是在不了有和人这，。“”《》"));
check("Noto Serif SC: 2013 standard characters beyond GB2312 (啰嗦, 瞭望)", has(sc, "啰嗦瞭"));
check("Noto Serif SC: symbols other fonts lack (≥ → ① ★)", has(sc, "≥→①★"));
check("Noto Serif SC subset size sane", sc.size > 8500 && sc.size < 9500, String(sc.size));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
