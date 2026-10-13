const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const redis = require('../../config/redis');

const ML_DIR = path.join(__dirname, '..', '..', '..', 'ml');
const JOB_TTL = 60 * 60; // 1 hour

// Prefer PYTHON env, then python3, then python (Windows often only has `python`)
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const { execSync } = require('child_process');
  for (const cmd of ['python3', 'python']) {
    try {
      execSync(`${cmd} -c "import sys"`, { stdio: 'ignore', timeout: 3000 });
      return cmd;
    } catch { /* try next */ }
  }
  return 'python';
}
const PYTHON = resolvePython();
console.log(`[vision] using Python: ${PYTHON}`);

function jobKey(id) {
  return `vision:job:${id}`;
}

async function setJob(id, data) {
  await redis.set(jobKey(id), JSON.stringify(data), 'EX', JOB_TTL);
}

async function getJob(id) {
  const raw = await redis.get(jobKey(id));
  return raw ? JSON.parse(raw) : null;
}

function runPythonAsync(scriptName, args, jobId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const script = path.join(ML_DIR, scriptName);
    const proc = spawn(PYTHON, [script, ...args], {
      cwd: path.dirname(script),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(Object.assign(new Error('Processing timed out'), { status: 504 }));
    }, timeoutMs);

    const updateProgress = async (pct) => {
      try {
        const job = await getJob(jobId);
        if (job && job.status === 'running') {
          job.progress = Math.min(99, Math.max(0, pct));
          await setJob(jobId, job);
        }
      } catch { /* ignore redis blips */ }
    };

    proc.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      // Progress lines may appear on stdout
      for (const line of text.split('\n')) {
        const m = line.match(/^PROGRESS:(\d+)/);
        if (m) updateProgress(parseInt(m[1], 10));
      }
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        const m = line.match(/^PROGRESS:(\d+)/);
        if (m) updateProgress(parseInt(m[1], 10));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // Keep only JSON lines from stdout (ignore any stray PROGRESS on stdout)
      const cleanOut = stdout
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('PROGRESS:'))
        .join('\n')
        .trim();
      if (code !== 0) {
        let msg = stderr.trim() || cleanOut || `Python exited with code ${code}`;
        // Prefer last traceback-looking chunk
        if (stderr.includes('Traceback')) {
          const parts = stderr.trim().split('Traceback');
          msg = 'Traceback' + parts[parts.length - 1];
        }
        if (/No module named|ModuleNotFoundError/i.test(msg)) {
          msg = msg + ` | Python used: "${PYTHON}". Install deps with: ${PYTHON} -m pip install opencv-python-headless pytesseract mediapipe numpy Pillow onnxruntime`;
        }
        return reject(Object.assign(new Error(msg.slice(0, 800)), { status: 500 }));
      }
      try {
        const lines = cleanOut.split(/\r?\n/);
        let jsonStr = lines[lines.length - 1] || '';
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].trim().startsWith('{')) {
            jsonStr = lines.slice(i).join('\n');
            break;
          }
        }
        if (!jsonStr.trim().startsWith('{')) {
          const errHint = stderr.trim().slice(-500) || 'no JSON on stdout';
          return reject(Object.assign(new Error(`Model produced no JSON result. ${errHint}`), { status: 500 }));
        }
        const data = JSON.parse(jsonStr);
        if (data.error) {
          return reject(Object.assign(new Error(data.error), { status: 400 }));
        }
        resolve(data);
      } catch (e) {
        const errHint = stderr.trim().slice(-400) || cleanOut.slice(0, 200);
        reject(Object.assign(new Error(`Invalid model output: ${errHint}`), { status: 500 }));
      }
    });
  });
}

