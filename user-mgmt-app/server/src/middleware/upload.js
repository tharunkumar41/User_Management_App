const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const AVATAR_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
const CHAT_DIR = path.join(__dirname, '..', '..', 'uploads', 'chat');
const VISION_DIR = path.join(__dirname, '..', '..', 'uploads', 'vision');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(CHAT_DIR, { recursive: true });
fs.mkdirSync(VISION_DIR, { recursive: true });

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => cb(null, `${req.userId}-${Date.now()}${ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED[file.mimetype]) return cb(badRequest('Only JPG, PNG or WEBP images are allowed.'));
    cb(null, true);
  },
}).single('picture');

// CSV imports are parsed straight from memory, nothing is written to disk.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.csv$/i.test(file.originalname)) return cb(badRequest('Upload a .csv file.'));
    cb(null, true);
  },
}).single('file');

// Chat attachments: images and videos. Random file names make the URLs unguessable.
// (Per-type size limits are checked in the chat controller: images 5 MB, videos 50 MB.)
const CHAT_ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

const uploadChatMedia = multer({
  storage: multer.diskStorage({
    destination: CHAT_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${CHAT_ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!CHAT_ALLOWED[file.mimetype]) {
      return cb(badRequest('Only images (JPG, PNG, WEBP, GIF) and videos (MP4, WEBM, MOV) are allowed.'));
    }
    cb(null, true);
  },
}).single('media');

// Vision features: images (cards) and videos
const VISION_IMAGE_ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
};
const VISION_VIDEO_ALLOWED = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};
const VISION_ALL = { ...VISION_IMAGE_ALLOWED, ...VISION_VIDEO_ALLOWED };

const uploadVisionImage = multer({
  storage: multer.diskStorage({
    destination: VISION_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${VISION_IMAGE_ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!VISION_IMAGE_ALLOWED[file.mimetype]) return cb(badRequest('Only JPG, PNG or WEBP images are allowed.'));
    cb(null, true);
  },
}).single('image');

const uploadVisionVideo = multer({
  storage: multer.diskStorage({
    destination: VISION_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${VISION_VIDEO_ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!VISION_VIDEO_ALLOWED[file.mimetype]) return cb(badRequest('Only MP4, WEBM or MOV videos are allowed.'));
    cb(null, true);
  },
}).single('video');

// Vehicle may need video + optional photo
const uploadVehicle = multer({
  storage: multer.diskStorage({
    destination: VISION_DIR,
    filename: (req, file, cb) => {
      const map = file.fieldname === 'photo' ? VISION_IMAGE_ALLOWED : VISION_VIDEO_ALLOWED;
      const ext = map[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext || '.bin'}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && !VISION_VIDEO_ALLOWED[file.mimetype]) {
      return cb(badRequest('Video must be MP4, WEBM or MOV.'));
    }
    if (file.fieldname === 'photo' && !VISION_IMAGE_ALLOWED[file.mimetype]) {
      return cb(badRequest('Photo must be JPG, PNG or WEBP.'));
    }
    cb(null, true);
  },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'videos', maxCount: 10 },
  { name: 'photo', maxCount: 1 },
]);


const MOCK_DIR = path.join(__dirname, '..', '..', 'uploads', 'mock');
fs.mkdirSync(MOCK_DIR, { recursive: true });

const MOCK_ALLOWED = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'text/plain': '.txt',
};

const uploadMockDoc = multer({
  storage: multer.diskStorage({
    destination: MOCK_DIR,
    filename: (req, file, cb) => {
      const ext = MOCK_ALLOWED[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okMime = !!MOCK_ALLOWED[file.mimetype];
    const okExt = ['.pdf', '.docx', '.doc', '.txt'].includes(ext);
    if (!okMime && !okExt) return cb(badRequest('Only PDF, DOCX or TXT files are allowed.'));
    cb(null, true);
  },
}).single('file');


const uploadVisionSearch = multer({
  storage: multer.diskStorage({
    destination: VISION_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || ''}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isVideo = /^video\/(mp4|webm|quicktime|x-msvideo)$/i.test(file.mimetype)
      || /\.(mp4|webm|mov|avi)$/i.test(file.originalname);
    const isImage = /^image\/(jpeg|png|webp)$/i.test(file.mimetype);
    if (file.fieldname === 'video' || file.fieldname === 'videos') {
      if (!isVideo) return cb(badRequest('Videos must be MP4, WEBM or MOV.'));
    } else if (file.fieldname === 'reference' || file.fieldname === 'photo') {
      if (!isImage) return cb(badRequest('Reference must be JPG, PNG or WEBP.'));
    }
    cb(null, true);
  },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'videos', maxCount: 10 },
  { name: 'reference', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
]);

module.exports = {
  uploadVisionSearch,
  uploadMockDoc, MOCK_DIR,
  uploadAvatar, uploadCsv, uploadChatMedia,
  uploadVisionImage, uploadVisionVideo, uploadVehicle,
  AVATAR_DIR, CHAT_DIR, VISION_DIR,
};
