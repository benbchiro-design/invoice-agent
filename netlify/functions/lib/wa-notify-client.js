// Client for wa-notify's generic "external approval" WhatsApp relay - see
// routes/external-approval.js in the wa-notify repo. Requires:
//   WA_NOTIFY_BASE_URL   e.g. https://sanotify.co.za
//   WA_NOTIFY_SLUG       this practice's tenant slug there, e.g. "bradford"
//   WA_NOTIFY_SECRET     must match wa-notify's EXTERNAL_APPROVAL_SECRET
// Netlify auto-injects `URL` with this site's public address, used to build
// the callback URL wa-notify posts the owner's reply back to; set SITE_URL
// instead for local dev where `URL` isn't set.
function callbackUrl() {
  const base = process.env.URL || process.env.SITE_URL;
  if (!base) throw new Error('No public base URL available (set SITE_URL) - cannot build a callback URL');
  return `${base.replace(/\/$/, '')}/.netlify/functions/wa-reply-callback`;
}

async function notifyOwner(text, refId) {
  const base = process.env.WA_NOTIFY_BASE_URL;
  if (!base) throw new Error('WA_NOTIFY_BASE_URL not configured');
  const res = await fetch(`${base.replace(/\/$/, '')}/api/external-approval/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-external-token': process.env.WA_NOTIFY_SECRET || '' },
    body: JSON.stringify({ slug: process.env.WA_NOTIFY_SLUG, text, refId, callbackUrl: callbackUrl() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('wa-notify notify failed: ' + JSON.stringify(data));
  return data;
}

module.exports = { notifyOwner };
