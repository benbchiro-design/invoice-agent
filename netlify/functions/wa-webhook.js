// Receives incoming WhatsApp messages (your replies) from the Meta webhook.
// Requires env vars: WHATSAPP_VERIFY_TOKEN (a string you invent, entered into
// the Meta App Dashboard webhook config), WHATSAPP_TO_NUMBER (your own number
// - the only sender this will act on), and (recommended) WHATSAPP_APP_SECRET
// for signature verification. Also needs ANTHROPIC_API_KEY, GMAIL_USER,
// GMAIL_APP_PASSWORD to classify replies and actually send invoices.
const crypto = require('crypto');
const { invoicesStore, historyStore, msgIndexStore, getJSON, setJSON } = require('./lib/store');
const { sendWhatsAppText } = require('./lib/whatsapp');
const { sendInvoiceEmail } = require('./lib/mailer');
const { classifyReply } = require('./lib/classify');
const { calcTotal } = require('./lib/draft');
const { PRACTICE } = require('./lib/practice');

function verifySignature(rawBody, signatureHeader) {
  if (!process.env.WHATSAPP_APP_SECRET) return true; // not configured yet - see comment above
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function invoiceEmailContent(rec, action, method) {
  const total = calcTotal(rec.lineItems);
  const isEft = action === 'approve';
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
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params['hub.mode'] === 'subscribe' && params['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: params['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}');
  if (!verifySignature(rawBody, event.headers['x-hub-signature-256'])) {
    return { statusCode: 401, body: 'Bad signature' };
  }

  const body = JSON.parse(rawBody);
  const entry = (body.entry || [])[0];
  const change = entry && (entry.changes || [])[0];
  const value = change && change.value;
  const msg = value && (value.messages || [])[0];
  // Always 200 on anything we're not handling, so Meta doesn't retry forever.
  if (!msg || msg.type !== 'text') return { statusCode: 200, body: 'ignored' };

  const from = msg.from;
  if (process.env.WHATSAPP_TO_NUMBER && from !== process.env.WHATSAPP_TO_NUMBER) {
    return { statusCode: 200, body: 'ignored - unauthorized sender' };
  }

  const text = msg.text.body;
  const replyToId = msg.context && msg.context.id;

  const invoices = invoicesStore();
  const idx = msgIndexStore();

  let invoiceId = replyToId ? await getJSON(idx, replyToId, null) : null;
  if (!invoiceId) invoiceId = await getJSON(idx, 'latest', null); // fall back to the most recent draft sent

  if (!invoiceId) {
    await sendWhatsAppText(from, "I don't have a pending invoice to match that to - check the approval queue in the app.");
    return { statusCode: 200, body: 'ok' };
  }

  const rec = await getJSON(invoices, invoiceId, null);
  if (!rec || rec.status === 'done') {
    await sendWhatsAppText(from, 'That invoice was already handled or is no longer pending.', msg.id);
    return { statusCode: 200, body: 'ok' };
  }

  const total = calcTotal(rec.lineItems);
  const summary = `${rec.patientName} - ${rec.icd} - R${total.toFixed(2)}`;
  const result = await classifyReply(text, summary);

  if (result.action === 'decline') {
    await sendWhatsAppText(from, `OK, left ${rec.patientName}'s invoice pending - no email sent.`, msg.id);
    return { statusCode: 200, body: 'ok' };
  }

  if (result.action === 'unclear' || !result.action) {
    await sendWhatsAppText(
      from,
      `Not sure what you mean for ${rec.patientName}'s invoice (R${total.toFixed(2)}). Reply "approved", "paid R${total.toFixed(2)} cash/card/eft", or "no charge".`,
      msg.id,
    );
    return { statusCode: 200, body: 'ok' };
  }

  const isNoCharge = result.action === 'no_charge';
  const method = result.method || (result.action === 'mark_paid' ? 'Cash' : null);

  if (!isNoCharge) {
    const { subject, text: bodyText } = invoiceEmailContent(rec, result.action === 'approve' ? 'approve' : 'mark_paid', method);
    await sendInvoiceEmail({ to: rec.patientEmail, subject, text: bodyText });
  }

  rec.status = 'done';
  rec.paymentMethod = isNoCharge ? 'No charge' : (method || 'EFT pending');
  await setJSON(invoices, invoiceId, rec);

  if (!isNoCharge) {
    const history = historyStore();
    await setJSON(history, rec.patientName, { icd: rec.icd, icd2: rec.icd2, lineItems: rec.lineItems, date: new Date().toISOString() });
  }

  const confirmMsg = isNoCharge
    ? `Marked ${rec.patientName} as no charge - no invoice sent.`
    : result.action === 'approve'
      ? `Invoice for R${total.toFixed(2)} sent to ${rec.patientEmail} - awaiting EFT.`
      : `Receipt for R${total.toFixed(2)} sent to ${rec.patientEmail} - marked paid via ${method}.`;
  await sendWhatsAppText(from, confirmMsg, msg.id);

  return { statusCode: 200, body: 'ok' };
};
