// api/notify.js — Vercel serverless function
//
// Handles two kinds of inbound requests:
//   1. Supabase Database Webhooks (INSERT events) for refresh_signups + confidant_requests
//      Payload shape: { type: 'INSERT', table: '...', record: {...} }
//   2. Direct JS POSTs from the workshop signup flow on reset.html
//      Payload shape: { kind: 'workshop_signup', first_name, last_name, email, phone,
//                       sms_consent, marketing_consent, signup_id }
//
// Sends a confirmation email to the person + a notification email to refresh@justrebe.com
// via Resend, and (if Twilio env vars are set + sms_consent + phone) a confirmation SMS.
//
// Required env vars (set in Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY          — Resend API key (secret)
//   NOTIFY_FROM             — "ReBe ReFresh <refresh@justrebe.com>" (domain must be verified)
//   NOTIFY_ADMIN            — "refresh@justrebe.com"
//   SUPABASE_WEBHOOK_SECRET — optional shared secret on webhook header
//   TWILIO_ACCOUNT_SID      — Twilio account SID (starts with AC…)
//   TWILIO_AUTH_TOKEN       — Twilio auth token
//   TWILIO_FROM_NUMBER      — your Twilio phone number, E.164 format (+15555550100)

const FROM         = process.env.NOTIFY_FROM   || 'ReBe ReFresh <refresh@justrebe.com>';
const ADMIN_EMAIL  = process.env.NOTIFY_ADMIN  || 'refresh@justrebe.com';
const WEBHOOK_KEY  = process.env.SUPABASE_WEBHOOK_SECRET || '';
// Optional — if set, all lead-generation admin emails CC this address too.
// Set to Ashley's email so she gets every form submission directly without
// needing to watch the shared inbox.
const LEAD_NOTIFY_CC = process.env.LEAD_NOTIFY_CC || '';

const { kitSubscribe } = require('./_kit.js');
const { createOpenPhoneContact } = require('./_openphone.js');

// Split a "First Last" or "First Middle Last" string into firstName + lastName.
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Fire-and-forget helper — pushes contact into Ashley's OpenPhone workspace.
// Logs failures, never throws (so OpenPhone hiccups don't break the email flow).
function pushToOpenPhone(args, sourceLabel) {
  return createOpenPhoneContact({ ...args, source: sourceLabel })
    .catch((e) => console.error(`OpenPhone (${sourceLabel}):`, e));
}

// ---------- Tag plan ----------
// Maps the cohort readiness option to the Kit tag suffix used in
// "Cohort · {time} · {label}" tag names.
const COHORT_READINESS_LABEL = {
  ready_to_pay:      'Ready to Pay',
  waitlist:          'Waitlist',
  wants_more_info:   'Wants Info',
};

// Map preferred_group_time row value → tag slot label.
function cohortSlotLabel(preferred_group_time) {
  if (preferred_group_time === 'Tuesdays at 8 PM ET') return '8 PM';
  return '11 AM'; // default for legacy rows / unknown
}

function firstNameFromFull(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0] || '';
}

