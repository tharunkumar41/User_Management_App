const { z } = require('zod');

const name = z.string().trim().min(2, 'Name must be at least 2 characters').max(80);
const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const phone = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number')
  .or(z.literal(''))
  .optional();
const role = z.enum(['USER', 'ADMIN'], { errorMap: () => ({ message: 'Role must be USER or ADMIN' }) });
const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number')
  .or(z.literal(''))
  .optional();

exports.createSchema = z.object({ name, email, phone, role: role.default('USER'), password });
exports.updateSchema = z.object({ name, email, phone, role });

// One CSV row (values are cleaned before validation, see users.controller)
exports.importRow = z.object({ name, email, phone, role, password });
