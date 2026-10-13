const Redis = require('ioredis');
const env = require('./env');

const redis = new Redis(env.REDIS_URL);

redis.on('error', (err) => console.error('[redis]', err.message));
redis.on('ready', () => console.log('[redis] connected'));

module.exports = redis;
