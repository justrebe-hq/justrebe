// api/naesp-track.js — Vercel serverless function
//
// Lightweight funnel-event tracker for the NAESP offerings page.
// The product page (/NAESP-product.html) calls this when a visitor clicks
// the "Book a call" button or the "email us" link. We look up who they are
// by the email they gave at the form gate (passed from the page) and apply
// the matching Kit tag so the team can see intent and drive reminders.
//
// It does ONE thing: apply a tag. No Supabase, no email — fast and quiet.
//
// Required env vars (already set in Vercel):
//   KIT_API_KEY, KIT_API_SECRET  (Kit call no-ops if missing)

const { kitSubscribe } = require('./_kit.js');

// Map the event name the page sends -> the exact Kit tag name.
// These names MUST match the tags created in the ReBe Kit exactly.
const EVENT_TAGS = {
  clicked_book:  'NAESP · Clicked Book a Call',
  clicked_email: 'NAESP · Clicked Email',
};

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (_) {
    // Bad payload — nothing to do, but don't make the browser retry.
    return res.status(204).end();
  }

  const email = (body.email || '').trim().toLowerCase();
  const event = (body.event || '').trim();
  const tag = EVENT_TAGS[event];

  // If we can't identify the person or the event, quietly accept and stop.
  // (Someone may have landed on the product page without going through the
  // form gate, so we simply have no email to tag.)
  if (!email || !tag) {
    return res.status(204).end();
  }

  try {
    await kitSubscribe({ email, tags: [tag] });
  } catch (err) {
    console.error('NAESP track tag failed:', err);
    // Still return success to the browser — tracking is best-effort.
  }

  return res.status(204).end();
};