// ---------- Resend (email) ----------
async function sendEmail({ to, subject, text, cc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY');
  const body = { from: FROM, to, subject, text };
  if (cc) body.cc = cc;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Resend ${r.status}: ${detail}`);
  }
  return r.json();
}

// Branded HTML welcome email sent to a cohort participant after they
// complete the intake form on /thank-you-cohort. Picks the right Zoom
// link based on the slot they chose at Stripe Checkout.
async function sendCohortWelcomeEmail({ toEmail, firstName, slotChoice }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('cohort-welcome: RESEND_API_KEY not set, skipping');
    return;
  }
  const fromAddr = FROM || 'ReBe ReFresh <refresh@justrebe.com>';

  const slotLower = String(slotChoice || '').toLowerCase();
  const isEightPm  = slotLower.includes('8');
  const isElevenAm = slotLower.includes('11');
  const ZOOM_11AM = 'https://us06web.zoom.us/j/88554567062';
  const ZOOM_8PM  = 'https://us06web.zoom.us/j/81155916766';

  let slotLabel, zoomBlock, plainZoom;
  if (isEightPm && !isElevenAm) {
    slotLabel = 'Tuesdays · 8 PM Eastern';
    plainZoom = ZOOM_8PM;
    zoomBlock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4FAEF;border:1px solid #cfe6d0;border-radius:14px;padding:22px 24px;margin:24px 0;text-align:center;"><tr><td><p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#3A8438;">Your Zoom — 8 PM Eastern</p><p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:#4A535E;line-height:1.5;">Save this link — it's the same every Tuesday for all 5 weeks.</p><a href="${ZOOM_8PM}" style="display:inline-block;padding:14px 28px;background:#3A8438;color:#FFFFFF;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;border-radius:999px;">Join Zoom →</a><p style="margin:14px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#9DA1A8;word-break:break-all;">${ZOOM_8PM}</p></td></tr></table>`;
  } else if (isElevenAm && !isEightPm) {
    slotLabel = 'Tuesdays · 11 AM Eastern';
    plainZoom = ZOOM_11AM;
    zoomBlock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4FAEF;border:1px solid #cfe6d0;border-radius:14px;padding:22px 24px;margin:24px 0;text-align:center;"><tr><td><p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#3A8438;">Your Zoom — 11 AM Eastern</p><p style="margin:0 0 14px;font-family:Georgia,serif;font-size:15px;color:#4A535E;line-height:1.5;">Save this link — it's the same every Tuesday for all 5 weeks.</p><a href="${ZOOM_11AM}" style="display:inline-block;padding:14px 28px;background:#3A8438;color:#FFFFFF;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;border-radius:999px;">Join Zoom →</a><p style="margin:14px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#9DA1A8;word-break:break-all;">${ZOOM_11AM}</p></td></tr></table>`;
  } else {
    slotLabel = 'Tuesdays · pick the slot that fits your schedule';
    plainZoom = `11 AM ET: ${ZOOM_11AM}\n8 PM ET: ${ZOOM_8PM}`;
    zoomBlock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4FAEF;border:1px solid #cfe6d0;border-radius:14px;padding:22px 24px;margin:24px 0;text-align:center;"><tr><td><p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#3A8438;">Your Zoom links</p><p style="margin:0 0 14px;font-family:Georgia,serif;font-size:14px;color:#4A535E;line-height:1.5;">Pick whichever Tuesday slot fits you — same link every week for that slot.</p><p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:13px;color:#060B50;"><strong>11 AM Eastern:</strong> <a href="${ZOOM_11AM}" style="color:#3A8438;font-weight:700;">${ZOOM_11AM}</a></p><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#060B50;"><strong>8 PM Eastern:</strong> <a href="${ZOOM_8PM}" style="color:#3A8438;font-weight:700;">${ZOOM_8PM}</a></p></td></tr></table>`;
  }

  const greeting = firstName ? `Hi ${firstName},` : 'Hi friend,';

  const html =
`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAF9F7;padding:32px 12px;font-family:Georgia,'Times New Roman',serif;color:#4A535E;line-height:1.6;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:14px;border:1px solid #E2E2E2;overflow:hidden;">
<tr><td style="padding:36px 36px 8px;">
<p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#3A8438;">Welcome to ReBe ReFresh</p>
<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-weight:600;font-size:30px;line-height:1.2;color:#060B50;">You're in.</h1>
</td></tr>
<tr><td style="padding:8px 36px 12px;font-size:16px;line-height:1.7;">
<p style="margin:0 0 18px;">${greeting}</p>
<p style="margin:0 0 18px;">Thank you for joining the first ReBe ReFresh cohort. We're so glad you're here.</p>
<p style="margin:0 0 18px;">Below is your Zoom link for our weekly sessions. Save it — it's the same link every Tuesday for all 5 weeks.</p>
<p style="margin:0 0 18px;"><strong style="color:#060B50;">Schedule:</strong> ${slotLabel}<br><strong style="color:#060B50;">First session:</strong> Tuesday, June 23</p>
</td></tr>
<tr><td style="padding:0 36px;">${zoomBlock}</td></tr>
<tr><td style="padding:8px 36px 12px;font-size:16px;line-height:1.7;">
<p style="margin:0 0 18px;">In the next few days you'll get a follow-up from Elizabeth with what to bring (mostly: yourself) and a few thoughts to settle into before we begin.</p>
<p style="margin:0 0 6px;">If you have any questions, just reply to this email.</p>
</td></tr>
<tr><td style="padding:20px 36px 36px;font-size:16px;line-height:1.7;border-top:1px solid #E2E2E2;">
<p style="margin:18px 0 4px;">With love,</p>
<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px;color:#060B50;">Elizabeth &amp; the ReBe team</p>
</td></tr>
<tr><td style="padding:20px 24px;background:#FAF9F7;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#9DA1A8;line-height:1.5;border-top:1px solid #E2E2E2;">
ReBe — Rebuilding people from the inside out.<br>
Questions? <a href="mailto:refresh@justrebe.com" style="color:#3A8438;text-decoration:none;font-weight:700;">refresh@justrebe.com</a>
</td></tr>
</table>
</td></tr>
</table>`;

  const text =
`${greeting}

Thank you for joining the first ReBe ReFresh cohort. We're so glad you're here.

Below is your Zoom link for our weekly sessions. Save it — it's the same link every Tuesday for all 5 weeks.

Schedule:    ${slotLabel}
First session: Tuesday, June 23

YOUR ZOOM LINK
${plainZoom}

In the next few days you'll get a follow-up from Elizabeth with what to bring (mostly: yourself) and a few thoughts to settle into before we begin.

If you have any questions, just reply to this email.

With love,
Elizabeth & the ReBe team

—
ReBe · refresh@justrebe.com`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddr,
      to: toEmail,
      reply_to: 'refresh@justrebe.com',
      subject: 'Welcome to the ReBe ReFresh cohort 💛',
      html,
      text,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${detail.slice(0, 300)}`);
  }
  return r.json();
}

// Persist cohort intake responses to refresh_signups so the CRM drawer
// shows them. Up until now this handler only emailed admin + sent the
// welcome email — none of the intake data made it into the database.
//
// Strategy: PATCH the existing refresh_signups row (matched by email,
// which is unique per cohort signup). Writes a structured notes block
// + sets intake_completed=true so dashboards stop showing 'Needs intake'.
async function persistCohortIntakeToDb({ email, name, slot, record, whyList, location }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('persistCohortIntakeToDb: Supabase env not configured, skipping');
    return;
  }

  const r = record || {};
  const blocks = [
    `Location: ${location || '(not given)'}`,
    `Prior ReBe experience: ${r.prior_experience || '(not given)'}`,
    `Why they're joining: ${whyList || '(none selected)'}`,
    `How they heard: ${r.heard_from || '(not given)'}` + (r.referrer ? ` (referred by ${r.referrer})` : ''),
    `Breakout-room preference: ${r.breakout_preference || '(not given)'}`,
    r.notes ? `\nFree-text notes:\n${r.notes}` : '',
  ].filter(Boolean).join('\n');

  const patch = {
    intake_completed: true,
    preferred_group_time: slot && slot !== '(slot unknown)' ? slot : undefined,
    // previous_rebe_experience is BOOLEAN: 'First time' -> false, anything else -> true
    previous_rebe_experience: r.prior_experience
      ? (String(r.prior_experience).trim().toLowerCase() === 'first time' ? false : true)
      : undefined,
    // area_needing_refresh is a free-text column - put their primary 'why' there.
    area_needing_refresh: Array.isArray(r.why_here) && r.why_here.length ? r.why_here.join(', ') : undefined,
    // reason_for_interest holds their freeform note so it's discoverable in the drawer.
    reason_for_interest: (r.notes || '').trim() || undefined,
    notes: blocks,
    // Update phone if the form has one and the existing row doesn't.
    phone: r.phone ? String(r.phone).trim() : undefined,
  };
  // Strip undefined keys so PATCH only updates what we have.
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

  const emailLc = String(email || '').trim().toLowerCase();
  if (!emailLc) return;

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // Try to UPDATE first (the normal case — Stripe webhook created the row).
  const patchResp = await fetch(
    `${url}/rest/v1/refresh_signups?email=ilike.${encodeURIComponent(emailLc)}`,
    { method: 'PATCH', headers, body: JSON.stringify(patch) }
  );
  const patchData = await patchResp.json().catch(() => null);
  if (!patchResp.ok) {
    throw new Error(`persistCohortIntakeToDb PATCH ${patchResp.status}: ${JSON.stringify(patchData).slice(0, 300)}`);
  }
  if (Array.isArray(patchData) && patchData.length > 0) return patchData;

  // No row updated — fall back to INSERT (rare: free intake form or row missing).
  const insertRow = {
    full_name: name || 'Unknown',
    email: emailLc,
    phone: r.phone || '',
    status: 'enrolled',
    readiness: 'ready_to_pay',
    paid_amount_cents: 0,
    audience_type: 'groups',
    group_type: 'no_preference',
    seat_type: 'attendee',
    consent_to_contact: true,
    consent_to_confidentiality: true,
    ...patch,
  };
  const insertResp = await fetch(`${url}/rest/v1/refresh_signups`, {
    method: 'POST',
    headers,
    body: JSON.stringify(insertRow),
  });
  if (!insertResp.ok) {
    const detail = await insertResp.text().catch(() => '');
    throw new Error(`persistCohortIntakeToDb INSERT ${insertResp.status}: ${detail.slice(0, 300)}`);
  }
  return insertResp.json();
}

