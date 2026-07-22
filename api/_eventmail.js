// api/_eventmail.js — ticket confirmation email for ReBe LIVE events.
//
// Sent via Resend from the Stripe webhook after a paid `event` checkout.
// Includes: the details, an Add-to-Calendar link, and shareable
// "invite a friend" links (text + email) — because it's more fun together.
//
// Env: RESEND_API_KEY (required), NOTIFY_FROM (verified sender).

const FROM      = process.env.NOTIFY_FROM || 'ReBe LIVE <refresh@justrebe.com>';
const REPLY_TO  = 'hello@justrebe.com';

// ---- Event facts (single source of truth for the email) ----
const EV = {
  name:    "ReBe LIVE · A Night to Shift",
  tagline: "Ladies' Night Out",
  dateLong:"Thursday, October 8, 2026",
  time:    "6:30 – 9:30 PM",
  venue:   "Passero (our private room)",
  address: "3 S Evergreen Ave, Arlington Heights, IL 60005",
  // 6:30 PM CDT (UTC-5) = 23:30 UTC; 9:30 PM CDT = 02:30 UTC next day.
  startUtc:"20261008T233000Z",
  endUtc:  "20261009T023000Z",
  pageUrl: "https://www.justrebe.com/night-to-shift",
};

const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=' +
  encodeURIComponent('Passero, ' + EV.address);

const CAL_DETAILS =
  "Your seat is reserved for ReBe LIVE's Ladies' Night Out — A Night to Shift, " +
  "featuring Elizabeth Good, hosted by Danielle McLoughlin. We'll be in Passero's private room. " +
  "Includes appetizers, a beverage, great conversation, and one entry into the Grand Prize Raffle.\n\n" +
  EV.pageUrl;

const CAL_URL = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
  '&text='     + encodeURIComponent(EV.name + " — " + EV.tagline) +
  '&dates='    + EV.startUtc + '/' + EV.endUtc +
  '&details='  + encodeURIComponent(CAL_DETAILS) +
  '&location=' + encodeURIComponent('Passero, ' + EV.address);

// Shareable invite — the message a guest forwards to a friend.
const SHARE_MSG =
  "You're invited 💛 Come with me to ReBe LIVE's Ladies' Night Out — \"A Night to Shift\" " +
  "on Thursday, Oct 8 in Arlington Heights. It's more fun together! Grab a ticket: " + EV.pageUrl;
