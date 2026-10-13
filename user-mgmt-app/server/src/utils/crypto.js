const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const randomOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

module.exports = { sha256, randomToken, randomOtp };
