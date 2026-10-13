const { z } = require('zod');

exports.token = z.object({ token: z.string().min(20, 'Invalid token').max(4096) });
