const multer = require('multer');

module.exports = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    let message = err.message;
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = err.field === 'media' ? 'File must be 50 MB or smaller.' : 'File must be 2 MB or smaller.';
    }
    return res.status(400).json({ message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request body.' });
  // Deliberate client errors (400, 403, 404...) thrown with an err.status.
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message });
  // Unique constraint (e.g. two requests creating the same email at once)
  if (err.code === 'P2002') {
    return res.status(409).json({ message: 'That email is already in use.', errors: { email: ['Email already in use'] } });
  }
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on our side. Please try again.' });
};
