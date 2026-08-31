// Real (non-mailto) email sending, via Gmail SMTP.
// Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD (a Google "app password",
// generated under Google Account > Security > 2-Step Verification > App
// passwords - a normal Gmail password will not work here).
const nodemailer = require('nodemailer');

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

async function sendInvoiceEmail({ to, subject, text }) {
  await getTransporter().sendMail({ from: process.env.GMAIL_USER, to, subject, text });
}

module.exports = { sendInvoiceEmail };
