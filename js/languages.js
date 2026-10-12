/* Languages and translation directions.
 *
 * Everything that differs by language lives here: the translation, review and
 * OCR prompts, passage sizes, the "could not translate" marker, legacy text
 * encodings, and the rough numbers behind the cost estimate.
 */

export const LANGUAGES = {
  en: {
    name: "English",
    targetName: "English",
    rtl: false,
    docLang: "en-US",
    chunkLimit: 10000,   // source characters per request
    charsPerPage: 2000,  // for the "~N pages" log line
    tokenWeight: 1.0,    // tokens for the same content, relative to English
    legacyEncoding: "windows-1252",
    style: "clear, fluent, natural literary English",
    names:
      "Render proper names (people, places) in one consistent Latin-script form. Use the established English " +
      "form where one exists: e.g. Muhammad, Mecca, Medina, Cairo, Baghdad, Damascus; Abraham, Moses, Jesus, " +
      "Mary, Joseph, Gabriel for figures shared with the Bible; and the established spellings of modern public " +
      "figures (e.g. Gamal Abdel Nasser, Naguib Mahfouz). Otherwise transliterate by this one scheme, without " +
      "diacritics or ʿayn/hamza marks: the article as lowercase hyphenated al- with no sun-letter assimilation " +
      "(al-Ghazali, Nur al-Din, Abd al-Rahman — never el-, ad-, ar-, Al- or Abdul), capitalized only at the " +
      "start of a sentence; ibn and bint (never bin) lowercase inside a name (Ahmad ibn Hanbal) but Ibn at its " +
      "start (Ibn Khaldun); Abu and Umm capitalized (Abu Bakr, Umm Kulthum); final ta marbuta as -a (Fatima, " +
      "Aisha). Keep every name identical throughout the book.",
    punctuation: "standard English punctuation, with “…” quotation marks for dialogue",
    extraRules: [],
    religionRules(religion) {
      const god = religion === "islamic" ? "Allah" : "God";
      return [
        religion === "islamic"
          ? "This book is an Islamic religious work: render الله as \"Allah\" everywhere, including oaths and " +
            "everyday formulas (والله → by Allah, إن شاء الله → if Allah wills, الحمد لله → praise be to Allah). " +
            "Never use \"God\" for الله."
          : "Render الله as \"God\" everywhere in this book, including oaths, prayers, scripture quotations and " +
            "everyday formulas (والله → by God, إن شاء الله → God willing, الحمد لله → praise be to God); use " +
            "\"Allah\" only where the source itself is talking about the Arabic word." +
            (religion === "christian"
              ? " This is a Christian book: use the established English Christian terms (الرب → the Lord, يسوع " +
                "المسيح → Jesus Christ, الروح القدس → the Holy Spirit, الإنجيل → the Gospel)."
              : ""),
        "Render religious formulas with these fixed English forms, in parentheses directly after the name: " +
          "صلى الله عليه وسلم / ﷺ → (peace be upon him); عليه السلام → (peace be upon him); عليها السلام → (peace " +
          `be upon her); رضي الله عنه / عنها / عنهم → (may ${god} be pleased with him / her / them); رحمه الله / ` +
          `رحمها الله → (may ${god} have mercy on him / her); سبحانه وتعالى → (glorified and exalted is He); ` +
          "عز وجل → (mighty and majestic is He); جل جلاله → (exalted is His majesty). Never use abbreviations " +
          "such as pbuh or the ﷺ glyph, and never add a formula the source does not have.",
      ];
    },
    marker: "[This passage could not be translated automatically — the original text follows]",
    markerSearch: "could not be translated automatically",
  },
  ar: {
    name: "Arabic",
    targetName: "Arabic",
    rtl: true,
    docLang: "ar-SA",
    chunkLimit: 8000,
    charsPerPage: 1700,
    tokenWeight: 1.6,
    legacyEncoding: "windows-1256",
    style: "clear, elegant Modern Standard Arabic (الفصحى)",
    names:
      "Transliterate proper names (people, places) into Arabic script, using the established Arabic form " +
      "where one exists (e.g. لندن، كييف، بكين، برلين). Keep every name identical throughout the book.",
    punctuation: "Arabic punctuation (، ؛ ؟) and Arabic-appropriate quotation marks («…» or “…”)",
    extraRules: [
      "When the source quotes a verse of the Qur'an in translation, give the verse in its original Arabic " +
        "wording exactly as in the Muṣḥaf, between ornate brackets ﴿…﴾, keeping any surah/verse reference the " +
        "source gives, but only if you can identify the verse and recall its exact wording with certainty. If you " +
        "cannot, translate the quotation's meaning and present it as a translation of the meaning (e.g. «ما معناه: " +
        "…»), never inside ﴿…﴾ and never as the Qur'anic text itself. Likewise, use the original Arabic wording of " +
        "a hadith, a line of Arabic poetry or another quotation from an Arabic source only when you can identify it " +
        "and recall it exactly; otherwise translate its meaning. Exception: when the source is discussing the " +
        "wording of a particular translation of such a text, translate that translation's wording as given.",
    ],
    marker: "[لم يُترجَم هذا المقطع تلقائيًا — النص الأصلي أدناه]",
    markerSearch: "لم يُترجَم",
  },
  uk: {
    name: "Ukrainian",
    targetName: "Ukrainian",
    rtl: false,
    docLang: "uk-UA",
    chunkLimit: 10000,
    charsPerPage: 2000,
    tokenWeight: 1.6,
    legacyEncoding: "windows-1251",
    style: "clear, literary modern standard Ukrainian (сучасна українська літературна мова)",
    names:
      "Render proper names in Ukrainian Cyrillic, using the established Ukrainian form where one exists " +
      "(e.g. Каїр, Мекка, Багдад, Мухаммад) and otherwise transliterating by pronunciation. Keep every " +
      "name identical throughout the book.",
    punctuation:
      "Ukrainian typographic conventions: «…» quotation marks („…“ for a quotation inside a quotation), " +
      "and a dash (—) to introduce lines of dialogue",
    extraRules: [
      "Use correct Ukrainian vocabulary, grammar and current orthography — never Russian words, " +
        "Russian forms or Russian calques.",
    ],
    religionRules(religion) {
      const god = religion === "christian" ? "Бог" : "Аллах";
      return [
        religion === "christian"
          ? "This is a Christian book: render الله as «Бог» everywhere (والله → Богом клянуся, إن شاء الله → " +
            "якщо Бог дасть, الحمد لله → слава Богу) and use the established Ukrainian Christian terms (الرب → " +
            "Господь, يسوع المسيح → Ісус Христос, الروح القدس → Святий Дух, الإنجيل → Євангеліє)."
          : "Render الله as «Аллах» everywhere, including oaths and everyday formulas (والله → клянуся " +
            "Аллахом, إن شاء الله → якщо на те буде воля Аллаха, الحمد لله → хвала Аллаху). Never use «Бог» " +
            "for الله.",
        "Prophets and other figures shared with the Bible keep their Ukrainian Bible names throughout (Адам, " +
          "Ной, Авраам, Мойсей, Йосип, Марія, Ісус, Гавриїл); " +
          (religion === "christian"
            ? "saints, church fathers and other figures of church history keep the established Ukrainian church " +
              "form of their name (e.g. Мойсей Мурин, Марія Єгипетська, Іоан Дамаскин); other people of later " +
              "times who merely bear these names are transliterated as usual (Ібрагім, Муса, Юсуф)."
            : "people of later times who merely bear these names are transliterated as usual (Ібрагім, Муса, Юсуф)."),
        "Render religious formulas with these fixed Ukrainian forms, in parentheses directly after the name: " +
          `صلى الله عليه وسلم / ﷺ → (хай благословить його ${god} і вітає); عليه السلام → (мир йому); ` +
          `عليها السلام → (мир їй); رضي الله عنه / عنها / عنهم → (хай буде задоволений ним / нею / ними ${god}); ` +
          `رحمه الله / رحمها الله → (хай помилує його / її ${god}); سبحانه وتعالى → (преславний і всевишній); ` +
          "عز وجل → (великий і славний); جل جلاله → (велична Його велич). Never use abbreviations or the ﷺ " +
          "glyph, and never add a formula the source does not have.",
      ];
    },
    marker: "[Цей фрагмент не вдалося перекласти автоматично — нижче наведено оригінальний текст]",
    markerSearch: "не вдалося перекласти автоматично",
  },
  zh: {
    name: "Chinese",
    targetName: "Mandarin Chinese written in Simplified characters",
    rtl: false,
    docLang: "zh-CN",
    chunkLimit: 3000,    // Chinese is dense: 3000 characters ≈ a 10 000-character English passage
    charsPerPage: 800,
    tokenWeight: 1.4,
    legacyEncoding: "gb18030",
    style: "fluent, natural, literary Modern Standard Chinese (Mandarin) in Simplified characters (简体中文)",
    names:
      "Use the established Chinese rendering of proper names where one exists (e.g. 穆罕默德、开罗、麦加、" +
      "巴格达); otherwise transliterate by pronunciation using standard Chinese transliteration conventions. " +
      "Keep every name identical throughout the book.",
    punctuation:
      "full-width Chinese punctuation (，。、；：？！“”‘’《》) and no spaces between Chinese characters",
    extraRules: [
      "Write in Simplified characters only — never Traditional characters.",
    ],
    religionRules(religion) {
      return [
        religion === "christian"
          ? "This is a Christian book: use standard Chinese Christian terms, identically throughout the book: " +
            "الله (as the name of God) = 上帝 (never 神 or 天主 for God; 神 only for a generic god, إله), الرب = 主, " +
            "يسوع المسيح = 耶稣基督, الروح القدس = 圣灵, الإنجيل = 福音, and the names of the Chinese Union Version " +
            "Bible: آدم 亚当, نوح 挪亚, إبراهيم 亚伯拉罕, موسى 摩西, يوسف 约瑟, مريم 马利亚, جبرائيل 加百列."
          : "Follow established Chinese Muslim usage, identically throughout the book: الله = 真主 (not 安拉, 阿拉 " +
            "or 上帝); the Qur'an = 《古兰经》 (never 可兰经), with references written as 《古兰经》第2章第255节; " +
            "Hadith = 圣训; Hijri dates = 伊斯兰历N年. Prophets keep their Qur'anic Chinese names (as in 马坚's " +
            "translation), not the Biblical ones: آدم 阿丹, نوح 努哈, إبراهيم 易卜拉欣, موسى 穆萨, عيسى 尔撒, " +
            "مريم 麦尔彦, يوسف 优素福 (not 亚当, 挪亚, 亚伯拉罕, 摩西, 耶稣, 玛利亚, 约瑟).",
        "Wherever the source has one of these honorifics, render it as the standard Chinese formula in full-width " +
          "parentheses right after the name, always worded the same way: ﷺ / صلى الله عليه وسلم = （愿主福安之）; " +
          "رضي الله عنه/عنها/عنهم = （愿主喜悦之）; رحمه الله = （愿主慈悯之）; عليه السلام = （愿主赐其平安）; " +
          "سبحانه وتعالى = （赞美他超绝万物）. Never add a formula the source does not have.",
      ];
    },
    marker: "【此段未能自动翻译——以下为原文】",
    markerSearch: "此段未能自动翻译",
  },
  de: {
    name: "German",
    targetName: "German",
    rtl: false,
    docLang: "de-DE",
    chunkLimit: 10000,
    charsPerPage: 2200,
    tokenWeight: 1.3,
    legacyEncoding: "windows-1252",
    style: "clear, idiomatic literary German (Standard High German, current orthography)",
    names:
      "Use the established German form of proper names where one exists (e.g. Kairo, Mekka, Medina, Bagdad, " +
      "Damaskus, Ägypten, Mohammed, Chadidscha, Nagib Machfus), and keep the established Latin spelling of real " +
      "people known under one. Otherwise transliterate Arabic names by German spelling conventions, never " +
      "English ones, without diacritics: sch for ش, ch for خ, dsch for ج (but g in Egyptian names, e.g. Gamal), " +
      "j for consonantal ي, w for و, and the article as al- (e.g. Scheich, Chalid, Dschafar, Jusuf, Walid, Umar " +
      "ibn al-Chattab). Keep every name identical throughout the book.",
    punctuation:
      "German book typography: „…“ quotation marks, with ‚…‘ for a quotation inside a quotation (never English " +
      "“…” or the source's «…»), and the spaced en dash ( – ) as the dash, never an em dash (—)",
    extraRules: [
      "Arabic has no formal/informal distinction, so choose German address from the setting, as a German author " +
        "would — never use Sie merely because the Arabic is respectful or elevated. In modern settings use Sie " +
        "between adults who are not close (strangers, officials, superiors) and du among family, friends, " +
        "children and intimates; keep each pair of characters' choice consistent unless their relationship " +
        "changes in the story. God is always addressed with du (capitalised Du, Dir, Dein in prayers and " +
        "invocations). In Qur'an and Hadith quotations and in the Sira, use du throughout, including towards the " +
        "Prophet and towards kings. In classical or pre-modern narratives (e.g. the Thousand and One Nights, " +
        "chronicles, courtly tales) use du, or Ihr/Euch when a subject addresses a ruler or nobleman — never " +
        "Sie, which is anachronistic there.",
      "Write numbers in German style: Western digits (never Arabic-Indic ٠١٢٣), a decimal comma, and dates such " +
        "as „12. März 1950“; give years the source marks as Hijri (هـ) as „1400 n. H.“.",
    ],
    religionRules(religion) {
      const god = religion === "islamic" ? "Allah" : "Gott";
      return [
        religion === "islamic"
          ? "This book is an Islamic religious work: render الله as „Allah“ everywhere, including oaths and " +
            "everyday formulas (والله → bei Allah, إن شاء الله → so Allah will, الحمد لله → alles Lob gebührt " +
            "Allah). Never use „Gott“ for الله."
          : "Render الله as „Gott“ everywhere in this book, including oaths, prayers, scripture quotations and " +
            "everyday formulas (والله → bei Gott, إن شاء الله → so Gott will, الحمد لله → Gott sei Dank); use " +
            "„Allah“ only where the source itself is talking about the Arabic word." +
            (religion === "christian"
              ? " This is a Christian book: use the established German Christian terms (الرب → der Herr, يسوع " +
                "المسيح → Jesus Christus, الروح القدس → der Heilige Geist, الإنجيل → das Evangelium)."
              : ""),
        "Prophets and other figures shared with the Bible keep their German Bible names throughout (Adam, Noah, " +
          "Abraham, Mose, Josef, Maria, Jesus, Gabriel); " +
          (religion === "christian"
            ? "saints, church fathers and other figures of church history keep the established German form of " +
              "their name (e.g. Moses der Äthiopier, Maria von Ägypten, Johannes von Damaskus); other people of " +
              "later times who merely bear these names are transliterated as usual (Ibrahim, Musa, Jusuf)."
            : "people of later times who merely bear these names are transliterated as usual (Ibrahim, Musa, Jusuf)."),
        "Render religious formulas with these fixed German forms, in parentheses directly after the name: " +
          `صلى الله عليه وسلم / ﷺ → (${god} segne ihn und schenke ihm Heil); عليه السلام → (Friede sei mit ihm); ` +
          `عليها السلام → (Friede sei mit ihr); رضي الله عنه / عنها / عنهم → (${god} habe Wohlgefallen an ihm / ` +
          `ihr / ihnen); رحمه الله / رحمها الله → (${god} erbarme sich seiner / ihrer); سبحانه وتعالى → ` +
          "(gepriesen und erhaben ist Er); عز وجل → (mächtig und erhaben ist Er); جل جلاله → (erhaben ist Seine " +
          "Majestät). Never use abbreviations such as (s.), (s.a.s.) or (a.s.), or the ﷺ glyph, and never add a " +
          "formula the source does not have.",
      ];
    },
    marker: "[Dieser Abschnitt konnte nicht automatisch übersetzt werden – es folgt der Originaltext]",
    markerSearch: "nicht automatisch übersetzt",
  },
};

