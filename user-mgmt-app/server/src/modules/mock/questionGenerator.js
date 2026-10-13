/**
 * Chapter-based MCQ generator focused on clear stems and coherent options.
 * correctAnswer is always null (set via answer-key upload).
 */

const STOP = new Set(`
  the a an and or but if in on at to for of is are was were be been being
  this that these those it its as by with from into about than then so
  not no yes can could will would should may might must do does did
  have has had having we you they he she i me my our your their them
  also such over under between during before after above below through
  which who whom what when where why how all each every any some few
  more most other another same different very just only own too many
  much both either neither nor while using used use uses based called
  known following given chapter section figure table example note page
  thus hence therefore upon within without against among across around
  behind beside beyond finding works portion contain stored points
  follow follows sequence principle children items item list
`.trim().split(/\s+/));

function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(text) {
  return normalize(text)
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length >= 45 && s.length <= 220)
    .filter((s) => /[a-zA-Z]{4,}/.test(s))
    .filter((s) => !/^\d+[.)]/.test(s));
}

function capitalizePhrase(s) {
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => (/^[A-Z0-9+\-]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Build concept list: subjects of "X is/are ..." and multi-word technical nouns */
function extractConcepts(sentences) {
  const concepts = new Map(); // lower -> display

  const add = (raw) => {
    if (!raw) return;
    let p = raw.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    // strip leading articles and trailing helper words / fragments
    p = p.replace(/^(the|a|an)\s+/i, '');
    p = p.replace(/\s+(is|are|was|were|where|when|that|which|for|of|to|in|on|by)$/i, '');
    p = p.replace(/\s+(is|are)\s+.*$/i, ''); // "Binary search is" -> "Binary search"
    if (!p) return;
    const words = p.split(/\s+/);
    if (words.length > 4) return;
    const content = words.filter((w) => !STOP.has(w.toLowerCase()));
    if (!content.length) return;
    if (words.length === 1 && p.length < 5) return;
    if (/^(the|a|an|of|for|to|in|on|by)\b/i.test(p)) return;
    if (/\b(the|a|an|of|for|to|in|on|by|that|which|where|elements|items)$/i.test(p)) return;
    // require at least one "substantial" word
    if (!content.some((w) => w.length >= 4)) return;
    const key = p.toLowerCase();
    if (!concepts.has(key)) concepts.set(key, capitalizePhrase(p));
  };

  for (const s of sentences) {
    // "Binary search is an efficient algorithm..."
    let m;
    const reIs = /\b([A-Za-z][A-Za-z0-9+\-]*(?:\s+[A-Za-z][A-Za-z0-9+\-]*){0,3})\s+(is|are|refers to|means)\b/gi;
    while ((m = reIs.exec(s)) !== null) {
      add(m[1]);
    }
    // "time complexity of binary search"
    const reOf = /\b([A-Za-z][A-Za-z0-9+\-]*(?:\s+[A-Za-z][A-Za-z0-9+\-]*){0,2})\s+of\s+([A-Za-z][A-Za-z0-9+\-]*(?:\s+[A-Za-z][A-Za-z0-9+\-]*){0,2})\b/gi;
    while ((m = reOf.exec(s)) !== null) {
      add(`${m[1]} of ${m[2]}`);
      add(m[2]);
    }
    // standalone technical tokens
    const tech = s.match(/\b(?:O\([^)]+\)|binary search|linked list|binary tree|data structure|time complexity|space complexity|hash table|operating system|machine learning|neural network|depth[- ]first|breadth[- ]first)\b/gi);
    if (tech) tech.forEach(add);
  }

  return [...concepts.entries()].map(([k, display]) => ({ key: k, display }));
}

function findConceptInSentence(sentence, conceptKey) {
  const re = new RegExp(`\\b${conceptKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const m = sentence.match(re);
  if (!m) return null;
  return { index: m.index, length: m[0].length, matched: m[0] };
}

function makeCloze(sentence, index, length) {
  const before = sentence.slice(0, index).trim();
  const after = sentence.slice(index + length).trim();
  if (before.length < 3) return null; // avoid blank at start
  const stemBody = `${before} ______ ${after}`.replace(/\s+/g, ' ').trim();
  const withEnd = /[.!?]$/.test(stemBody) ? stemBody : `${stemBody}.`;
  return `Based on the chapter, complete the statement:\n"${withEnd}"`;
}

function pickDistractors(correctDisplay, concepts, n = 3) {
  const c = correctDisplay.toLowerCase();
  const others = concepts
    .map((x) => x.display)
    .filter((t) => t.toLowerCase() !== c)
    .filter((t) => Math.abs(t.length - correctDisplay.length) <= 25);
  const shuffled = others.sort(() => Math.random() - 0.5);
  const out = [];
  const seen = new Set([c]);
  for (const t of shuffled) {
    if (out.length >= n) break;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  const fillers = ['None of the above', 'All of the above', 'Not mentioned in the chapter'];
  let i = 0;
  while (out.length < n) {
    out.push(fillers[i % fillers.length]);
    i += 1;
  }
  return out.slice(0, n);
}

function shuffleOptions(correct, distractors) {
  const opts = [correct, ...distractors].slice(0, 4);
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  const letters = ['A', 'B', 'C', 'D'];
  const mapped = {};
  let correctLetter = 'A';
  opts.forEach((o, i) => {
    mapped[`option${letters[i]}`] = o;
    if (o === correct) correctLetter = letters[i];
  });
  return { ...mapped, correctLetter };
}

function generateMcqsFromText(rawText, maxQ = 15) {
  const text = normalize(rawText);
  if (text.length < 120) return [];

  const sentences = splitSentences(text);
  if (sentences.length < 2) return [];

  const concepts = extractConcepts(sentences);
  if (concepts.length < 3) return [];

  const used = new Set();
  const questions = [];
  let num = 1;

  // Pass 1: cloze on concept inside a full sentence (not at start)
  for (const sent of sentences) {
    if (questions.length >= maxQ) break;
    // Prefer longer concepts first for this sentence
    const hits = concepts
      .map((c) => ({ c, loc: findConceptInSentence(sent, c.key) }))
      .filter((x) => x.loc && x.loc.index > 0)
      .sort((a, b) => b.c.key.length - a.c.key.length);

    for (const { c, loc } of hits) {
      if (questions.length >= maxQ) break;
      if (used.has(c.key)) continue;
      const stem = makeCloze(sent, loc.index, loc.length);
      if (!stem) continue;
      if (stem.indexOf('______') < 20) continue; // still too early in the quoted line sometimes OK if before is long

      const correct = c.display;
      const distractors = pickDistractors(correct, concepts, 3);
      const opts = shuffleOptions(correct, distractors);
      const vals = [opts.optionA, opts.optionB, opts.optionC, opts.optionD];
      if (new Set(vals.map((v) => v.toLowerCase())).size < 4) continue;

      used.add(c.key);
      questions.push({
        questionNumber: num++,
        text: stem,
        optionA: opts.optionA,
        optionB: opts.optionB,
        optionC: opts.optionC,
        optionD: opts.optionD,
        optionE: null,
        correctAnswer: null,
        explanation: sent,
      });
      break;
    }
  }

  // Pass 2: "What is being defined?" when sentence starts with concept + is/are
  for (const sent of sentences) {
    if (questions.length >= maxQ) break;
    const m = sent.match(/^([A-Za-z][A-Za-z0-9+\-]*(?:\s+[A-Za-z][A-Za-z0-9+\-]*){0,3})\s+(is|are)\b/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (used.has(key)) continue;
    const concept = concepts.find((c) => c.key === key) || { key, display: capitalizePhrase(m[1]) };
    const correct = concept.display;
    const distractors = pickDistractors(correct, concepts, 3);
    const opts = shuffleOptions(correct, distractors);

    used.add(key);
    questions.push({
      questionNumber: num++,
      text: `According to the chapter, which concept is defined or described below?\n"${sent}"`,
      optionA: opts.optionA,
      optionB: opts.optionB,
      optionC: opts.optionC,
      optionD: opts.optionD,
      optionE: null,
      correctAnswer: null,
      explanation: sent,
    });
  }

  return questions;
}

module.exports = { generateMcqsFromText };
