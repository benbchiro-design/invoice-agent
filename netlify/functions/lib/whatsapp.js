// WhatsApp Business Cloud API (Meta Graph API) - sending messages.
// Requires env vars: WHATSAPP_TOKEN (permanent access token), WHATSAPP_PHONE_NUMBER_ID.
const GRAPH_VERSION = 'v20.0';

// replyToMessageId (optional): makes the outbound message show as a quoted
// reply in WhatsApp, and is how we later match your reply back to it.
async function sendWhatsAppText(to, body, replyToMessageId) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('WhatsApp send failed: ' + JSON.stringify(data));
  return data.messages && data.messages[0] && data.messages[0].id;
}

module.exports = { sendWhatsAppText };