// ---------- Twilio (SMS) — gracefully no-op if env vars are missing ----------
async function sendSMS({ to, body }) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !auth || !from) {
    console.log('Twilio not configured — skipping SMS for', to);
    return { skipped: true, reason: 'twilio_not_configured' };
  }
  const cleanTo = normalizePhone(to);
  if (!cleanTo) {
    console.log('SMS skipped — invalid phone:', to);
    return { skipped: true, reason: 'invalid_phone' };
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: cleanTo, Body: body }).toString(),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Twilio ${r.status}: ${detail}`);
  }
  return r.json();
}

function normalizePhone(p) {
  if (!p) return null;
  let digits = String(p).replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;            // US default
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(p).startsWith('+')) return String(p);            // already E.164
  return null;
}

function escape(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return String(v);
}

// ---------- Email content builders ----------
function cohortUserMessage(row) {
  const name = row.full_name || 'there';
  const readiness = row.readiness || '';
  const time = row.preferred_group_time || '';
  // Both time slots use the same Zoom link
  const zoomLink = 'https://us06web.zoom.us/j/9057767620';
  // Friendly time-slot summary used in the body of every readiness path
  let timeLine = '';
  if (time === 'Tuesdays at 11 AM ET') {
    timeLine = "Your time slot: Tuesdays at 11 AM Eastern (June 23 – July 21, five weeks).";
  } else if (time === 'Tuesdays at 8 PM ET') {
    timeLine = "Your time slot: Tuesdays at 8 PM Eastern (June 23 – July 21, five weeks).";
  } else if (time) {
    timeLine = `Your time slot: ${time}.`;
  }

  let subject, body;

  if (readiness === 'ready_to_pay') {
    // This email fires on form submission, BEFORE we know whether the
    // person completed Stripe checkout. So it's intentionally path-agnostic:
    // works whether they paid or abandoned at checkout. No Zoom link here —
    // that's sent by the Kit welcome sequence triggered by the
    // "ReBe — Customer (Paid)" tag, which the Stripe webhook applies.
    subject = "We received your ReBe ReFresh enrollment";
    body = `Hi ${name},