/** Synchronous helper still used by visiting-card (fast). */
function runPython(scriptName, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const script = path.join(ML_DIR, scriptName);
    const proc = spawn(PYTHON, [script, ...args], {
      cwd: path.dirname(script),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(Object.assign(new Error('Processing timed out'), { status: 504 }));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let msg = stderr.trim() || stdout.trim() || `Python exited with code ${code}`;
        if (/No module named|ModuleNotFoundError/i.test(msg)) {
          msg = msg + ` | Python used: "${PYTHON}". Install deps with: ${PYTHON} -m pip install opencv-python-headless pytesseract mediapipe numpy Pillow onnxruntime`;
        }
        return reject(Object.assign(new Error(msg), { status: 500 }));
      }
      try {
        const lines = stdout.trim().split('\n');
        let jsonStr = lines[lines.length - 1];
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].startsWith('{')) {
            jsonStr = lines.slice(i).join('\n');
            break;
          }
        }
        const data = JSON.parse(jsonStr);
        if (data.error) return reject(Object.assign(new Error(data.error), { status: 400 }));
        resolve(data);
      } catch (e) {
        reject(Object.assign(new Error(`Invalid model output: ${stdout.slice(0, 200)}`), { status: 500 }));
      }
    });
  });
}

async function startJob(type, script, args, userId) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: 'running',
    progress: 0,
    userId,
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
  };
  await setJob(id, job);

  // Vehicle ANPR can take several minutes (EasyOCR load + per-vehicle OCR)
  const timeoutMs = type === 'vehicle-identification' ? 600000 : 300000;

  // Fire-and-forget processing
  runPythonAsync(script, args, id, timeoutMs)
    .then(async (result) => {
      await setJob(id, {
        ...job,
        status: 'done',
        progress: 100,
        result,
        finishedAt: new Date().toISOString(),
      });
    })
    .catch(async (err) => {
      await setJob(id, {
        ...job,
        status: 'error',
        progress: 100,
        error: err.message || 'Processing failed',
        finishedAt: new Date().toISOString(),
      });
    });

  return id;
}

// ---------- Visiting Card (sync – fast OCR) ----------
exports.visitingCard = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload an image of the visiting card.' });
  try {
    const result = await runPython('visiting_card.py', [req.file.path], 60000);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'OCR failed' });
  }
};

// ---------- Face Detection (async) ----------
exports.faceDetection = async (req, res) => {
  const video = req.file || req.files?.video?.[0];
  if (!video) return res.status(400).json({ message: 'Upload a video.' });
  const reference = req.files?.reference?.[0];
  const maxFrames = Math.min(parseInt(req.body.maxFrames, 10) || 120, 200);
  const args = [video.path, String(maxFrames)];
  if (reference) args.push(reference.path);
  const jobId = await startJob('face-detection', 'face_detection.py', args, req.userId);
  res.status(202).json({ jobId, status: 'running', progress: 0 });
};

// ---------- Object Detection (async) ----------
exports.objectDetection = async (req, res) => {
  const video = req.file || req.files?.video?.[0];
  if (!video) return res.status(400).json({ message: 'Upload a video.' });
  const reference = req.files?.reference?.[0];
  const search = (req.body.search || '').trim();
  const maxFrames = Math.min(parseInt(req.body.maxFrames, 10) || 40, 80);
  const args = [video.path, search, String(maxFrames)];
  if (reference) args.push(reference.path);
  const jobId = await startJob('object-detection', 'object_detection.py', args, req.userId);
  res.status(202).json({ jobId, status: 'running', progress: 0 });
};

// ---------- Vehicle Identification (async) ----------
exports.vehicleIdentification = async (req, res) => {
  const videos = [
    ...(req.files?.videos || []),
    ...(req.files?.video ? [req.files.video[0]] : []),
  ].filter(Boolean);
  if (!videos.length) return res.status(400).json({ message: 'Upload at least one video.' });
  const photoFile = req.files?.photo?.[0];
  const { color = '', type = '', number = '', brand = '' } = req.body;
  const maxFrames = Math.min(parseInt(req.body.maxFrames, 10) || 40, 80);

  // Multiple videos joined with || for the Python script
  const videoArg = videos.map((v) => v.path).join('||');
  const args = [
    videoArg,
    color,
    type,
    number,
    brand,
    photoFile ? photoFile.path : '',
    String(maxFrames),
  ];
  const jobId = await startJob('vehicle-identification', 'vehicle_identification.py', args, req.userId);
  res.status(202).json({ jobId, status: 'running', progress: 0, videoCount: videos.length });
};

// ---------- Job status (poll) ----------
exports.getJob = async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ message: 'Job not found or expired.' });
  // Only owner can read
  if (job.userId && job.userId !== req.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress ?? 0,
    result: job.status === 'done' ? job.result : undefined,
    error: job.status === 'error' ? job.error : undefined,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  });
};
