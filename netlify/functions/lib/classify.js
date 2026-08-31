// Turns a free-text WhatsApp reply into a structured action, via Claude.
// Requires env var: ANTHROPIC_API_KEY.
const SYSTEM_PROMPT = 'You read a WhatsApp reply from a chiropractic practice owner responding to a draft '
  + 'invoice for one of their patients. Return ONLY JSON: '
  + '{"action":"approve"|"mark_paid"|"no_charge"|"decline"|"unclear","amount":number|null,"method":"Cash"|"Card"|"EFT received"|null}. '
  + '"approve" = confirms as drafted with no explicit payment detail (send as an EFT request). '
  + '"mark_paid" = states or implies payment happened now - extract amount/method if given, else leave null. '
  + '"no_charge" = explicitly no charge, free, or waived. '
  + '"decline" = explicitly no, not yet, wait, or stop. '
  + 'Anything else, or anything ambiguous, is "unclear" - never guess toward sending money or invoices. No other text.';

async function classifyReply(text, invoiceSummary) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Invoice: ${invoiceSummary}\nReply: "${text}"` }],
    }),
  });
  const data = await res.json();
  const raw = (data.content || []).map((b) => b.text || '').join('').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { action: 'unclear' };
  }
}

module.exports = { classifyReply };
