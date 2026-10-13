const path = require('path');
const prisma = require('../../config/db');
const { extractText } = require('./extractText');
const { parseQuestions, parseAnswerKey, applyAnswerKey } = require('./mcqParser');
const { generateMcqsFromText } = require('./questionGenerator');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickWeighted(groups, total) {
  // groups: [{ items: Question[], weight: number }]
  const totalWeight = groups.reduce((s, g) => s + (g.weight || 1), 0) || 1;
  const selected = [];
  const used = new Set();

  for (const g of groups) {
    const share = Math.round((total * (g.weight || 1)) / totalWeight);
    const pool = shuffle(g.items.filter((q) => !used.has(q.id)));
    for (const q of pool.slice(0, Math.max(0, share))) {
      selected.push(q);
      used.add(q.id);
    }
  }
  // fill remaining from all
  if (selected.length < total) {
    const rest = shuffle(groups.flatMap((g) => g.items).filter((q) => !used.has(q.id)));
    for (const q of rest) {
      if (selected.length >= total) break;
      selected.push(q);
      used.add(q.id);
    }
  }
  return selected.slice(0, total);
}

// ---------- Sources ----------
exports.uploadSource = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload a PDF, DOCX or TXT file.' });
  const { title, type, year, chapter, weightage, linkedSourceId } = req.body;
  const sourceType = String(type || '').toUpperCase();
  if (!['PYQ', 'TEXTBOOK', 'ANSWER_KEY'].includes(sourceType)) {
    return res.status(400).json({ message: 'type must be PYQ, TEXTBOOK or ANSWER_KEY' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ message: 'title is required' });
  }

  const fileUrl = `/uploads/mock/${req.file.filename}`;
  let rawText = '';
  try {
    rawText = await extractText(req.file.path);
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message || 'Failed to read file' });
  }

  const source = await prisma.questionSource.create({
    data: {
      title: String(title).trim(),
      type: sourceType,
      year: year ? parseInt(year, 10) : null,
      chapter: chapter ? String(chapter).trim() : null,
      weightage: weightage != null ? parseFloat(weightage) : 1,
      fileName: req.file.originalname,
      fileUrl,
      rawText,
      uploadedBy: req.userId,
      linkedSourceId: linkedSourceId || null,
    },
  });

  let questionsCreated = 0;
  let keysApplied = 0;

  if (sourceType === 'ANSWER_KEY') {
    const keyMap = parseAnswerKey(rawText);
    if (linkedSourceId) {
      const existing = await prisma.question.findMany({ where: { sourceId: linkedSourceId } });
      for (const q of existing) {
        const ans = q.questionNumber != null ? keyMap[q.questionNumber] : null;
        if (ans) {
          await prisma.question.update({ where: { id: q.id }, data: { correctAnswer: ans } });
          keysApplied += 1;
        }
      }
    }
    return res.status(201).json({ source, questionsCreated: 0, keysApplied, keyCount: Object.keys(keyMap).length });
  }

  // PYQ: try extract existing MCQs first.
  // TEXTBOOK: generate MCQs from chapter prose (auto-create + auto-key for evaluation).
  let parsed = [];
  let mode = 'extract';

  if (sourceType === 'TEXTBOOK') {
    parsed = generateMcqsFromText(rawText, 20);
    mode = 'generated';
    // If generation weak, also try extracting any pre-written MCQs and merge
    const extracted = parseQuestions(rawText);
    if (extracted.length && parsed.length < 5) {
      const keyMap = parseAnswerKey(rawText);
      parsed = [...applyAnswerKey(extracted, keyMap), ...parsed].slice(0, 25);
      mode = 'mixed';
    }
  } else {
    parsed = parseQuestions(rawText);
    const keyMap = parseAnswerKey(rawText);
    if (Object.keys(keyMap).length) parsed = applyAnswerKey(parsed, keyMap);
    // If PYQ file is actually prose with no MCQs, generate as fallback
    if (parsed.length === 0 && rawText.length > 200) {
      parsed = generateMcqsFromText(rawText, 15);
      mode = 'generated';
    }
  }

  if (parsed.length) {
    await prisma.question.createMany({
      data: parsed.map((q) => ({
        sourceId: source.id,
        questionNumber: q.questionNumber,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
        optionE: q.optionE,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        chapter: source.chapter,
        marks: 1,
      })),
    });
    questionsCreated = parsed.length;
  }

  res.status(201).json({
    source: { ...source, rawText: undefined },
    questionsCreated,
    keysApplied,
    mode,
    message: questionsCreated
      ? (mode === 'generated'
          ? `Generated ${questionsCreated} MCQs from chapter. Upload an answer key to enable scoring; otherwise the test will only show the user's answers.`
          : `Ready: ${questionsCreated} questions.`)
      : 'Could not generate questions — chapter text too short or not extractable (scanned PDF?).',
  });
};


