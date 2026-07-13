// api/_email.js — HTML email template for all NAESP notifications
//
// Renders on-brand HTML alongside the plain-text version we already send.
// Uses table-based layout + inline styles (the only reliable formula across
// Gmail, Apple Mail, Outlook, and every other client that strips <style>).

const LOGO_URL = 'https://www.justrebe.com/Images/rebe-ed-logo.png';
const SITE_URL = 'https://www.justrebe.com';

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const TEAL = '#034E64';
const TEAL_DEEP = '#023d4f';
const PURPLE = '#7D0AAB';
const GOLD = '#FEB909';
const ORANGE = '#F06905';
const INK = '#1A1A1A';
const BODY = '#444';
const MUTED = '#7A8590';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Wrap raw HTML lines (already-formatted) in a paragraph
function p(html, { color = BODY, size = '15px', margin = '0 0 14px' } = {}) {
  return `<p style="margin:${margin};font:400 ${size}/1.65 ${FONT};color:${color};">${html}</p>`;
}

function h(html, opts = {}) {
  const color = opts.color || TEAL;
  const size = opts.size || '28px';
  return `<h1 style="margin:0 0 14px;font:900 ${size}/1.14 ${FONT};color:${color};letter-spacing:-0.02em;">${html}</h1>`;
}

function eyebrow(text, color = PURPLE) {
  return `<p style="margin:0 0 12px;font:800 11px/1.4 ${FONT};color:${color};letter-spacing:0.18em;text-transform:uppercase;">${esc(text)}</p>`;
}

function callout(html, { bg = '#F5F9FC', border = '#E4EDF0', accent = TEAL } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;"><tr><td style="padding:16px 20px;background:${bg};border:1px solid ${border};border-left:4px solid ${accent};border-radius:8px;font:400 14px/1.65 ${FONT};color:${INK};">${html}</td></tr></table>`;
}

function button(text, href, color = ORANGE) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;"><tr><td style="background:${color};border-radius:999px;box-shadow:0 8px 22px rgba(240,105,5,0.32);"><a href="${esc(href)}" style="display:inline-block;padding:15px 30px;color:#fff;font:900 15px/1 ${FONT};text-decoration:none;letter-spacing:0.03em;border-radius:999px;">${esc(text)} &rarr;</a></td></tr></table>`;
}

function detailRows(pairs) {
  const rows = pairs
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([label, value]) =>
      `<tr>
        <td style="padding:5px 14px 5px 0;font:700 11px/1.4 ${FONT};color:${MUTED};letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
        <td style="padding:5px 0;font:400 14px/1.5 ${FONT};color:${INK};vertical-align:top;">${esc(value)}</td>
      </tr>`
    ).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 20px;">${rows}</table>`;
}

function list(items) {
  return `<ul style="margin:0 0 16px;padding:0 0 0 20px;font:400 15px/1.65 ${FONT};color:${BODY};">${items.map((i) => `<li style="margin-bottom:6px;">${i}</li>`).join('')}</ul>`;
}

function divider() {
  return `<div style="border-top:1px solid #EEE;margin:22px 0;"></div>`;
}

// Master template — wraps `body` HTML with header (logo) + footer
function renderEmail({ preheader = '', body = '' }) {
  const preheaderHtml = preheader
    ? `<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;font-size:1px;">${esc(preheader)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReBe Ed</title>
</head>
<body style="margin:0;padding:0;background:#F5F9FC;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased;font-family:${FONT};">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F9FC;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(3,78,100,0.10);">
        <tr>
          <td align="center" style="background:#ffffff;padding:32px 32px 24px;border-bottom:1px solid #F0F3F6;">
            <a href="${SITE_URL}" style="text-decoration:none;">
              <img src="${LOGO_URL}" alt="ReBe Ed &mdash; Better Me. Better We." width="200" style="display:block;height:auto;max-width:200px;border:0;outline:none;">
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 28px;font-family:${FONT};">${body}</td>
        </tr>
        <tr>
          <td style="background:${TEAL_DEEP};padding:24px 32px;text-align:center;">
            <p style="margin:0 0 6px;font:800 12px/1.4 ${FONT};color:${GOLD};letter-spacing:0.16em;text-transform:uppercase;">ReBe Ed &middot; Better Me. Better We.</p>
            <p style="margin:0;font:400 12px/1.5 ${FONT};color:rgba(255,255,255,0.78);">
              <a href="mailto:hello@justrebe.com" style="color:${GOLD};text-decoration:none;font-weight:700;">hello@justrebe.com</a>
              &nbsp;&middot;&nbsp;
              <a href="${SITE_URL}" style="color:${GOLD};text-decoration:none;font-weight:700;">justrebe.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

module.exports = {
  renderEmail,
  esc,
  p,
  h,
  eyebrow,
  callout,
  button,
  detailRows,
  list,
  divider,
};
