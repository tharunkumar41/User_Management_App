-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'VERIFY_EMAIL';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false;