/** Create a TEXTBOOK/PYQ source from pasted MCQ text (no file). */
exports.pasteSource = async (req, res) => {
  const { title, type, year, chapter, weightage, text } = req.body;
  const sourceType = String(type || 'TEXTBOOK').toUpperCase();
  if (!['PYQ', 'TEXTBOOK'].includes(sourceType)) {
    return res.status(400).json({ message: 'type must be PYQ or TEXTBOOK' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ message: 'title is required' });
  }
  const rawText = String(text || '').trim();
  if (rawText.length < 20) {
    return res.status(400).json({ message: 'Paste MCQ text (at least a few questions).' });
  }

  const source = await prisma.questionSource.create({
    data: {
      title: String(title).trim(),
      type: sourceType,
      year: year ? parseInt(year, 10) : null,
      chapter: chapter ? String(chapter).trim() : null,
      weightage: weightage != null ? parseFloat(weightage) : 1,
      fileName: 'pasted.txt',
      fileUrl: null,
      rawText,
      uploadedBy: req.userId,
    },
  });

  let parsed = [];
  let mode = 'extract';
  if (sourceType === 'TEXTBOOK') {
    parsed = generateMcqsFromText(rawText, 20);
    mode = 'generated';
    if (parsed.length < 3) {
      const extracted = parseQuestions(rawText);
      if (extracted.length) {
        parsed = [...extracted, ...parsed];
        mode = 'mixed';
      }
    }
  } else {
    parsed = parseQuestions(rawText);
    const keyMap = parseAnswerKey(rawText);
    if (Object.keys(keyMap).length) parsed = applyAnswerKey(parsed, keyMap);
  }

  let questionsCreated = 0;
  if (parsed.length) {
    await prisma.question.createMany({
      data: parsed.map((q) => ({
        sourceId: source.id,
        questionNumber: q.questionNumber,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
        optionE: q.optionE,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        chapter: source.chapter,
        marks: 1,
      })),
    });
    questionsCreated = parsed.length;
  }

  res.status(201).json({
    source: { ...source, rawText: undefined },
    questionsCreated,
    mode,
    preview: rawText.slice(0, 300),
    message: questionsCreated
      ? `Created ${questionsCreated} questions (${mode}).`
      : 'Could not create questions from this text.',
  });
};

/** Re-run MCQ extraction on an existing source rawText. */
exports.reparseSource = async (req, res) => {
  const source = await prisma.questionSource.findUnique({ where: { id: req.params.id } });
  if (!source) return res.status(404).json({ message: 'Source not found' });
  if (!source.rawText || source.rawText.length < 10) {
    return res.status(400).json({
      message: 'No extractable text stored for this file. It may be a scanned image PDF. Use a text PDF, DOCX, TXT, or Paste MCQs.',
      textLength: source.rawText ? source.rawText.length : 0,
    });
  }

  await prisma.question.deleteMany({ where: { sourceId: source.id } });
  let parsed = [];
  if (source.type === 'TEXTBOOK') {
    parsed = generateMcqsFromText(source.rawText, 20);
  } else {
    parsed = parseQuestions(source.rawText);
    const keyMap = parseAnswerKey(source.rawText);
    if (Object.keys(keyMap).length) parsed = applyAnswerKey(parsed, keyMap);
    if (parsed.length === 0) parsed = generateMcqsFromText(source.rawText, 15);
  }

  if (parsed.length) {
    await prisma.question.createMany({
      data: parsed.map((q) => ({
        sourceId: source.id,
        questionNumber: q.questionNumber,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
        optionE: q.optionE,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        chapter: source.chapter,
        marks: 1,
      })),
    });
  }

  res.json({
    questionsCreated: parsed.length,
    textLength: source.rawText.length,
    textPreview: source.rawText.slice(0, 400),
    message: parsed.length
      ? `Generated/extracted ${parsed.length} questions with answer keys.`
      : 'No usable text to build questions (scanned PDF or empty file).',
  });
};

