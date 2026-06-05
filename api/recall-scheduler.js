// ═══════════════════════════════════════════════════════
// RxVerify Recall Notification Scheduler
// Sends reminder emails when patient recall dates approach
//
// Deploy as a Vercel Cron Job:
//   vercel.json → crons: [{ path: "/api/cron/recall", schedule: "0 9 * * *" }]
//
// Or call directly: POST /api/cron/recall
//   (protected by CRON_SECRET header)
//
// Logic:
//   - Runs daily at 09:00 UTC
//   - Sends reminders at: 30 days before, 7 days before, on the due date
//   - Never sends twice (recall_notifications table tracks sent reminders)
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend    = new Resend(process.env.RESEND_API_KEY);
const APP_URL   = process.env.APP_URL || 'https://rxverify.co.uk';

// ── Reminder windows (days before recall due date) ──
const REMINDER_WINDOWS = [
  { days: 30, label: '30-day',  subject_prefix: 'Sight test due in 1 month' },
  { days: 7,  label: '7-day',   subject_prefix: 'Sight test due next week'  },
  { days: 0,  label: 'due-day', subject_prefix: 'Sight test due today'      },
];

// ═══════════════════════════════════════════════════════
// MAIN HANDLER — called by Vercel Cron or directly
// ═══════════════════════════════════════════════════════