Thanks for starting your ReBe ReFresh enrollment.

${timeLine}

✓ If you completed your Stripe payment:
You're all set — your welcome email with the Zoom link and what to expect is on its way to this inbox within the next few minutes.

⏳ If you didn't finish checkout yet:
The next step is paying to lock in your seat. Head back here when you're ready:
https://www.justrebe.com/refresh-cohort

Questions about ReBe ReFresh, the cohort, or anything in between? Just reply to this email and we'll help.

— The ReBe team
refresh@justrebe.com`;
  } else if (readiness === 'waitlist') {
    subject = "You're on the ReBe ReFresh waitlist";
    body = `Hi ${name},

Thank you — you're officially on the waitlist for the next ReBe ReFresh cohort.

${timeLine ? `We've noted your preferred time: ${time}. ` : ''}As soon as the next cohort dates are set (or a seat opens in the current one), we'll reach out with the new dates and how to confirm your seat.

Questions in the meantime? Just reply to this email.

— The ReBe team
refresh@justrebe.com`;
  } else if (readiness === 'wants_more_info') {
    subject = "We'll be in touch about ReBe ReFresh";
    body = `Hi ${name},

Thank you for your interest in ReBe ReFresh. We've received your details and we'll reach out within 48 hours with more about the cohort, what to expect, and how to take the next step when you're ready.

${timeLine}

If you have a specific question in the meantime, just reply to this email.

— The ReBe team
refresh@justrebe.com`;
  } else {
    subject = "We received your ReBe ReFresh enrollment";
    body = `Hi ${name},

Thank you for filling out the ReBe ReFresh enrollment form. We've received your details and we'll be in touch within 48 hours with next steps.

— The ReBe team
refresh@justrebe.com`;
  }

  return { subject, body };
}

function buildCohortEmails(row) {
  const userMsg = cohortUserMessage(row);
  const userText = userMsg.body;

  // Readiness-aware labels so the admin email is unambiguous: a lead form
  // submission with readiness='wants_more_info' is NOT the same as a paid
  // signup (paid signups come through the Stripe webhook, not this function).
  const wantsInfo = row.readiness === 'wants_more_info';
  const waitlist  = row.readiness === 'waitlist';
  const readyPay  = row.readiness === 'ready_to_pay';

  let adminSubject, adminHeader;
  if (wantsInfo) {
    adminSubject = `Cohort lead — wants more info — ${row.full_name || row.email}`;
    adminHeader  = `COHORT LEAD — wants more info\n\nSomeone filled out the lead form on /refresh-cohort and would like more details before committing. This is NOT a paid signup. Please reach out within ~24 hours.`;
  } else if (waitlist) {
    adminSubject = `Cohort waitlist — ${row.full_name || row.email}`;
    adminHeader  = `COHORT WAITLIST REQUEST\n\nSomeone wants to be on the waitlist for the next cohort. This is NOT a paid signup.`;
  } else if (readyPay) {
    adminSubject = `Cohort interest — ready to pay (no payment yet) — ${row.full_name || row.email}`;
    adminHeader  = `COHORT INTEREST — ready to pay\n\nSomeone marked themselves as ready to pay but has not completed Stripe checkout yet. Follow up if they don't pay within 24 hours.`;
  } else {
    adminSubject = `Cohort lead — ${row.full_name || row.email}`;
    adminHeader  = `COHORT LEAD — refresh_signups`;
  }

  const adminText = `${adminHeader}

Name:               ${escape(row.full_name)}
Email:              ${escape(row.email)}
Phone:              ${escape(row.phone)}
Audience:           ${escape(row.audience_type)}
Readiness:          ${escape(row.readiness)}
Preferred time:     ${escape(row.preferred_group_time)}
Group type:         ${escape(row.group_type)}
Area:               ${escape(row.area_needing_refresh)}${row.area_other ? ' / ' + row.area_other : ''}
Reason:             ${escape(row.reason_for_interest)}
Previous experience:${escape(row.previous_rebe_experience)}
Notes:              ${escape(row.notes)}
Organization:       ${escape(row.organization_name)}
Role:               ${escape(row.role_title)}
Referral code:      ${escape(row.referral_code)}
Who referred them:  ${escape(row.who_referred_you)}
Consent to contact: ${escape(row.consent_to_contact)}
Consent (confid.):  ${escape(row.consent_to_confidentiality)}

Row id: ${row.id}`;

  // CC Ashley for both lead types (wants_more_info AND waitlist) since both
  // need human follow-up, not just paid signups.
  const ccAshley = wantsInfo || waitlist;
  return [
    { to: row.email,    subject: userMsg.subject, text: userText },
    { to: ADMIN_EMAIL,  cc: ccAshley ? (LEAD_NOTIFY_CC || undefined) : undefined, subject: adminSubject, text: adminText },
  ];
}

