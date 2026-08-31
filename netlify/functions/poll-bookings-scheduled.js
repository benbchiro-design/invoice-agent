// Scheduled function (see netlify.toml) - checks Wix for new bookings, drafts
// an invoice for each one the agent hasn't seen yet, and WhatsApps you a
// one-line summary to approve, mark paid, or decline by replying.
// Requires env vars: WIX_API_KEY, WIX_SITE_ID, WHATSAPP_TO_NUMBER (your own
// WhatsApp number, e.g. "27821234567"), plus WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID.
const { invoicesStore, historyStore, msgIndexStore, getJSON, setJSON } = require('./lib/store');
const { draftForBooking, calcTotal } = require('./lib/draft');
const { sendWhatsAppText } = require('./lib/whatsapp');

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
  const idx = msgIndexStore();
  const toNumber = process.env.WHATSAPP_TO_NUMBER;
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

    if (toNumber) {
      const total = calcTotal(rec.lineItems).toFixed(2);
      const text = `New booking: ${rec.patientName} - R${total}\n${draft.note}\n\n`
        + `Reply "approved", "paid R${total} cash/card/eft", or "no charge".`;
      const waMsgId = await sendWhatsAppText(toNumber, text);
      if (waMsgId) {
        await setJSON(idx, waMsgId, rec.id);
        await setJSON(idx, 'latest', rec.id);
      }
    }
  }

  return { statusCode: 200, body: `Checked ${bookings.length} booking(s), drafted ${drafted} new` };
};
