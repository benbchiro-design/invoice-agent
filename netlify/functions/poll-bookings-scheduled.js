// Scheduled function (see netlify.toml) - checks Wix for new bookings, drafts
// an invoice for each one the agent hasn't seen yet, and asks wa-notify (the
// existing SA Notify WhatsApp platform - see the wa-notify repo) to WhatsApp
// you a one-line summary to approve, mark paid, or decline by replying.
// Requires env vars: WIX_API_KEY, WIX_SITE_ID, WA_NOTIFY_BASE_URL,
// WA_NOTIFY_SLUG, WA_NOTIFY_SECRET (see lib/wa-notify-client.js).
const { invoicesStore, historyStore, getJSON, setJSON } = require('./lib/store');
const { draftForBooking, calcTotal } = require('./lib/draft');
const { notifyOwner } = require('./lib/wa-notify-client');

function wixHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: process.env.WIX_API_KEY,
    'wix-site-id': process.env.WIX_SITE_ID,
  };
}

function makeInvoiceNumber() {
  const d = new Date();
  return 'INV-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
    + '-' + String(Math.floor(Math.random() * 900) + 100);
}

async function fetchTodaysBookings() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const res = await fetch('https://www.wixapis.com/_api/bookings-reader/v2/extended-bookings/query', {
    method: 'POST',
    headers: wixHeaders(),
    body: JSON.stringify({
      query: {
        filter: { 'booking.status': { $in: ['CONFIRMED', 'PENDING'] } },
        sort: [{ fieldName: 'booking._createdDate', order: 'DESC' }],
        paging: { limit: 50 },
      },
    }),
  });
  const data = await res.json();
  const all = data.extendedBookings || data.bookings || [];
  return all
    .filter((eb) => {
      const b = eb.booking || eb;
      const slot = (b.bookedEntity && b.bookedEntity.slot) || {};
      const d = slot.startDate || slot.start || b._createdDate || '';
      return d >= startOfDay;
    })
    .map((eb) => {
      const b = eb.booking || eb;
      const contact = b.contactDetails || {};
      const slot = (b.bookedEntity && b.bookedEntity.slot) || {};
      return {
        bookingId: b._id || b.id,
        patientName: ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim() || 'Patient',
        patientEmail: contact.email || contact.emailAddress || '',
        appointmentTime: slot.startDate || slot.start || now.toISOString(),
      };
    });
}

exports.handler = async () => {
  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return { statusCode: 200, body: 'Wix credentials not configured - skipping' };
  }

  const bookings = await fetchTodaysBookings();
  const invoices = invoicesStore();
  const history = historyStore();
  let drafted = 0;

  for (const b of bookings) {
    const existing = await getJSON(invoices, b.bookingId, null);
    if (existing) continue; // already drafted/notified on a previous run

    const hist = await getJSON(history, b.patientName, null);
    const draft = draftForBooking(b.patientName, b.appointmentTime, hist);
    const rec = {
      id: b.bookingId,
      invoiceNumber: makeInvoiceNumber(),
      patientName: b.patientName,
      patientEmail: b.patientEmail,
      appointmentTime: b.appointmentTime,
      status: 'pending',
      icd: draft.icd,
      icd2: draft.icd2,
      lineItems: draft.lineItems,
    };
    await setJSON(invoices, rec.id, rec);
    drafted++;

    if (process.env.WA_NOTIFY_BASE_URL) {
      const total = calcTotal(rec.lineItems).toFixed(2);
      const text = `New booking: ${rec.patientName} - R${total}\n${draft.note}\n\n`
        + `Reply "approved", "paid R${total} cash/card/eft", or "no charge".`;
      // refId = our own booking/invoice id - wa-notify hands it straight back
      // on the callback, no separate message-id bookkeeping needed. Note:
      // wa-notify holds one active reply-conversation per owner phone, so a
      // second notify() before this one is resolved takes over "the current
      // reply" - older pending invoices stay safely queued in the app either way.
      await notifyOwner(text, rec.id);
    }
  }

  return { statusCode: 200, body: `Checked ${bookings.length} booking(s), drafted ${drafted} new` };
};