exports.listSources = async (req, res) => {
  const type = req.query.type ? String(req.query.type).toUpperCase() : undefined;
  const where = type ? { type } : {};
  const sources = await prisma.questionSource.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, type: true, year: true, chapter: true, weightage: true,
      fileName: true, fileUrl: true, linkedSourceId: true, createdAt: true,
      _count: { select: { questions: true } },
    },
  });
  res.json({ data: sources });
};

exports.getSourceQuestions = async (req, res) => {
  const questions = await prisma.question.findMany({
    where: { sourceId: req.params.id },
    orderBy: [{ questionNumber: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ data: questions });
};

exports.updateQuestion = async (req, res) => {
  const { text, optionA, optionB, optionC, optionD, optionE, correctAnswer, marks, chapter } = req.body;
  const data = {};
  if (text != null) data.text = text;
  if (optionA != null) data.optionA = optionA;
  if (optionB != null) data.optionB = optionB;
  if (optionC !== undefined) data.optionC = optionC;
  if (optionD !== undefined) data.optionD = optionD;
  if (optionE !== undefined) data.optionE = optionE;
  if (correctAnswer !== undefined) data.correctAnswer = correctAnswer ? String(correctAnswer).toUpperCase() : null;
  if (marks != null) data.marks = parseFloat(marks);
  if (chapter !== undefined) data.chapter = chapter;

  const q = await prisma.question.update({ where: { id: req.params.id }, data });
  res.json(q);
};

exports.updateSource = async (req, res) => {
  const { title, weightage, chapter, year } = req.body;
  const data = {};
  if (title != null) data.title = title;
  if (weightage != null) data.weightage = parseFloat(weightage);
  if (chapter !== undefined) data.chapter = chapter;
  if (year !== undefined) data.year = year ? parseInt(year, 10) : null;
  const s = await prisma.questionSource.update({ where: { id: req.params.id }, data });
  // sync chapter on questions if changed
  if (chapter !== undefined) {
    await prisma.question.updateMany({ where: { sourceId: s.id }, data: { chapter } });
  }
  res.json(s);
};

exports.deleteSource = async (req, res) => {
  await prisma.questionSource.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
};

// ---------- Generate paper ----------
exports.generatePaper = async (req, res) => {
  const {
    title,
    type, // PYQ | TEXTBOOK
    totalQuestions = 20,
    durationMin = 60,
    sourceIds, // optional filter
    // TEXTBOOK: [{ sourceId, weightage }] or use source.weightage
  } = req.body;

  const paperType = String(type || '').toUpperCase();
  if (!['PYQ', 'TEXTBOOK'].includes(paperType)) {
    return res.status(400).json({ message: 'type must be PYQ or TEXTBOOK' });
  }
  const n = Math.min(Math.max(parseInt(totalQuestions, 10) || 20, 1), 200);

  let selected = [];

  if (paperType === 'PYQ') {
    const base = { source: { type: 'PYQ' } };
    if (Array.isArray(sourceIds) && sourceIds.length) {
      base.sourceId = { in: sourceIds };
    }
    // Prefer questions that have keys; fall back to all extracted MCQs
    let pool = await prisma.question.findMany({ where: { ...base, correctAnswer: { not: null } } });
    if (pool.length < 1) {
      pool = await prisma.question.findMany({ where: base });
    }
    if (pool.length < 1) {
      return res.status(400).json({
        message: 'No PYQ questions found. Upload papers with numbered MCQs, then optionally upload answer keys.',
      });
    }
    selected = shuffle(pool).slice(0, Math.min(n, pool.length));
  } else {
    // TEXTBOOK weighted by chapter/source (answers optional — scoring needs keys later)
    const sources = await prisma.questionSource.findMany({
      where: {
        type: 'TEXTBOOK',
        ...(Array.isArray(sourceIds) && sourceIds.length ? { id: { in: sourceIds } } : {}),
      },
      include: { questions: true },
    });
    const groups = sources
      .filter((s) => s.questions.length)
      .map((s) => ({ items: s.questions, weight: s.weightage || 1, chapter: s.chapter || s.title }));
    if (!groups.length) {
      return res.status(400).json({
        message: 'No textbook questions found. Upload chapter PDFs that contain numbered MCQs (1. ... (a) (b) (c) (d)).',
      });
    }
    selected = pickWeighted(groups, n);
  }

  if (!selected.length) {
    return res.status(400).json({ message: 'Could not select any questions.' });
  }

  const totalMarks = selected.reduce((s, q) => s + (q.marks || 1), 0);
  const paper = await prisma.mockPaper.create({
    data: {
      title: (title && String(title).trim()) || `${paperType} Mock — ${new Date().toLocaleDateString()}`,
      type: paperType,
      totalQuestions: selected.length,
      durationMin: parseInt(durationMin, 10) || 60,
      totalMarks,
      config: { sourceIds: sourceIds || null },
      createdBy: req.userId,
      questions: {
        create: selected.map((q, i) => ({ questionId: q.id, orderIndex: i + 1 })),
      },
    },
    include: {
      questions: {
        orderBy: { orderIndex: 'asc' },
        include: {
          question: {
            select: {
              id: true, text: true, optionA: true, optionB: true, optionC: true,
              optionD: true, optionE: true, marks: true, chapter: true,
              // hide correctAnswer in list for takers — include for creator preview
              correctAnswer: true, questionNumber: true,
            },
          },
        },
      },
    },
  });

  res.status(201).json(paper);
};

exports.listPapers = async (req, res) => {
  const papers = await prisma.mockPaper.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { attempts: true, questions: true } },
      creator: { select: { id: true, name: true } },
    },
  });
  res.json({ data: papers });
};

