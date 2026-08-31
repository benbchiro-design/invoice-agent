// Persisted state for the WhatsApp approval flow, backed by Netlify Blobs.
// Netlify auto-provisions blob store credentials for functions running on
// Netlify's own infrastructure - no extra env vars needed for this part.
const { getStore } = require('@netlify/blobs');

const invoicesStore = () => getStore('invoice-agent-invoices'); // bookingId -> invoice record
const historyStore = () => getStore('invoice-agent-history'); // patientName -> last approved {icd, icd2, lineItems, date}

async function getJSON(store, key, fallback) {
  const raw = await store.get(key);
  return raw ? JSON.parse(raw) : fallback;
}

async function setJSON(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

module.exports = { invoicesStore, historyStore, getJSON, setJSON };