/** What the translator must know about the SOURCE language. */
const SOURCE_NOTES = {
  en: [],
  ar: [
    "The source is Arabic and may be fully, partly, or not vowelled — read carefully and resolve " +
      "ambiguities from context.",
    "Quotations from the Qur'an or the Hadith: translate their meaning faithfully and precisely, keep any " +
      "reference the source gives (surah and verse, hadith collection), and add no commentary.",
    "Religious formulas and honorifics (such as ﷺ, صلى الله عليه وسلم, رضي الله عنه, رحمه الله, " +
      "سبحانه وتعالى) are never dropped — render them in the fixed forms given above.",
    "Classical, poetic, or rhymed prose: convey the meaning first, keeping as much of the register and " +
      "rhythm as the target language naturally allows.",
  ],
  uk: [
    "The source is Ukrainian. Render Ukrainian personal and place names by their Ukrainian pronunciation, " +
      "not by Russian forms (Київ is Kyiv, not Kiev; Харків is Kharkiv, not Kharkov).",
  ],
  zh: [
    "The source is Chinese (in Simplified or Traditional characters). Render Chinese personal and place " +
      "names by their Mandarin pronunciation.",
    "Chengyu (four-character idioms) and classical allusions: convey their meaning naturally rather than " +
      "word-for-word.",
  ],
  de: [],
};