exports.getPaper = async (req, res) => {
  const paper = await prisma.mockPaper.findUnique({
    where: { id: req.params.id },
    include: {
      questions: {
        orderBy: { orderIndex: 'asc' },
        include: {
          question: {
            select: {
              id: true, text: true, optionA: true, optionB: true, optionC: true,
              optionD: true, optionE: true, marks: true, chapter: true, questionNumber: true,
              // only expose correctAnswer to creator or after attempt — for now hide for take
            },
          },
        },
      },
    },
  });
  if (!paper) return res.status(404).json({ message: 'Paper not found' });
  res.json(paper);
};

// ---------- Attempts (conduct + evaluate) ----------
exports.startAttempt = async (req, res) => {
  const paperId = req.params.paperId || req.body.paperId;
  const paper = await prisma.mockPaper.findUnique({
    where: { id: paperId },
    include: {
      questions: {
        orderBy: { orderIndex: 'asc' },
        include: {
          question: {
            select: {
              id: true, text: true, optionA: true, optionB: true, optionC: true,
              optionD: true, optionE: true, marks: true, chapter: true,
            },
          },
        },
      },
    },
  });
  if (!paper) return res.status(404).json({ message: 'Paper not found' });

  const attempt = await prisma.mockAttempt.create({
    data: {
      paperId: paper.id,
      userId: req.userId,
      status: 'IN_PROGRESS',
      maxScore: paper.totalMarks,
      answers: {
        create: paper.questions.map((pq) => ({
          questionId: pq.questionId,
          selected: null,
        })),
      },
    },
  });

  res.status(201).json({
    attempt: {
      id: attempt.id,
      paperId: paper.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      durationMin: paper.durationMin,
      totalQuestions: paper.totalQuestions,
      totalMarks: paper.totalMarks,
      title: paper.title,
    },
    questions: paper.questions.map((pq) => ({
      orderIndex: pq.orderIndex,
      ...pq.question,
    })),
  });
};

exports.saveAnswer = async (req, res) => {
  const { questionId, selected } = req.body;
  const attempt = await prisma.mockAttempt.findUnique({ where: { id: req.params.id } });
  if (!attempt) return res.status(404).json({ message: 'Attempt not found' });
  if (attempt.userId !== req.userId) return res.status(403).json({ message: 'Forbidden' });
  if (attempt.status !== 'IN_PROGRESS') return res.status(400).json({ message: 'Attempt already submitted' });

  const ans = await prisma.mockAttemptAnswer.upsert({
    where: { attemptId_questionId: { attemptId: attempt.id, questionId } },
    create: {
      attemptId: attempt.id,
      questionId,
      selected: selected ? String(selected).toUpperCase() : null,
    },
    update: { selected: selected ? String(selected).toUpperCase() : null },
  });
  res.json(ans);
};