async function runRecallScheduler() {
  const results = { sent: 0, skipped: 0, errors: 0, detail: [] };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const window of REMINDER_WINDOWS) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + window.days);
    const targetStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD

    // ── Fetch prescriptions due on targetDate ──
    const { data: prescriptions, error: fetchErr } = await supabase
      .from('prescription_registry')
      .select('short_code, recall_due, contact_hash, prescriber_goc, issued_at, expires_at')
      .eq('recall_due', targetStr)
      .not('contact_hash', 'is', null); // only if we have a contact hash

    if (fetchErr) {
      console.error(`Fetch error for window ${window.label}:`, fetchErr);
      results.errors++;
      continue;
    }

    if (!prescriptions || prescriptions.length === 0) continue;

    for (const rx of prescriptions) {
      try {
        // ── Check if already notified for this window ──
        const { data: existing } = await supabase
          .from('recall_notifications')
          .select('id')
          .eq('short_code', rx.short_code)
          .eq('window_label', window.label)
          .single();

        if (existing) {
          results.skipped++;
          results.detail.push({ short_code: rx.short_code, window: window.label, status: 'already_sent' });
          continue;
        }

        // ── Look up patient email via contact_hash ──
        // contact_hash = SHA-256(lowercase email) — stored at issue time
        // We need the email to send — look it up from recall_contacts table
        // (populated when prescription issued, if patient consented)
        const { data: contact } = await supabase
          .from('recall_contacts')
          .select('email, name, mobile')
          .eq('contact_hash', rx.contact_hash)
          .single();

        if (!contact?.email) {
          results.skipped++;
          results.detail.push({ short_code: rx.short_code, window: window.label, status: 'no_contact' });
          continue;
        }

        // ── Send recall email ──
        const sent = await sendRecallEmail({
          to_email:   contact.email,
          name:       contact.name || 'there',
          short_code: rx.short_code,
          recall_due: rx.recall_due,
          window,
          prescriber_goc: rx.prescriber_goc,
        });

        if (sent) {
          // ── Record notification sent ──
          await supabase.from('recall_notifications').insert({
            short_code:   rx.short_code,
            window_label: window.label,
            sent_at:      new Date().toISOString(),
            to_email:     contact.email,
          });

          results.sent++;
          results.detail.push({ short_code: rx.short_code, window: window.label, status: 'sent', to: contact.email });
          console.log(`Recall sent: ${rx.short_code} → ${contact.email} (${window.label})`);
        } else {
          results.errors++;
          results.detail.push({ short_code: rx.short_code, window: window.label, status: 'send_failed' });
        }

      } catch (err) {
        console.error(`Error processing ${rx.short_code}:`, err.message);
        results.errors++;
        results.detail.push({ short_code: rx.short_code, window: window.label, status: 'error', message: err.message });
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════
// EMAIL TEMPLATE
// ═══════════════════════════════════════════════════════

async function sendRecallEmail({ to_email, name, short_code, recall_due, window, prescriber_goc }) {
  const verifyLink = `${APP_URL}/v/${short_code}`;

  // Format recall date as "12 June 2025"
  let recallDisplay = recall_due;
  try {
    const [y, m, d] = recall_due.split('-');
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    recallDisplay = `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
  } catch(e) {}

  const urgencyColor = window.days === 0 ? '#9b2226' : window.days <= 7 ? '#92600a' : '#005f73';
  const urgencyBg    = window.days === 0 ? 'rgba(155,34,38,0.07)' : window.days <= 7 ? 'rgba(146,96,10,0.07)' : 'rgba(10,147,150,0.07)';
  const urgencyBorder= window.days === 0 ? 'rgba(155,34,38,0.25)' : window.days <= 7 ? 'rgba(146,96,10,0.25)' : 'rgba(10,147,150,0.22)';

  const urgencyMessage = window.days === 0
    ? 'Your sight test is due today. Please book your appointment as soon as possible.'
    : window.days <= 7
    ? `Your sight test is due in ${window.days} days (${recallDisplay}). Please book your appointment this week.`
    : `Your sight test is due in approximately one month (${recallDisplay}). Now is a great time to book.`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1e8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e8;padding:24px 12px;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:white;border:1px solid #d8d4c8;border-radius:4px;max-width:580px;">
  <tr><td style="background:#1a1a2e;padding:22px 28px;">
    <span style="font-family:'Courier New',monospace;font-size:20px;color:#0a9396;">Rx</span><span style="font-family:'Courier New',monospace;font-size:20px;color:white;">Verify</span>
    <p style="margin:4px 0 0;font-family:'Courier New',monospace;font-size:10px;color:#6b7db3;letter-spacing:0.15em;text-transform:uppercase;">Sight Test Reminder</p>
  </td></tr>
  <tr><td style="padding:28px;">
    <p style="margin:0 0 6px;font-size:20px;color:#2d3561;font-weight:600;">Hi ${name},</p>
    <p style="margin:0 0 22px;font-size:14px;color:#8a8070;line-height:1.6;">
      Your optometrist's records show that your next sight test is due.
    </p>

    <table width="100%" style="background:${urgencyBg};border:1px solid ${urgencyBorder};border-radius:3px;margin-bottom:22px;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 4px;font-family:'Courier New',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:${urgencyColor};">📅 Sight Test Reminder</p>
        <p style="margin:0;font-size:14px;color:#1a1a2e;line-height:1.6;">${urgencyMessage}</p>
      </td></tr>
    </table>

    <table width="100%" style="font-family:'Courier New',monospace;font-size:11px;color:#8a8070;margin-bottom:22px;">
      <tr><td style="padding:4px 0;width:180px;">Recall due:</td><td style="color:#1a1a2e;font-weight:600;">${recallDisplay}</td></tr>
      <tr><td style="padding:4px 0;">Prescription ID:</td><td style="color:#1a1a2e;">${short_code}</td></tr>
      <tr><td style="padding:4px 0;">Prescriber GOC:</td><td style="color:#1a1a2e;">${prescriber_goc || '—'}</td></tr>
    </table>

    <p style="margin:0 0 14px;font-size:14px;color:#8a8070;line-height:1.6;">
      Regular sight tests help detect changes in your vision and can identify early signs of conditions such as glaucoma, macular degeneration, and diabetes.
    </p>

    <table cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
      <tr><td style="background:#005f73;border-radius:3px;padding:13px 26px;">
        <a href="${verifyLink}" style="color:white;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;font-weight:600;">View Your Prescription →</a>
      </td></tr>
    </table>

    <hr style="border:none;border-top:1px solid #d8d4c8;margin:20px 0;">
    <p style="margin:0;font-family:'Courier New',monospace;font-size:9px;color:#8a8070;line-height:1.9;">
      You are receiving this because you consented to recall notifications when your prescription was issued.<br>
      To opt out of future reminders, reply to this email with "UNSUBSCRIBE".<br>
      Prescription verified at <a href="${verifyLink}" style="color:#8a8070;">${APP_URL}/v/${short_code}</a>
    </p>
  </td></tr>
  <tr><td style="background:#f4f1e8;padding:18px 28px;border-top:1px solid #d8d4c8;">
    <p style="margin:0;font-family:'Courier New',monospace;font-size:8px;color:#8a8070;line-height:1.9;">
      RxVerify · rxverify.co.uk · Verified prescription platform<br>
      Opticians Act 1989 · UK GDPR compliant recall notifications
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const emailResult = await resend.emails.send({
    from: `${process.env.EMAIL_FROM_NAME || 'RxVerify'} <${process.env.EMAIL_FROM || 'recall@rxverify.co.uk'}>`,
    to: [to_email],
    subject: `${window.subject_prefix} — ${recallDisplay}`,
    html,
  });

  if (emailResult.error) {
    console.error('Resend recall error:', emailResult.error);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════
// EXPRESS ROUTE — add this to your index.js
// ═══════════════════════════════════════════════════════

// POST /api/cron/recall
// Called by Vercel Cron daily at 09:00 UTC
// Protected by CRON_SECRET env var
//
// In vercel.json add:
// {
//   "crons": [{ "path": "/api/cron/recall", "schedule": "0 9 * * *" }]
// }

function recallCronRoute(app) {
  app.post('/api/cron/recall', async (req, res) => {
    // Verify this is called by Vercel Cron (or an authorised admin)
    const secret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    try {
      console.log('Running recall scheduler…');
      const results = await runRecallScheduler();
      console.log('Recall scheduler complete:', results);
      res.json({ success: true, run_at: new Date().toISOString(), ...results });
    } catch (err) {
      console.error('Recall scheduler error:', err);
      res.status(500).json({ error: 'Scheduler error', detail: err.message });
    }
  });

  // GET /api/cron/recall/status — preview who would be notified today (dry run)
  app.get('/api/cron/recall/status', async (req, res) => {
    const secret = req.headers['x-cron-secret'] || req.query.secret;
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const upcoming = [];

    for (const window of REMINDER_WINDOWS) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + window.days);
      const targetStr = targetDate.toISOString().split('T')[0];

      const { data } = await supabase
        .from('prescription_registry')
        .select('short_code, recall_due, contact_hash')
        .eq('recall_due', targetStr)
        .not('contact_hash', 'is', null);

      if (data?.length) {
        upcoming.push({ window: window.label, date: targetStr, count: data.length });
      }
    }

    res.json({ success: true, today: today.toISOString().split('T')[0], upcoming });
  });
}

module.exports = { runRecallScheduler, recallCronRoute };
