const fs = require('fs');
const path = require('path');

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt') {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text || '';
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }
  if (ext === '.doc') {
    // legacy .doc not well supported; try reading as text fallback
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      throw Object.assign(new Error('Legacy .doc format is not supported. Please upload PDF or DOCX.'), { status: 400 });
    }
  }
  throw Object.assign(new Error('Unsupported file type'), { status: 400 });
}

module.exports = { extractText };
