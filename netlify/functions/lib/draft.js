// Server-side twin of the draft logic in index.html (draftForBooking/defaultItems).
// The browser app and this backend keep separate state, so the same drafting
// rule is duplicated here in plain form rather than shared via a bundler.

function defaultItems(appointmentTime) {
  const isAfterHours = appointmentTime ? new Date(appointmentTime).getHours() >= 19 : false;
  return [
    { code: '04301', description: 'Consultation' + (isAfterHours ? ' (after hours)' : ''), qty: 1, rate: isAfterHours ? 420 : 300 },
    { code: '04312', description: 'Two Diagnostic Procedures', qty: 1, rate: 250 },
    { code: '04333', description: 'Three Treatment Procedures', qty: 1, rate: 180 },
  ];
}

// history: {icd, icd2, lineItems, date} from the patient's last approved visit, or null.
function draftForBooking(patientName, appointmentTime, history) {
  const defaultIcd = process.env.DEFAULT_ICD || 'M99.11';
  const firstName = (patientName || 'Patient').split(' ')[0];
  if (history) {
    return {
      icd: history.icd || defaultIcd,
      icd2: history.icd2 || '',
      lineItems: history.lineItems.map((i) => ({ ...i })),
      note: `Agent draft: reused ${history.icd || defaultIcd} and line items from ${firstName}'s last visit (${new Date(history.date).toLocaleDateString('en-ZA')}).`,
    };
  }
  return {
    icd: defaultIcd,
    icd2: '',
    lineItems: defaultItems(appointmentTime),
    note: `Agent draft: no visit history for ${firstName} - used the default consultation template.`,
  };
}

function calcTotal(items) {
  return items.reduce((s, i) => s + parseFloat(i.qty || 1) * parseFloat(i.rate || 0), 0);
}

module.exports = { defaultItems, draftForBooking, calcTotal };
