import 'dotenv/config';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: (process.env.SMTP_SECURE || 'true') === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const runUrl = process.env.RUN_URL || '(no run URL)';

await transporter.sendMail({
  from: process.env.EMAIL_FROM,
  to: process.env.EMAIL_TO,
  subject: 'Award bot run FAILED',
  text: `The award flight bot's GitHub Actions run failed.\n\nSee the logs: ${runUrl}\n\nUntil this is fixed, the bot is not checking for fares.`,
});
