const { z } = require('zod');

exports.start = z.object({ userId: z.string().uuid('Invalid user') });
