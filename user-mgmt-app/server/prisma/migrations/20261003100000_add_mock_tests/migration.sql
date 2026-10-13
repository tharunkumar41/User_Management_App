-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('PYQ', 'TEXTBOOK', 'ANSWER_KEY');
CREATE TYPE "MockPaperType" AS ENUM ('PYQ', 'TEXTBOOK');
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EVALUATED');

-- CreateTable
CREATE TABLE "QuestionSource" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "year" INTEGER,
    "chapter" TEXT,
    "weightage" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "fileName" TEXT,
    "fileUrl" TEXT,
    "rawText" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "linkedSourceId" TEXT,

    CONSTRAINT "QuestionSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "questionNumber" INTEGER,
    "text" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT,
    "optionD" TEXT,
    "optionE" TEXT,
    "correctAnswer" TEXT,
    "explanation" TEXT,
    "marks" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "chapter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MockPaper" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "MockPaperType" NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "totalMarks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "config" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockPaper_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MockPaperQuestion" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,

    CONSTRAINT "MockPaperQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MockAttempt" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "score" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "MockAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MockAttemptAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selected" TEXT,
    "isCorrect" BOOLEAN,
    "marksAwarded" DOUBLE PRECISION,

    CONSTRAINT "MockAttemptAnswer_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "QuestionSource_type_idx" ON "QuestionSource"("type");
CREATE INDEX "QuestionSource_uploadedBy_idx" ON "QuestionSource"("uploadedBy");
CREATE INDEX "Question_sourceId_idx" ON "Question"("sourceId");
CREATE INDEX "Question_chapter_idx" ON "Question"("chapter");
CREATE INDEX "MockPaper_createdBy_idx" ON "MockPaper"("createdBy");
CREATE INDEX "MockPaper_type_idx" ON "MockPaper"("type");
CREATE INDEX "MockPaperQuestion_paperId_idx" ON "MockPaperQuestion"("paperId");
CREATE UNIQUE INDEX "MockPaperQuestion_paperId_questionId_key" ON "MockPaperQuestion"("paperId", "questionId");
CREATE INDEX "MockAttempt_userId_idx" ON "MockAttempt"("userId");
CREATE INDEX "MockAttempt_paperId_idx" ON "MockAttempt"("paperId");
CREATE INDEX "MockAttemptAnswer_attemptId_idx" ON "MockAttemptAnswer"("attemptId");
CREATE UNIQUE INDEX "MockAttemptAnswer_attemptId_questionId_key" ON "MockAttemptAnswer"("attemptId", "questionId");

-- FKs
ALTER TABLE "QuestionSource" ADD CONSTRAINT "QuestionSource_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionSource" ADD CONSTRAINT "QuestionSource_linkedSourceId_fkey" FOREIGN KEY ("linkedSourceId") REFERENCES "QuestionSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "QuestionSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockPaper" ADD CONSTRAINT "MockPaper_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockPaperQuestion" ADD CONSTRAINT "MockPaperQuestion_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "MockPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockPaperQuestion" ADD CONSTRAINT "MockPaperQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockAttempt" ADD CONSTRAINT "MockAttempt_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "MockPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockAttempt" ADD CONSTRAINT "MockAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockAttemptAnswer" ADD CONSTRAINT "MockAttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockAttemptAnswer" ADD CONSTRAINT "MockAttemptAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