const SMS_URL   = 'sms:?&body=' + encodeURIComponent(SHARE_MSG);
const MAIL_URL  = 'mailto:?subject=' + encodeURIComponent("Come with me — A Night to Shift 🥂") +
                  '&body=' + encodeURIComponent(SHARE_MSG);

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function buildHtml(firstName){
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hi friend,';
  const TEAL='#0C3F50', TEALBG='#12556A', GOLD='#E9A82C', GOLDSOFT='#F5C96B',
        GREEN='#5C8326', INK='#1E2A30', BODY='#4A535E', CREAM='#F3EFE4';
  const serif="Georgia,'Times New Roman',serif", sans="Arial,Helvetica,sans-serif";
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};padding:28px 12px;font-family:${serif};color:${BODY};">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2DDD0;">

  <!-- header on teal -->
  <tr><td style="background:${TEALBG};padding:30px 32px 26px;text-align:center;">
    <p style="margin:0 0 6px;font-family:${sans};font-weight:700;font-size:19px;letter-spacing:.02em;color:${GREEN};">re<span style="color:${GOLD};">&middot;</span>be <span style="color:${GOLDSOFT};font-size:13px;letter-spacing:.14em;">LIVE</span></p>
    <p style="margin:0;font-family:${serif};font-style:italic;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#fff;">${esc(EV.tagline)}</p>
    <p style="margin:8px 0 0;font-family:${serif};font-weight:700;font-size:34px;line-height:1.05;color:#fff;">A Night to Shift</p>
  </td></tr>

  <!-- body -->
  <tr><td style="padding:32px 34px 8px;font-size:16px;line-height:1.7;color:${INK};">
    <p style="margin:0 0 8px;font-family:${sans};font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${GREEN};">You're in 🥂</p>
    <h1 style="margin:0 0 16px;font-family:${serif};font-weight:700;font-size:26px;color:${TEAL};">Your seat is reserved.</h1>
    <p style="margin:0 0 14px;">${hi}</p>
    <p style="margin:0 0 14px;">You're all set for a beautiful night out. Here are the details — and something to make it even more fun below.</p>
  </td></tr>

  <!-- details card -->
  <tr><td style="padding:6px 34px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};border:1px solid #E2DDD0;border-radius:12px;">
      <tr><td style="padding:18px 22px;font-family:${serif};font-size:16px;color:${INK};line-height:1.7;">
        <strong style="color:${TEAL};">${esc(EV.dateLong)}</strong><br>
        ${esc(EV.time)}<br>
        ${esc(EV.venue)}<br>
        <a href="${MAP_URL}" style="color:${GREEN};text-decoration:underline;">${esc(EV.address)} ↗</a>
      </td></tr>
    </table>
  </td></tr>

  <!-- add to calendar -->
  <tr><td align="center" style="padding:20px 34px 6px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:${TEAL};border-radius:999px;">
        <a href="${CAL_URL}" style="display:inline-block;padding:14px 30px;color:#fff;font-family:${sans};font-size:14px;font-weight:700;letter-spacing:.04em;text-decoration:none;border-radius:999px;">📅 Add to your calendar</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- whats included -->
  <tr><td style="padding:14px 34px 6px;font-size:15px;line-height:1.7;color:${BODY};">
    <p style="margin:0 0 6px;font-family:${sans};font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${GOLD};">Your $65 includes</p>
    <p style="margin:0;">Appetizers &middot; a beverage &middot; real, engaging conversation &middot; and one entry into the Grand Prize Raffle (loaded with incredible prizes).</p>
  </td></tr>

  <!-- invite a friend -->
  <tr><td style="padding:22px 34px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4FAEF;border:1px solid #cfe6d0;border-radius:12px;">
      <tr><td style="padding:22px 24px;text-align:center;">
        <p style="margin:0 0 6px;font-family:${serif};font-weight:700;font-size:20px;color:${TEAL};">It's more fun together.</p>
        <p style="margin:0 0 16px;font-family:${serif};font-size:15px;color:${BODY};line-height:1.6;">Know someone who needs this night? Invite a friend — send them the details in one tap.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
          <td style="padding:0 6px;"><a href="${SMS_URL}" style="display:inline-block;padding:12px 22px;background:${GREEN};color:#fff;font-family:${sans};font-size:13px;font-weight:700;letter-spacing:.04em;text-decoration:none;border-radius:999px;">✉️ Text a friend</a></td>
          <td style="padding:0 6px;"><a href="${MAIL_URL}" style="display:inline-block;padding:12px 22px;background:#fff;color:${TEAL};border:1.5px solid ${TEAL};font-family:${sans};font-size:13px;font-weight:700;letter-spacing:.04em;text-decoration:none;border-radius:999px;">Email a friend</a></td>
        </tr></table>
        <p style="margin:14px 0 0;font-family:${sans};font-size:12px;color:#8E9AA1;">Or share this link: <a href="${EV.pageUrl}" style="color:${GREEN};">justrebe.com/night-to-shift</a></p>
      </td></tr>
    </table>
  </td></tr>

  <!-- signoff -->
  <tr><td style="padding:18px 34px 32px;font-size:16px;line-height:1.7;color:${INK};">
    <p style="margin:0 0 4px;">Can't wait to see you there.</p>
    <p style="margin:0;font-family:${serif};font-style:italic;font-size:22px;color:${TEAL};">Danielle &amp; the ReBe team</p>
  </td></tr>

  <!-- footer -->
  <tr><td style="background:${TEAL};padding:20px 24px;text-align:center;font-family:${sans};font-size:12px;color:rgba(243,239,228,.75);line-height:1.6;">
    ReBe — Rebuilding people from the inside out.<br>
    Questions? <a href="mailto:${REPLY_TO}" style="color:${GOLDSOFT};text-decoration:none;font-weight:700;">${REPLY_TO}</a>
  </td></tr>

</table>
</td></tr>
</table>`;
  const doc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#F3EFE4;-webkit-text-size-adjust:100%;">' +
    inner + '</body></html>';
  // Entity-encode decorative characters so they render regardless of the
  // client's assumed charset (some strip UTF-8 in older Outlook/Yahoo).
  return doc
    .replace(/—/g, '&mdash;')
    .replace(/🥂/g, '&#127862;')
    .replace(/📅/g, '&#128197;')
    .replace(/✉️?/g, '&#9993;')
    .replace(/↗/g, '&#8599;');
}

function buildText(firstName){
  const hi = firstName ? `Hi ${firstName},` : 'Hi friend,';
  return `${hi}

You're in — your seat for A Night to Shift is reserved. 🥂

WHEN   ${EV.dateLong}, ${EV.time}
WHERE  ${EV.venue}
       ${EV.address}
       Map: ${MAP_URL}

ADD TO YOUR CALENDAR
${CAL_URL}

YOUR $65 INCLUDES
Appetizers, a beverage, real engaging conversation, and one entry into the Grand Prize Raffle (loaded with incredible prizes).

IT'S MORE FUN TOGETHER — INVITE A FRIEND
Text a friend:  ${SMS_URL}
Email a friend: ${MAIL_URL}
Or share this link: ${EV.pageUrl}

Can't wait to see you there.
Danielle & the ReBe team

ReBe — Rebuilding people from the inside out.
Questions? ${REPLY_TO}`;
}

async function sendEventConfirmation({ to, firstName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('event confirmation: RESEND_API_KEY not set, skipping'); return; }
  if (!to) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to,
      reply_to: REPLY_TO,
      subject: "You're in! 🥂 A Night to Shift — Thu, Oct 8",
      html: buildHtml(firstName),
      text: buildText(firstName),
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Resend ${r.status}: ${detail}`);
  }
  return r.json();
}

module.exports = { sendEventConfirmation };