/** Translation directions offered in the app, in menu order. */
export const PAIRS = ["en-ar", "ar-en", "ar-uk", "uk-ar", "ar-zh", "zh-ar", "ar-de", "de-ar"];
export const DEFAULT_PAIR = "en-ar";

const MENU_NAME = {
  en: "English", ar: "Arabic", uk: "Ukrainian", zh: "Chinese (Mandarin)", de: "German",
};

export function parsePair(pair) {
  const [src, tgt] = String(pair).split("-");
  if (!PAIRS.includes(pair) || !LANGUAGES[src] || !LANGUAGES[tgt]) {
    throw new Error(`Unsupported language pair: ${pair}`);
  }
  return { src, tgt, source: LANGUAGES[src], target: LANGUAGES[tgt] };
}

export function pairLabel(pair) {
  const { src, tgt } = parsePair(pair);
  return `${MENU_NAME[src]} → ${MENU_NAME[tgt]}`;
}

// --------------------------------------------------------------------- prompts

function bullets(lines) {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Rules for الله, honorifics and prophets' names — Arabic sources only, fixed
 * for the whole book by its religious context ("islamic", "christian",
 * "general"; see detect.js religiousContext). */
function religionRules(src, target, religion) {
  return src === "ar" && target.religionRules ? target.religionRules(religion || "general") : [];
}

/** System prompt for the translation pass. `religion`: the book's religious
 * context (Arabic sources). */
export function translationPrompt(pair, { religion = null } = {}) {
  const { src, source, target } = parsePair(pair);
  const T = target.targetName;
  return `You are an expert literary translator translating ${article(source.name)} ${source.name} book into ${T}.

Rules:
${bullets([
  `Translate into ${target.style}.`,
  "Preserve the author's tone, register, imagery, and literary devices. Translate meaning, not word-for-word.",
  target.names,
  "Keep chapter titles and headings as headings, translated.",
  `Preserve paragraph breaks exactly: each source paragraph becomes one ${target.name} paragraph.`,
  `Dialogue keeps its quotation structure, using ${target.punctuation}.`,
  `Write everything in ${target.name} — do not leave words untranslated or in the original script, ` +
    "except words that the source itself quotes from another language.",
  ...target.extraRules,
  ...religionRules(src, target, religion),
  ...SOURCE_NOTES[src],
  "Do NOT summarize, omit, or add anything. Do NOT add translator notes or commentary.",
  `Output ONLY the ${target.name} translation of the text you are given — no preamble, no explanations.`,
])}
`;
}

/** System prompt for the second (review) pass — same rules as the translation. */
export function reviewPrompt(pair, { religion = null } = {}) {
  const { src, source, target } = parsePair(pair);
  return `You are a meticulous bilingual editor reviewing ${article(target.name)} ${target.name} translation of ${article(source.name)} ${source.name} book passage.

Compare the draft translation against the ${source.name} source, sentence by sentence, and produce a corrected final version. Fix:
${bullets([
  "any omitted, added, or mistranslated content — every sentence of the source must be fully represented;",
  "misread idioms, false friends, and errors of meaning;",
  "inconsistent rendering of names;",
  `awkward or unnatural ${target.name} phrasing (the result must read as ${target.style});`,
  `punctuation that does not follow ${target.punctuation};`,
  ...[...target.extraRules, ...religionRules(src, target, religion)].map((r) => `violations of this rule: ${r}`),
  "broken paragraph structure — the paragraph breaks must match the source exactly.",
])}

If the draft is already correct, keep it. Output ONLY the final corrected ${target.name} translation — no notes, no explanations, no preamble.
`;
}

/** Labels used in the review request body. */
export function reviewLabels(pair) {
  const { source, target } = parsePair(pair);
  return {
    source: `${source.name.toUpperCase()} SOURCE`,
    draft: `DRAFT ${target.name.toUpperCase()} TRANSLATION`,
  };
}

/** System prompt for Claude vision OCR of a scanned page in the source language. */
export function ocrPrompt(src) {
  const lang = LANGUAGES[src];
  const extra = {
    ar: ["Keep the Arabic text in its normal reading order. Reproduce vowel marks (tashkeel) only where they are printed."],
    zh: ["Do not insert spaces between Chinese characters. Keep each character exactly as printed (Simplified or Traditional)."],
  }[src] || [];
  return `You transcribe scanned book pages exactly. The book is written in ${lang.name}.

${bullets([
  "Output the complete text of the page precisely as printed — do not translate, summarize, correct, or modernize it.",
  "Preserve paragraph breaks: put a blank line between paragraphs. Join words that are hyphen-split across lines.",
  ...extra,
  "Skip page headers, footers, and bare page numbers.",
  "If the page contains no text at all, output exactly [BLANK].",
  "Output ONLY the transcription — no commentary, no preamble.",
])}
`;
}

/** Rough ratio of output tokens to input tokens, for the cost estimate. */
export function outputTokenRatio(pair) {
  if (pair === "en-ar") return 1.4; // calibrated on real runs
  const { source, target } = parsePair(pair);
  return target.tokenWeight / source.tokenWeight;
}

function article(languageName) {
  return /^(English|Arabic)$/.test(languageName) ? "an" : "a"; // "a Ukrainian", "a Chinese", "a German"
}