function buildConfidantEmails(row) {
  // Path-agnostic email — fires on form submission, before we know whether
  // the person completed Stripe checkout. Works for both audiences without
  // assuming either. The Kit welcome sequence (triggered by the
  // "ReBe — Customer (Paid)" tag) handles the actual "your confidant will
  // reach out" message for confirmed payers.
  const userText = `Hi ${row.name || 'there'},

Thanks for requesting a private 1:1 session with ${row.preferred_confidant || 'a ReBe confidant'}.

✓ If you completed your Stripe payment:
You're all set. Your confidant will reach out within 48 hours to schedule directly with you.

⏳ If you didn't finish checkout yet:
The next step is paying to lock in your session. Head back here when you're ready:
https://www.justrebe.com/refresh-private.html#request-1on1

Questions about anything? Just reply to this email and we'll help.

— The ReBe team
refresh@justrebe.com`;

  const adminText = `NEW 1:1 REQUEST — confidant_requests

Name:               ${escape(row.name)}
Email:              ${escape(row.email)}
Phone:              ${escape(row.phone)}
Preferred confidant:${escape(row.preferred_confidant)}
Situation:          ${escape(row.situation)}
Best times:         ${escape(row.best_times)}
Status:             ${escape(row.status)}

Row id: ${row.id}`;

  return [
    { to: row.email,    subject: 'We received your ReBe ReFresh 1:1 request', text: userText },
    { to: ADMIN_EMAIL, cc: LEAD_NOTIFY_CC || undefined, subject: `New 1:1 request — ${row.name || row.email}`, text: adminText },
  ];
}

function buildWorkshopEmails(p) {
  const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'there';
  // Two time slots, same Zoom link
  const timeLabel = p.preferred_time === '8pm'
    ? 'Tuesday, June 16 at 8:00 PM Eastern'
    : 'Tuesday, June 16 at 11:00 AM Eastern';
  const subjectTime = p.preferred_time === '8pm' ? '8 PM ET' : '11 AM ET';

  const userText = `Hi ${p.first_name || 'there'},

So glad you said yes. You're in for the ReBe ReFresh free workshop — we can't wait to be in the room with you.

WHAT THIS HOUR IS

A live 60-minute group session on Zoom with the full ReBe team — Elizabeth Good, Dr. Jason Quintal, Beth Rech, Jean Park, Fred Feller, Osil Pistole, and Christophe Dessaigne. An honest hour for adults who are tired in a way that doesn't quite have a name yet — anxious, angry, stressed, lonely, or just not yourself this season.

Together we'll:
  • Notice the story you've been living inside of
  • Name what's actually driving it
  • Practice picturing something different

No slides. No homework. No pressure. Just a small group, the ReBe team, and one quiet hour to do something most adults never do — picture a future worth living.

WHEN & WHERE

When:  ${timeLabel} (60 minutes)
Where: Zoom — https://us06web.zoom.us/j/9057767620

Save the link, add it to your calendar, and come as you are. We'll send one reminder the day before and one about an hour before we start.

Anything come up? Just reply to this email — refresh@justrebe.com will see it.

We're glad you're here.
— The ReBe team`;

  const adminText = `NEW WORKSHOP SIGNUP — reset.html

Name:               ${escape(fullName)}
Email:              ${escape(p.email)}
Phone:              ${escape(p.phone)}
Time slot:          ${escape(timeLabel)}
SMS consent:        ${escape(p.sms_consent)}
Marketing consent:  ${escape(p.marketing_consent)}
Source:             ${escape(p.source)}
Referred by:        ${escape(p.referrer_name)}

Signup id: ${p.signup_id || '—'}`;

  return [
    { to: p.email,     subject: `You're in — ReBe ReFresh workshop, June 16 (${subjectTime})`, text: userText },
    { to: ADMIN_EMAIL, subject: `New workshop signup (${subjectTime}) — ${fullName} (${p.email})`, text: adminText },
  ];
}

