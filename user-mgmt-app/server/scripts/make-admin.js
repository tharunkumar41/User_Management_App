// Usage: npm run make-admin -- someone@example.com
require('dotenv').config();
const prisma = require('../src/config/db');

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run make-admin -- someone@example.com');
    process.exit(1);
  }
  try {
    const user = await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
    console.log(`${user.email} is now an ADMIN.`);
  } catch {
    console.error(`No user found with email ${email}. Register that account first.`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
