/**
 * Heuristic MCQ extractor — supports many common exam formats.
 */

function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // join hyphenated line breaks: "mito-\nchondria" -> "mitochondria"
    .replace(/(\w)-\n(\w)/g, '$1$2');
}

function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;

  // Match: 1.  1)  1]  Q1.  Question 1.  Q.1  (1)
  const startRe = /^\s*(?:Q(?:uestion)?\s*[.\s]*)?(\d{1,3})[.)\]]\s+(.*)$/i;
  const startRe2 = /^\s*\((\d{1,3})\)\s+(.*)$/;

  for (const line of lines) {
    let m = line.match(startRe);
    if (!m) m = line.match(startRe2);
    if (m) {
      if (current) blocks.push(current);
      current = { num: parseInt(m[1], 10), lines: [m[2] || ''] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseOptionsFromLines(bodyLines) {
  const options = {};
  const textLines = [];
  let inOptions = false;
  const optRe = /^\s*[\(\[]?([A-Ea-e])[\)\].:\-]\s*(.+)$/;

  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) continue;

    const om = line.match(optRe);
    if (om) {
      inOptions = true;
      options[om[1].toUpperCase()] = om[2].trim();
      continue;
    }

    // Inline: (a) x (b) y (c) z (d) w   or  a) x b) y
    const inlineHits = line.match(/[\(\[]?[A-Ea-e][\)\].:\-]/g);
    if (inlineHits && inlineHits.length >= 2) {
      inOptions = true;
      const re = /[\(\[]?([A-Ea-e])[\)\].:\-]\s*/g;
      const indices = [];
      let match;
      while ((match = re.exec(line)) !== null) {
        indices.push({ key: match[1].toUpperCase(), end: match.index + match[0].length, start: match.index });
      }
      for (let i = 0; i < indices.length; i++) {
        const start = indices[i].end;
        const end = i + 1 < indices.length ? indices[i + 1].start : line.length;
        const val = line.slice(start, end).trim();
        if (val) options[indices[i].key] = val;
      }
      continue;
    }

    if (!inOptions) textLines.push(line);
    else if (Object.keys(options).length) {
      const keys = Object.keys(options).sort();
      const last = keys[keys.length - 1];
      options[last] = `${options[last]} ${line}`.trim();
    }
  }

  return { text: textLines.join(' ').replace(/\s+/g, ' ').trim(), options };
}

function parseQuestions(rawText) {
  const text = normalize(rawText);
  const blocks = splitBlocks(text);
  const questions = [];

  for (const b of blocks) {
    const { text: qText, options } = parseOptionsFromLines(b.lines);
    if (!qText || qText.length < 3) continue;
    if (!options.A || !options.B) continue; // need at least A and B
    questions.push({
      questionNumber: b.num,
      text: qText,
      optionA: options.A || '',
      optionB: options.B || '',
      optionC: options.C || null,
      optionD: options.D || null,
      optionE: options.E || null,
      correctAnswer: null,
    });
  }

  // Fallback: if almost nothing found, try splitting on "n." more aggressively across whole text
  if (questions.length === 0 && text.length > 50) {
    const loose = text.split(/(?=(?:^|\n)\s*\d{1,3}[.)]\s+)/);
    for (const chunk of loose) {
      const hm = chunk.match(/^\s*(\d{1,3})[.)]\s+([\s\S]+)/);
      if (!hm) continue;
      const num = parseInt(hm[1], 10);
      const body = hm[2].split('\n');
      const { text: qText, options } = parseOptionsFromLines(body);
      if (qText && options.A && options.B) {
        questions.push({
          questionNumber: num,
          text: qText,
          optionA: options.A,
          optionB: options.B,
          optionC: options.C || null,
          optionD: options.D || null,
          optionE: options.E || null,
          correctAnswer: null,
        });
      }
    }
  }

  return questions;
}

function parseAnswerKey(rawText) {
  const text = normalize(rawText);
  const map = {};
  const re = /(?:^|\n)\s*(?:Ans(?:wer)?s?\s*[:=]?\s*)?(\d{1,3})\s*[-.):\s]+\s*([A-Ea-e])\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    map[parseInt(m[1], 10)] = m[2].toUpperCase();
  }
  const re2 = /(?:^|\n)\s*(\d{1,3})[.)\]]\s*[\(\[]?([A-Ea-e])[\)\]]?/gi;
  while ((m = re2.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!map[n]) map[n] = m[2].toUpperCase();
  }
  return map;
}

function applyAnswerKey(questions, keyMap) {
  return questions.map((q) => ({
    ...q,
    correctAnswer: (q.questionNumber && keyMap[q.questionNumber]) || q.correctAnswer || null,
  }));
}

module.exports = { parseQuestions, parseAnswerKey, applyAnswerKey, normalize };
