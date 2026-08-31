// Receives the practice owner's WhatsApp reply, relayed by wa-notify's
// "external approval" flow (see bot/flows/external-approval.js in the
// wa-notify repo). wa-notify already resolved the sender to the tenant
// owner and restricts who can trigger this - this function only verifies
// the shared secret and turns the reply into an action.
// Requires env vars: WA_NOTIFY_SECRET (matches wa-notify's
// EXTERNAL_APPROVAL_SECRET), ANTHROPIC_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD.
const { invoicesStore, historyStore, getJSON, setJSON } = require('./lib/store');
const { sendInvoiceEmail } = require('./lib/mailer');
const { classifyReply } = require('./lib/classify');
const { calcTotal } = require('./lib/draft');
const { PRACTICE } = require('./lib/practice');

function invoiceEmailContent(rec, isEft, method) {
  const total = calcTotal(rec.lineItems);
  const lineText = rec.lineItems.map((i) => `${i.code} ${i.description} x${i.qty} = R${(i.qty * i.rate).toFixed(2)}`).join('\n');
  const icdText = `ICD-10: ${rec.icd}${rec.icd2 ? ' / ' + rec.icd2 : ''}`;
  const greeting = `Dear ${rec.patientName.split(' ')[0]},`;
  const footer = `Kind regards,\n${PRACTICE.name}\n${PRACTICE.phone}\n${PRACTICE.email}`;

  if (isEft) {
    return {
      subject: `Invoice ${rec.invoiceNumber} - Payment required - ${PRACTICE.name}`,
      text: `${greeting}\n\nThank you for your visit today. Please find your invoice details below:\n\n${lineText}\n${icdText}\n\n`
        + `TOTAL DUE: R${total.toFixed(2)}\n\nPlease EFT payment to:\nPractice No: ${PRACTICE.practiceNo}\n`
        + `Reference: your name and ${rec.invoiceNumber}\n\n${footer}`,
    };
  }
  return {
    subject: `Invoice ${rec.invoiceNumber} - Receipt - ${PRACTICE.name}`,
    text: `${greeting}\n\nThank you for your payment. Please find your receipt below:\n\n${lineText}\n${icdText}\n\n`
      + `TOTAL PAID: R${total.toFixed(2)} (${method || ''})\n\n${footer}`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!process.env.WA_NOTIFY_SECRET || event.headers['x-external-token'] !== process.env.WA_NOTIFY_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const { refId, text } = JSON.parse(event.body || '{}');
  if (!refId || !text) {
    return { statusCode: 200, body: JSON.stringify({ reply: null, done: true }) };
  }

  const invoices = invoicesStore();
  const rec = await getJSON(invoices, refId, null);
  if (!rec || rec.status === 'done') {
    return { statusCode: 200, body: JSON.stringify({ reply: 'That invoice was already handled or is no longer pending.', done: true }) };
  }

  const total = calcTotal(rec.lineItems);
  const summary = `${rec.patientName} - ${rec.icd} - R${total.toFixed(2)}`;
  const result = await classifyReply(text, summary);

  if (result.action === 'decline') {
    return { statusCode: 200, body: JSON.stringify({ reply: `OK, left ${rec.patientName}'s invoice pending - no email sent.`, done: false }) };
  }

  if (result.action === 'unclear' || !result.action) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: `Not sure what you mean for ${rec.patientName}'s invoice (R${total.toFixed(2)}). Reply "approved", "paid R${total.toFixed(2)} cash/card/eft", or "no charge".`,
        done: false,
      }),
    };
  }

  const isNoCharge = result.action === 'no_charge';
  const method = result.method || (result.action === 'mark_paid' ? 'Cash' : null);
  const isEft = result.action === 'approve';

  if (!isNoCharge) {
    const { subject, text: bodyText } = invoiceEmailContent(rec, isEft, method);
    await sendInvoiceEmail({ to: rec.patientEmail, subject, text: bodyText });
  }

  rec.status = 'done';
  rec.paymentMethod = isNoCharge ? 'No charge' : (method || 'EFT pending');
  await setJSON(invoices, refId, rec);

  if (!isNoCharge) {
    const history = historyStore();
    await setJSON(history, rec.patientName, { icd: rec.icd, icd2: rec.icd2, lineItems: rec.lineItems, date: new Date().toISOString() });
  }

  const confirmMsg = isNoCharge
    ? `Marked ${rec.patientName} as no charge - no invoice sent.`
    : isEft
      ? `Invoice for R${total.toFixed(2)} sent to ${rec.patientEmail} - awaiting EFT.`
      : `Receipt for R${total.toFixed(2)} sent to ${rec.patientEmail} - marked paid via ${method}.`;

  return { statusCode: 200, body: JSON.stringify({ reply: confirmMsg, done: true }) };
};