exports.submitAttempt = async (req, res) => {
  const attempt = await prisma.mockAttempt.findUnique({
    where: { id: req.params.id },
    include: {
      answers: true,
      paper: true,
    },
  });
  if (!attempt) return res.status(404).json({ message: 'Attempt not found' });
  if (attempt.userId !== req.userId) return res.status(403).json({ message: 'Forbidden' });
  if (attempt.status !== 'IN_PROGRESS') return res.status(400).json({ message: 'Already submitted' });

  // Optional batch answers from body
  if (Array.isArray(req.body.answers)) {
    for (const a of req.body.answers) {
      if (!a.questionId) continue;
      await prisma.mockAttemptAnswer.upsert({
        where: { attemptId_questionId: { attemptId: attempt.id, questionId: a.questionId } },
        create: {
          attemptId: attempt.id,
          questionId: a.questionId,
          selected: a.selected ? String(a.selected).toUpperCase() : null,
        },
        update: { selected: a.selected ? String(a.selected).toUpperCase() : null },
      });
    }
  }

  const answers = await prisma.mockAttemptAnswer.findMany({
    where: { attemptId: attempt.id },
    include: { question: true },
  });

  const hasAnyKey = answers.some((a) => a.question.correctAnswer);

  let score = null;
  let maxScore = null;
  let percentage = null;

  if (hasAnyKey) {
    score = 0;
    maxScore = 0;
    for (const a of answers) {
      const marks = a.question.marks || 1;
      maxScore += marks;
      const hasKey = !!a.question.correctAnswer;
      const correct = hasKey
        && a.selected
        && a.selected.toUpperCase() === a.question.correctAnswer.toUpperCase();
      const awarded = correct ? marks : 0;
      if (correct) score += awarded;
      await prisma.mockAttemptAnswer.update({
        where: { id: a.id },
        data: {
          isCorrect: hasKey && a.selected ? !!correct : null,
          marksAwarded: hasKey ? (a.selected ? awarded : 0) : null,
        },
      });
    }
    percentage = maxScore ? Math.round((score / maxScore) * 1000) / 10 : 0;
  } else {
    // No answer keys: only record what the user chose (no scoring)
    for (const a of answers) {
      await prisma.mockAttemptAnswer.update({
        where: { id: a.id },
        data: { isCorrect: null, marksAwarded: null },
      });
    }
  }

  const updated = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: {
      status: hasAnyKey ? 'EVALUATED' : 'SUBMITTED',
      score,
      maxScore,
      submittedAt: new Date(),
    },
  });

  const detailed = await prisma.mockAttemptAnswer.findMany({
    where: { attemptId: attempt.id },
    include: {
      question: {
        select: {
          id: true, text: true, optionA: true, optionB: true, optionC: true,
          optionD: true, optionE: true,
          // Only expose correctAnswer when keys exist
          correctAnswer: hasAnyKey,
          marks: true, chapter: true,
        },
      },
    },
  });

  // When no keys, strip correctAnswer from payload explicitly
  const answersOut = hasAnyKey
    ? detailed
    : detailed.map((a) => ({
        ...a,
        isCorrect: undefined,
        marksAwarded: undefined,
        question: { ...a.question, correctAnswer: undefined },
      }));

  res.json({
    attempt: updated,
    evaluated: hasAnyKey,
    score,
    maxScore,
    percentage,
    message: hasAnyKey
      ? undefined
      : 'No answer key uploaded — showing only the answers you selected (not scored).',
    answers: answersOut,
  });
};

exports.listAttempts = async (req, res) => {
  const attempts = await prisma.mockAttempt.findMany({
    where: { userId: req.userId },
    orderBy: { startedAt: 'desc' },
    include: {
      paper: { select: { id: true, title: true, type: true, totalQuestions: true, durationMin: true } },
    },
  });
  res.json({ data: attempts });
};

exports.getAttempt = async (req, res) => {
  const attempt = await prisma.mockAttempt.findUnique({
    where: { id: req.params.id },
    include: {
      paper: true,
      answers: {
        include: {
          question: {
            select: {
              id: true, text: true, optionA: true, optionB: true, optionC: true,
              optionD: true, optionE: true, marks: true, chapter: true,
              correctAnswer: true, // only useful after submit; client should hide if in progress
            },
          },
        },
      },
    },
  });
  if (!attempt) return res.status(404).json({ message: 'Not found' });
  if (attempt.userId !== req.userId) return res.status(403).json({ message: 'Forbidden' });

  // Hide correct answers while in progress
  if (attempt.status === 'IN_PROGRESS') {
    attempt.answers = attempt.answers.map((a) => ({
      ...a,
      question: { ...a.question, correctAnswer: undefined },
      isCorrect: undefined,
      marksAwarded: undefined,
    }));
  }
  res.json(attempt);
};