function buildWorkshopSMS(p) {
  const name = p.first_name || 'there';
  const timeShort = p.preferred_time === '8pm' ? '8 PM ET' : '11 AM ET';
  return `Hi ${name}! So glad you're in. ReBe ReFresh workshop is Tue June 16, ${timeShort}. Zoom: https://us06web.zoom.us/j/9057767620 Reply STOP to opt out.`;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  // -------- A) Direct workshop signup from reset.html --------
  if (body.kind === 'workshop_signup') {
    if (!body.email) return res.status(400).json({ error: 'Missing email' });
    const messages = buildWorkshopEmails(body);
    const tasks = messages.map((m) => sendEmail(m));

    // Kit tagging
    const slotTag = body.preferred_time === '8pm'
      ? 'Workshop · June 16 · 8 PM ET'
      : 'Workshop · June 16 · 11 AM ET';
    tasks.push(kitSubscribe({
      email: body.email,
      first_name: body.first_name || '',
      tags: ['ReBe — All', 'ReBe — Workshop', slotTag],
    }));

    let smsAttempted = false;
    if (body.sms_consent && body.phone) {
      smsAttempted = true;
      tasks.push(sendSMS({ to: body.phone, body: buildWorkshopSMS(body) }));
    }

    // OpenPhone — add to Ashley's contacts so she can follow up by text.
    // We always push (regardless of sms_consent) because adding a contact is
    // not the same as texting — Ashley decides when/how to reach out.
    if (body.phone) {
      tasks.push(pushToOpenPhone(
        {
          firstName: body.first_name || '',
          lastName: body.last_name || '',
          email: body.email,
          phone: body.phone,
        },
        body.preferred_time === '8pm' ? 'Reset signup · 8 PM ET' : 'Reset signup · 11 AM ET'
      ));
    }

    try {
      const results = await Promise.allSettled(tasks);
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        console.error('Workshop notify partial failure:', failed.map((f) => String(f.reason)));
        return res.status(207).json({
          ok: true,
          sent: results.length - failed.length,
          failed: failed.length,
          details: failed.map((f) => String(f.reason)),
          sms_attempted: smsAttempted,
        });
      }
      return res.status(200).json({ ok: true, sent: results.length, sms_attempted: smsAttempted });
    } catch (err) {
      console.error('Notify error (workshop):', err);
      return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
    }
  }

  // -------- A2) Direct cohort signup from refresh-groups.html --------
  // The form helper calls /api/notify after the Supabase RPC succeeds.
  // body shape: { kind:'cohort_signup', record: { full_name, email, ... } }
  if (body.kind === 'cohort_signup') {
    const row = body.record || {};
    if (!row.email) return res.status(400).json({ error: 'Missing record.email' });
    try {
      const messages = buildCohortEmails(row);
      // Build cohort tags based on readiness + slot
      const tags = ['ReBe — All', 'ReBe — Cohort'];
      const readinessLabel = COHORT_READINESS_LABEL[row.readiness];
      if (readinessLabel) {
        tags.push(`Cohort · ${cohortSlotLabel(row.preferred_group_time)} · ${readinessLabel}`);
      }
      const { firstName, lastName } = splitName(row.full_name);
      await Promise.all([
        ...messages.map(sendEmail),
        kitSubscribe({ email: row.email, first_name: firstNameFromFull(row.full_name), tags })
          .catch((e) => console.error('Kit (cohort_signup):', e)),
        pushToOpenPhone(
          { firstName, lastName, email: row.email, phone: row.phone },
          `Cohort signup · ${cohortSlotLabel(row.preferred_group_time)}`
        ),
      ]);
      return res.status(200).json({ ok: true, sent: messages.length });
    } catch (err) {
      console.error('Notify error (cohort_signup):', err);
      return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
    }
  }

  // -------- A2.25) Cohort intake form — submitted on thank-you-cohort.html after Stripe checkout --------
  // body shape: { kind:'cohort_intake', record: { full_name, email, phone, city, state, country,
  //               cohort_slot, prior_experience, why_here[], heard_from, referrer, breakout_preference, notes } }
  if (body.kind === 'cohort_intake') {
    const r = body.record || {};
    if (!r.email) return res.status(400).json({ error: 'Missing record.email' });
    try {
      const name = (r.full_name || 'Unknown').trim();
      const email = (r.email || '').trim();
      const slot = r.cohort_slot || '(slot unknown)';
      const whyList = Array.isArray(r.why_here) && r.why_here.length ? r.why_here.join(', ') : '(none selected)';
      const location = [r.city, r.state, r.country].filter(Boolean).join(', ') || '(not given)';

      const adminMsg = {
        to: ADMIN_EMAIL,
        subject: `Intake: ${name} — ${slot} cohort`,
        text:
`${name} completed the post-payment intake for the ${slot} cohort.

CONTACT
  Email:   ${email}
  Phone:   ${r.phone || '(not given)'}
  Location: ${location}

PRIOR REBE EXPERIENCE
  ${r.prior_experience || '(not given)'}

WHY THEY'RE JOINING
  ${whyList}

HOW THEY HEARD
  ${r.heard_from || '(not given)'}${r.referrer ? `\n  Referred by: ${r.referrer}` : ''}

BREAKOUT-ROOM PREFERENCE
  ${r.breakout_preference || '(not given)'}

ANYTHING ELSE WE SHOULD KNOW
${r.notes ? r.notes : '(nothing added)'}

— Submitted via /thank-you-cohort intake form`
      };

      // Tag in Kit so segmentation downstream knows they did intake + their reasons
      const tags = ['ReBe — All', 'ReBe — Cohort', 'Cohort Intake Complete'];
      if (slot.indexOf('11 AM') === 0) tags.push('Cohort · 11 AM · Intake');
      if (slot.indexOf('8 PM') === 0) tags.push('Cohort · 8 PM · Intake');

      const { firstName, lastName } = splitName(name);
      await Promise.all([
        sendEmail(adminMsg),
        persistCohortIntakeToDb({ email, name, slot, record: r, whyList, location })
          .catch((e) => console.error('DB persist (cohort_intake):', e)),
        sendCohortWelcomeEmail({ toEmail: email, firstName, slotChoice: slot })
          .catch((e) => console.error('Welcome email (cohort_intake):', e)),
        kitSubscribe({ email, first_name: firstNameFromFull(name), tags })
          .catch((e) => console.error('Kit (cohort_intake):', e)),
        pushToOpenPhone(
          { firstName, lastName, email, phone: r.phone },
          `Cohort intake · ${slot}`
        ),
      ]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Notify error (cohort_intake):', err);
      return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
    }
  }

  // -------- A2.5) BB chat handoff — visitor asked BB to connect them with Ashley --------
  // body shape: { kind:'chat_handoff', record: { name, email, phone?, question, transcript } }
  if (body.kind === 'chat_handoff') {
    const row = body.record || {};
    if (!row.email) return res.status(400).json({ error: 'Missing record.email' });
    try {
      const visitor = (row.name || 'Visitor').trim();
      const email   = (row.email || '').trim();
      const phone   = (row.phone || '').trim();
      const question = (row.question || '(no specific question given)').trim();
      const transcript = String(row.transcript || '').slice(0, 8000);

      // Email to Ashley (admin)
      const adminMsg = {
        to: ADMIN_EMAIL,
        cc: LEAD_NOTIFY_CC || undefined,
        subject: `BB chat handoff: ${visitor} wants to talk`,
        text:
`A visitor on /refresh-cohort asked BB to connect them with you.

NAME:  ${visitor}
EMAIL: ${email}
PHONE: ${phone || '(not given)'}

THEIR QUESTION / WHAT THEY'RE WONDERING:
${question}

------- FULL CHAT TRANSCRIPT -------
${transcript || '(no transcript captured)'}
------------------------------------

Reply directly to ${email} — they're expecting to hear from you within 24 hours.

— ReBe`
      };

      // Confirmation email to the visitor
      const visitorMsg = {
        to: email,
        subject: 'You\'re connected with Ashley — ReBe ReFresh',
        text:
`Hi ${firstNameFromFull(visitor) || 'there'},

Thanks for asking BB to put us in touch. Ashley — one of our ReBe confidants — will reach out to you within 24 hours (usually faster) to answer your question and help you decide whether the cohort is the right fit.

If anything comes up in the meantime, just reply to this email.

Warmly,
The ReBe team
refresh@justrebe.com`
      };

      const tags = ['ReBe — All', 'ReBe — Cohort', 'BB Chat Handoff'];
      const { firstName, lastName } = splitName(visitor);
      await Promise.all([
        sendEmail(adminMsg),
        sendEmail(visitorMsg),
        kitSubscribe({ email, first_name: firstNameFromFull(visitor), tags })
          .catch((e) => console.error('Kit (chat_handoff):', e)),
        pushToOpenPhone({ firstName, lastName, email, phone }, 'BB Chat Handoff'),
      ]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Notify error (chat_handoff):', err);
      return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
    }
  }

  // -------- Cohort survey backup (pre + post) --------
  // body shape: { kind:'survey_pre' | 'survey_post', record: { full_name, email,
  //   cohort_id, perspective_score, perspective_comment, connection_score,
  //   connection_comment, hope_score, hope_comment } }
  // The actual data already lives in cohort_surveys (inserted client-side from
  // the survey page). This handler just emails a paper-trail copy to admin
  // so Osil has a backup outside the database she can search/forward.
  if (body.kind === 'survey_pre' || body.kind === 'survey_post') {
    const r = body.record || {};
    if (!r.email) return res.status(400).json({ error: 'Missing record.email' });
    try {
      const isPost = body.kind === 'survey_post';
      const which = isPost ? 'POST' : 'PRE';
      // Yes/No answers land in the *_comment columns. The pre and post surveys
      // ask differently worded versions of the same three questions — print
      // whichever set was actually answered so the email isn't misleading.
      const QUESTIONS = isPost ? [
        ['PERSPECTIVE',          'Have you reframed any aspects of your perspective on your life?',                         r.perspective_comment],
        ['COMMUNITY CONNECTION', 'Do you feel more comfortable and connected in your community of friends and co-workers?', r.connection_comment],
        ['HOPE',                 'Do you feel more hopeful?',                                                              r.hope_comment],
      ] : [
        ['PERSPECTIVE',          'Do you see a need to reframe any aspects of your perspective on your life?',                               r.perspective_comment],
        ['COMMUNITY CONNECTION', 'Are you feeling a bit uncomfortable or somewhat disconnected in your community of friends and co-workers?', r.connection_comment],
        ['HOPE',                 'Would you like to feel more hopeful?',                                                                      r.hope_comment],
      ];
      const rule = '──────────────────────────────────────────────';
      const ans = (txt) => (txt && String(txt).trim()) ? String(txt).trim() : '(no answer)';
      const answerBlocks = QUESTIONS
        .map(([label, q, a], i) => `${rule}\n${i + 1}) ${label}\n${q}\n\n${ans(a)}\n`)
        .join('\n');

      // Testimonial is post-survey only, and optional. Lead with whether it's
      // cleared for public use so quotes never get published by mistake.
      const testimonial = String(r.testimonial || '').trim();
      const shareable = r.testimonial_permission === 'yes';
      let testimonialBlock = '';
      if (testimonial) {
        testimonialBlock = `\n${rule}\nTESTIMONIAL — ${shareable
          ? '✅ OK TO SHARE PUBLICLY (first name + last initial)'
          : '🔒 PRIVATE — DO NOT SHARE'}\n\n${testimonial}\n`;
      } else if (isPost) {
        testimonialBlock = `\n${rule}\nTESTIMONIAL\n\n(none written)\n`;
      }

      const adminMsg = {
        to: ADMIN_EMAIL,
        subject: `Survey · ${which} · ${r.full_name || r.email} · ${r.cohort_id || 'cohort-1'}` +
                 (testimonial && shareable ? ' · ★ testimonial' : ''),
        text:
`${r.full_name || '(no name)'} submitted the ${which} survey for ${r.cohort_id || 'cohort-1'}.

CONTACT
  Name:  ${r.full_name || '(no name)'}
  Email: ${r.email}

${answerBlocks}${testimonialBlock}
${rule}
— Saved to cohort_surveys table. This email is a backup copy.`,
      };
      await sendEmail(adminMsg);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Notify error (survey):', err);
      // Soft-fail: the survey already saved to DB. Don't block the user UI on
      // this email backup. Return 200 anyway so the page treats it as success.
      return res.status(200).json({ ok: true, warning: 'Email backup failed; row saved to DB' });
    }
  }

  // -------- A3) Direct 1:1 request from refresh-private.html / refresh-groups.html --------
  // body shape: { kind:'confidant_request', record: { name, email, ... } }
  if (body.kind === 'confidant_request') {
    const row = body.record || {};
    if (!row.email) return res.status(400).json({ error: 'Missing record.email' });
    try {
      const messages = buildConfidantEmails(row);
      // Tag based on which confidant they asked for (or "Any" if none)
      const confidant = (row.preferred_confidant && row.preferred_confidant.trim()) || 'Any (Choose for me)';
      const tags = ['ReBe — All', 'ReBe — 1:1 Interest', `1:1 · ${confidant}`];
      const { firstName, lastName } = splitName(row.name);
      await Promise.all([
        ...messages.map(sendEmail),
        kitSubscribe({ email: row.email, first_name: firstNameFromFull(row.name), tags })
          .catch((e) => console.error('Kit (confidant_request):', e)),
        pushToOpenPhone(
          { firstName, lastName, email: row.email, phone: row.phone },
          `1:1 request · ${confidant}`
        ),
      ]);
      return res.status(200).json({ ok: true, sent: messages.length });
    } catch (err) {
      console.error('Notify error (confidant_request):', err);
      return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
    }
  }

  // -------- B) Supabase webhook --------
  if (WEBHOOK_KEY) {
    const provided = req.headers['x-webhook-secret'] || req.headers['x-supabase-webhook-secret'] || '';
    if (provided !== WEBHOOK_KEY) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (body.type !== 'INSERT' || !body.record) {
    return res.status(200).json({ ok: true, skipped: 'not an insert' });
  }

  let messages;
  if (body.table === 'refresh_signups')           messages = buildCohortEmails(body.record);
  else if (body.table === 'confidant_requests')   messages = buildConfidantEmails(body.record);
  else return res.status(200).json({ ok: true, skipped: `unhandled table: ${body.table}` });

  try {
    await Promise.all(messages.map(sendEmail));
    return res.status(200).json({ ok: true, sent: messages.length });
  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ error: 'Email send failed', detail: String(err && err.message || err) });
  }
};
