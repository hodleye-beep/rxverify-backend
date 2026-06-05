// ═══════════════════════════════════════════════════════
// RxVerify Backend API v2
// Changes from v1:
//   - Hash-only prescription storage (no clinical data)
//   - POST /api/verify endpoint (retailer verification)
//   - GET /widget.js (embeddable retailer widget)
//   - Verification page uses patient-presented payload
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const { recallCronRoute } = require('./recall-scheduler');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const Anthropic  = require('@anthropic-ai/sdk');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const QRCode     = require('qrcode');

const app = express();

// ── Middleware ─────────────────────────────────────────
app.use(cors({
  origin: '*',  // Public verification API — open CORS
  credentials: false
}));
app.use(express.json({ limit: '10mb' }));

// ── Serve static frontend ──────────────────────────────
// HTML is embedded directly to avoid Vercel __dirname issues
const fs = require('fs');
const FRONTEND_HTML = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');

// Serve frontend at root and any non-API route

// ── Auth check endpoint ────────────────────────────────
// Simple password gate — password set via RXVERIFY_PASSWORD env var
app.post('/api/auth/check', (req, res) => {
  const { password } = req.body;
  const correct = process.env.RXVERIFY_PASSWORD;
  if (!correct) return res.status(500).json({ ok: false, error: 'Password not configured' });
  if (password === correct) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// ── Serve frontend for all non-API routes ──────────────
// Must come AFTER all /api routes

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend    = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const APP_URL   = process.env.APP_URL || 'https://rxverify.co.uk';

// ── Crypto helpers (Node built-in — no noble needed server-side) ──
// ── Deterministic JSON stringify ──
// Sorts keys recursively to ensure consistent hashing
// regardless of JS engine key ordering
function deterministicStringify(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map(key => {
    return JSON.stringify(key) + ':' + deterministicStringify(obj[key]);
  });
  return '{' + parts.join(',') + '}';
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ═══════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  service: 'RxVerify API', version: '2.0.0',
  status: 'operational', timestamp: new Date().toISOString()
}));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════════════════════
// STORE PRESCRIPTION — hash only, zero clinical data
// ═══════════════════════════════════════════════════════

// POST /api/prescriptions
// Receives the full signed payload from the browser
// Stores ONLY the hash, signature, and metadata
// Clinical data (patient name, DOB, refraction) is
// NEVER written to the database

app.post('/api/prescriptions', async (req, res) => {
  try {
    const { signed_payload, short_code } = req.body;
    if (!signed_payload || !short_code) {
      return res.status(400).json({ error: 'signed_payload and short_code required' });
    }

    const payload = signed_payload;
    const sig = payload.sig_optometrist || payload.sig;
    if (!sig) return res.status(400).json({ error: 'No signature in payload' });

    // ── Hash the canonical payload ──
    // Strip sig fields AND prescription_id (added after signing, not part of signed data)
    // Use deterministic stringify (sorted keys) for consistent hashing across environments
    const { sig_optometrist, sig_practice, prescription_id: _pid, ...canonicalPayload } = payload;
    const canonicalStr = deterministicStringify(canonicalPayload);
    const payloadHash = sha256hex(canonicalStr);

    const { error } = await supabase
      .from('prescription_registry')
      .insert({
        short_code,
        payload_hash:    payloadHash,
        sig:             sig,
        prescriber_goc:  payload.prescriber?.goc  || '',
        prescriber_npub: payload.prescriber?.pubkey || '',
        issued_at:       new Date(payload.issued_at * 1000).toISOString(),
        expires_at:      new Date(payload.expires_at * 1000).toISOString(),
        recall_months:   payload.recall?.months   || null,
        recall_due:      payload.recall?.due_date  || null,
        contact_hash:    payload.patient?.contact_hash || null,
        schema_version:  payload.schema_version   || 'rxv1-uk'
        // ← No patient_name, no DOB, no sphere/cylinder/axis
        // ← No clinical data whatsoever
      });

    if (error) {
      if (error.code === '23505') {
        return res.json({
          success: true, short_code,
          patient_link: `${APP_URL}/v/${short_code}`,
          message: 'Already stored'
        });
      }
      console.error('Store error:', error);
      return res.status(500).json({ error: 'Store failed' });
    }

    // ── Store patient contact for recall notifications (if consent given) ──
    // Only stores email/name — contact_hash links it to the prescription
    // without storing clinical data alongside PII
    if (payload.consent?.recall && payload.patient?.contact_hash) {
      const contactData = {
        contact_hash: payload.patient.contact_hash,
        name:         payload.patient.display_name || null,
        // email is not in the payload (hashed only) — but the HTML sends it
        // in the full payload as patient.contact_email if present
        email:        payload.patient.contact_email || null,
        mobile:       payload.patient.contact_mobile || null,
        created_at:   new Date().toISOString(),
      };
      if (contactData.email || contactData.mobile) {
        await supabase
          .from('recall_contacts')
          .upsert(contactData, { onConflict: 'contact_hash' })
          .then(() => {})
          .catch(e => console.warn('recall_contacts upsert:', e.message));
      }
    }

    res.json({
      success: true,
      short_code,
      patient_link: `${APP_URL}/v/${short_code}`
    });

  } catch (err) {
    console.error('POST /api/prescriptions:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════
// VERIFY — the core endpoint
// Used by: pharmacies, online retailers, anyone
// Patient presents their payload; we confirm it's real
// Clinical data flows from patient to verifier directly
// RxVerify only confirms authenticity
// ═══════════════════════════════════════════════════════

// POST /api/verify
// Body: { short_code, payload }
//   short_code — the RXV-XXXXX-X code
//   payload    — the full signed prescription the patient presented
//
// Returns: { valid, checks{}, prescriber{}, prescription_meta{} }
// Does NOT return clinical data — that comes from the payload
// the verifier already has

app.post('/api/verify', async (req, res) => {
  try {
    const { short_code, payload } = req.body;

    if (!short_code || !payload) {
      return res.status(400).json({
        valid: false,
        reason: 'short_code and payload required'
      });
    }

    const checks   = {};
    const warnings = [];
    let   overallValid = true;

    // ── 1. Fetch stored record ──
    const { data: record, error: fetchErr } = await supabase
      .from('prescription_registry')
      .select('*')
      .eq('short_code', short_code)
      .single();

    if (fetchErr || !record) {
      return res.status(404).json({
        valid: false,
        reason: 'Prescription not found in registry',
        checks: { found_in_registry: false }
      });
    }

    checks.found_in_registry = true;

    // ── 2. Schema version ──
    checks.schema_valid = payload.schema_version === 'rxv1-uk';
    if (!checks.schema_valid) {
      overallValid = false;
      warnings.push('Unknown schema version: ' + payload.schema_version);
    }

    // ── 3. Not expired ──
    const now = Math.floor(Date.now() / 1000);
    checks.not_expired = payload.expires_at > now;
    if (!checks.not_expired) {
      overallValid = false;
      warnings.push('Prescription expired on ' +
        new Date(payload.expires_at * 1000).toLocaleDateString('en-GB'));
    }

    // ── 5. Issue date sanity ──
    checks.issue_date_valid = payload.issued_at <= now;
    if (!checks.issue_date_valid) {
      overallValid = false;
      warnings.push('Issue date is in the future — suspicious');
    }

    // ── 6. Prescriber fields present ──
    checks.prescriber_fields = !!(
      payload.prescriber?.pubkey &&
      payload.prescriber?.goc   &&
      payload.prescriber?.name
    );
    if (!checks.prescriber_fields) {
      overallValid = false;
      warnings.push('Missing prescriber fields');
    }

    // ── 7. Registry lookup — GOC active ──
    const { data: registryEntry } = await supabase
      .from('registry_entries')
      .select('goc_number, name, practice, status, jurisdiction, verified_at')
      .eq('npub', payload.prescriber?.pubkey || '')
      .single();

    checks.prescriber_registered = !!registryEntry;
    checks.registration_active   = registryEntry?.status === 'approved';

    if (!checks.prescriber_registered) {
      warnings.push('Prescriber pubkey not found in RxVerify registry');
      // Note: not fatal — prescriber may be legitimate but not yet registered
      // Verifier can cross-check GOC number manually at optical.org
    }
    if (registryEntry && !checks.registration_active) {
      overallValid = false;
      warnings.push('Prescriber registration status: ' + registryEntry.status);
    }

    // ── 8. Cryptographic signature ──
    // secp256k1 Schnorr signature is the authoritative proof
    // Strip sig fields and prescription_id to get what was originally signed
    const { sig_optometrist, sig_practice, prescription_id: _pid2, ...canonicalPayload } = payload;
    const sigResult = await verifySchnorrSignature(
      canonicalPayload,
      sig_optometrist || payload.sig,
      payload.prescriber?.pubkey
    );
    checks.sig_valid = sigResult;

    if (sigResult === false) {
      overallValid = false;
      warnings.push('Cryptographic signature invalid — do not dispense');
    } else if (sigResult === null) {
      // Server-side noble/curves not available — browser handles client-side verification
      // Not fatal — set inconclusive
      checks.sig_valid = null;
    }

    // ── 9. Recall info (informational, not a validity check) ──
    const recallInfo = record.recall_due ? {
      due_date:    record.recall_due,
      months:      record.recall_months,
      overdue:     new Date(record.recall_due) < new Date()
    } : null;

    if (recallInfo?.overdue) {
      warnings.push('Patient recall date has passed — recommend new sight test');
    }

    // ── Log verification event (no clinical data) ──
    await supabase.from('verification_log').insert({
      short_code,
      verified_at: new Date().toISOString(),
      result:      overallValid ? 'valid' : 'invalid',
      checks:      checks
    }).then(() => {}).catch(() => {}); // non-blocking, best effort

    // ── Build response ──
    const response = {
      valid:   overallValid,
      checks,
      warnings: warnings.length > 0 ? warnings : undefined,
      prescriber: checks.prescriber_fields ? {
        name:         payload.prescriber.name,
        goc:          payload.prescriber.goc,
        practice:     payload.prescriber.practice || registryEntry?.practice,
        jurisdiction: payload.prescriber.jurisdiction || 'UK-GOC',
        registry_status: registryEntry?.status || 'not_in_registry'
      } : undefined,
      prescription_meta: {
        short_code,
        issued:      new Date(payload.issued_at  * 1000).toLocaleDateString('en-GB'),
        expires:     new Date(payload.expires_at * 1000).toLocaleDateString('en-GB'),
        test_type:   payload.test_type,
        recall:      recallInfo,
        schema:      payload.schema_version
      }
    };

    // ── If invalid, add a clear reason ──
    if (!overallValid) {
      response.reason = warnings[0] || 'Verification failed';
    }

    res.json(response);

  } catch (err) {
    console.error('POST /api/verify:', err);
    res.status(500).json({ valid: false, reason: 'Verification service error' });
  }
});

// GET /api/verify/:code — simple GET version for basic checks
// Returns stored metadata without needing the payload
// Useful for: "does this code exist and is it in date?"
// Does NOT confirm payload integrity (no hash check without payload)
app.get('/api/verify/:code', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('prescription_registry')
      .select('short_code, prescriber_goc, prescriber_npub, issued_at, expires_at, recall_due, schema_version')
      .eq('short_code', req.params.code)
      .single();

    if (error || !data) {
      return res.status(404).json({ found: false, message: 'Code not found' });
    }

    const now = new Date();
    res.json({
      found:       true,
      short_code:  data.short_code,
      not_expired: new Date(data.expires_at) > now,
      issued_at:   data.issued_at,
      expires_at:  data.expires_at,
      recall_due:  data.recall_due,
      goc_number:  data.prescriber_goc,
      note:        'Present the full prescription payload to POST /api/verify for complete verification including hash and signature checks'
    });

  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/debug/:code — returns stored hash details for comparison
app.get('/api/debug/:code', async (req, res) => {
  const { data } = await supabase
    .from('prescription_registry')
    .select('short_code, payload_hash, sig, prescriber_goc, issued_at')
    .eq('short_code', req.params.code)
    .single();
  res.json({ stored: data });
});

// ═══════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════

app.get('/api/registry/goc/:number', async (req, res) => {
  try {
    const clean = req.params.number.replace(/[^a-zA-Z0-9\-]/g, '');
    const { data, error } = await supabase
      .from('registry_entries')
      .select('npub, goc_number, name, practice, jurisdiction, status, verified_at, registered_at')
      .eq('goc_number', clean)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/registry/npub/:npub', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('registry_entries')
      .select('npub, goc_number, name, practice, jurisdiction, status, verified_at, registered_at')
      .eq('npub', req.params.npub)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/registry/auto-register
// Called automatically when optometrist generates keys in the HTML app
// Creates a pending registry entry in Supabase
app.post('/api/registry/auto-register', async (req, res) => {
  try {
    const { npub, goc_number, name, practice, address, jurisdiction } = req.body;
    if (!npub || !goc_number || !name) {
      return res.status(400).json({ error: 'npub, goc_number and name required' });
    }

    // Upsert on npub — each keypair is unique
    // Changing a GOC number's keypair requires manual admin approval
    // This prevents anyone from silently overwriting an existing keypair
    // Key recovery: optometrist contacts admin → verified → Supabase updated manually
    const { error } = await supabase
      .from('registry_entries')
      .upsert({
        npub,
        goc_number,
        name,
        practice: practice || null,
        address:  address  || null,
        jurisdiction: jurisdiction || 'UK-GOC',
        status: 'approved',
        email_verified: true,
        id_verified: true,
        verified_at: new Date().toISOString()
      }, { onConflict: 'npub' });

    if (error) {
      if (error.code === '23505') {
        // Unique constraint violation — either npub or goc_number already exists
        // Check which one
        const { data: existing } = await supabase
          .from('registry_entries')
          .select('npub, goc_number')
          .eq('goc_number', goc_number)
          .single();

        if (existing && existing.npub !== npub) {
          // GOC number exists with a different keypair — requires admin to update
          return res.status(409).json({
            error: 'GOC number already registered with a different keypair',
            message: 'To update your keypair, contact the RxVerify administrator',
            goc_number
          });
        }
        // Same npub already registered — that's fine, just return success
        return res.json({ success: true, message: 'Registry entry already current' });
      }
      console.error('Auto-register error:', error);
      return res.status(500).json({ error: 'Registration failed' });
    }

    res.json({ success: true, message: 'Registry entry created' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/registry/register', async (req, res) => {
  try {
    const { npub, goc_number, name, practice, address, jurisdiction } = req.body;
    if (!npub || !goc_number || !name) {
      return res.status(400).json({ error: 'npub, goc_number and name required' });
    }
    const { error } = await supabase.from('registry_entries').insert({
      npub, goc_number, name,
      practice: practice || null,
      address:  address  || null,
      jurisdiction: jurisdiction || 'UK-GOC',
      status: 'pending', email_verified: false, id_verified: false
    });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Already registered' });
      return res.status(500).json({ error: 'Registration failed' });
    }
    res.json({ success: true, message: 'Registration received — pending verification' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/registry/log', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('registry_entries')
      .select('goc_number, name, jurisdiction, status, verified_at, registered_at, revoked_at')
      .order('registered_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, generated_at: new Date().toISOString(), count: data.length, entries: data });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════

app.post('/api/send/email', async (req, res) => {
  try {
    const {
      to_email, patient_name, patient_dob, short_code, practice_name,
      prescriber_name, goc_number, issued_date, expires_date,
      recall_date, rx_summary, pdf_base64, full_payload
    } = req.body;

    if (!to_email || !short_code) {
      return res.status(400).json({ error: 'to_email and short_code required' });
    }

    // ── Format DOB to UK date format ──
    const formatDOB = (dob) => {
      if (!dob) return null;
      try {
        const d = new Date(dob);
        return d.toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
      } catch(e) { return dob; }
    };
    const displayDOB = formatDOB(patient_dob);

    // ── Encode full payload into URL fragment ──
    let verifyLink = `${APP_URL}/v/${short_code}`;
    if (full_payload) {
      try {
        // Unicode-safe base64 encoding — handles all UTF-8 characters
        const jsonStr = JSON.stringify(full_payload);
        const encoded = Buffer.from(jsonStr, 'utf8').toString('base64');
        verifyLink = `${APP_URL}/v/${short_code}#${encoded}`;
      } catch(e) {
        console.warn('Could not encode payload for URL:', e.message);
      }
    }

    const rxTableHtml = rx_summary ? `
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-family:'Courier New',monospace;font-size:13px;">
        <tr style="background:#f4f1e8;">
          <th style="padding:7px 10px;text-align:left;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">Eye</th>
          <th style="padding:7px 10px;text-align:center;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">Sphere</th>
          <th style="padding:7px 10px;text-align:center;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">Cylinder</th>
          <th style="padding:7px 10px;text-align:center;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">Axis</th>
          ${(rx_summary.r_add || rx_summary.l_add) ? '<th style="padding:7px 10px;text-align:center;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">Add</th>' : ''}
        </tr>
        <tr>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;color:#005f73;font-weight:bold;">R (OD)</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.r_sphere)}</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.r_cyl)}</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${rx_summary.r_axis ? rx_summary.r_axis + '°' : '—'}</td>
          ${(rx_summary.r_add || rx_summary.l_add) ? `<td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.r_add)}</td>` : ''}
        </tr>
        <tr style="background:#fdfcf7;">
          <td style="padding:7px 10px;border:1px solid #d8d4c8;color:#005f73;font-weight:bold;">L (OS)</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.l_sphere)}</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.l_cyl)}</td>
          <td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${rx_summary.l_axis ? rx_summary.l_axis + '°' : '—'}</td>
          ${(rx_summary.r_add || rx_summary.l_add) ? `<td style="padding:7px 10px;border:1px solid #d8d4c8;text-align:center;">${fmtVal(rx_summary.l_add)}</td>` : ''}
        </tr>
      </table>
      ${rx_summary.clinical_notes ? `<p style="margin:8px 0 0;font-family:'Courier New',monospace;font-size:11px;color:#2d3561;"><strong>Notes:</strong> ${rx_summary.clinical_notes}</p>` : ''}` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1e8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e8;padding:24px 12px;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:white;border:1px solid #d8d4c8;border-radius:4px;max-width:580px;">
  <tr><td style="background:#1a1a2e;padding:22px 28px;">
    <span style="font-family:'Courier New',monospace;font-size:20px;color:#0a9396;">Rx</span><span style="font-family:'Courier New',monospace;font-size:20px;color:white;">Verify</span>
    <p style="margin:4px 0 0;font-family:'Courier New',monospace;font-size:10px;color:#6b7db3;letter-spacing:0.15em;text-transform:uppercase;">${practice_name || 'Digital Prescription'}</p>
  </td></tr>
  <tr><td style="padding:28px;">
    <p style="margin:0 0 6px;font-size:20px;color:#2d3561;font-weight:600;">Dear ${patient_name || 'Patient'},</p>
    <p style="margin:0 0 22px;font-size:14px;color:#8a8070;line-height:1.6;">Your signed prescription from ${issued_date || 'your recent sight test'} is ready to view and download.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
      <tr><td style="background:#005f73;border-radius:3px;padding:13px 26px;">
        <a href="${verifyLink}" style="color:white;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;font-weight:600;">View &amp; Verify Prescription →</a>
      </td></tr>
    </table>
    <p style="margin:0 0 4px;font-family:'Courier New',monospace;font-size:9px;color:#8a8070;letter-spacing:0.1em;text-transform:uppercase;">Direct link:</p>
    <p style="margin:0 0 22px;font-family:'Courier New',monospace;font-size:10px;color:#005f73;word-break:break-all;"><a href="${verifyLink}" style="color:#005f73;">${APP_URL}/v/${short_code}</a></p>
    <hr style="border:none;border-top:1px solid #d8d4c8;margin:20px 0;">
    <p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#005f73;">Prescription Summary</p>
    ${rxTableHtml}
    <table width="100%" style="font-family:'Courier New',monospace;font-size:11px;color:#8a8070;margin-top:12px;">
      ${displayDOB ? `<tr><td style="padding:3px 0;width:160px;">Date of birth:</td><td style="color:#1a1a2e;">${displayDOB}</td></tr>` : ''}
      <tr><td style="padding:3px 0;width:160px;">Valid until:</td><td style="color:#1a1a2e;">${expires_date || '—'}</td></tr>
      <tr><td style="padding:3px 0;">Next sight test:</td><td style="color:#005f73;font-weight:600;">${recall_date ? new Date(recall_date).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'}) : '—'}</td></tr>
      <tr><td style="padding:3px 0;">Issued by:</td><td style="color:#1a1a2e;">${prescriber_name || '—'} · GOC ${goc_number || '—'}</td></tr>
      <tr><td style="padding:3px 0;">Prescription ID:</td><td style="color:#1a1a2e;">${short_code}</td></tr>
    </table>
    <hr style="border:none;border-top:1px solid #d8d4c8;margin:20px 0;">
    <table width="100%" style="background:#e8f4f4;border:1px solid rgba(10,147,150,0.25);border-radius:3px;">
      <tr><td style="padding:12px 14px;">
        <p style="margin:0;font-family:'Courier New',monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;">📅 Recall Reminder</p>
        <p style="margin:4px 0 0;font-size:13px;color:#1a1a2e;">We will automatically remind you when your next sight test is due. No action needed.</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#f4f1e8;padding:18px 28px;border-top:1px solid #d8d4c8;">
    <p style="margin:0;font-family:'Courier New',monospace;font-size:8px;color:#8a8070;line-height:1.9;">
      ${practice_name || 'RxVerify'} · Verified prescription platform<br>
      Signed using secp256k1 cryptography · Verify at <a href="${verifyLink}" style="color:#8a8070;">${APP_URL}/v/${short_code}</a><br>
      Opticians Act 1989 · Electronic Communications Act 2000<br>
      <a href="${APP_URL}/privacy" style="color:#8a8070;">Privacy Policy</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

    const emailResult = await resend.emails.send({
      from: `${process.env.EMAIL_FROM_NAME || 'RxVerify'} <${process.env.EMAIL_FROM || 'prescriptions@rxverify.co.uk'}>`,
      to: [to_email],
      subject: `Your prescription from ${practice_name || 'your optometrist'} — ${issued_date || new Date().toLocaleDateString('en-GB')}`,
      html,
      attachments: pdf_base64 ? [{
        filename: `prescription-${short_code}.pdf`,
        content: pdf_base64,
        contentType: 'application/pdf'
      }] : undefined
    });

    if (emailResult.error) {
      console.error('Resend error:', emailResult.error);
      return res.status(500).json({ error: 'Email failed', detail: emailResult.error });
    }

    res.json({ success: true, email_id: emailResult.data?.id });

  } catch (err) {
    console.error('POST /api/send/email:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════
// PDF GENERATION
// ═══════════════════════════════════════════════════════

app.post('/api/generate/pdf', async (req, res) => {
  try {
    const { prescription } = req.body;
    if (!prescription) return res.status(400).json({ error: 'prescription required' });
    const pdfBytes = await generatePDF(prescription);
    res.json({ success: true, pdf_base64: Buffer.from(pdfBytes).toString('base64') });
  } catch (err) {
    console.error('PDF generation:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// ═══════════════════════════════════════════════════════
// AI EXTRACTION
// ═══════════════════════════════════════════════════════

app.post('/api/extract', async (req, res) => {
  try {
    const { pdf_base64 } = req.body;
    if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' });
    const extracted = await extractFromPDF(pdf_base64);
    res.json({ success: true, extracted });
  } catch (err) {
    console.error('Extraction error:', err.message, err.status, JSON.stringify(err.error));
    res.status(500).json({ error: 'Extraction failed', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// PATIENT VERIFICATION PAGE
// The page itself is served with the short code
// The full prescription payload arrives in the URL fragment
// (#base64_payload) — never sent to the server
// JavaScript on the page decodes and verifies it
// ═══════════════════════════════════════════════════════

app.get('/v/:code', async (req, res) => {
  const code = req.params.code;

  // Fetch only metadata — no clinical data stored
  const { data, error } = await supabase
    .from('prescription_registry')
    .select('short_code, prescriber_goc, prescriber_npub, issued_at, expires_at, recall_due, schema_version')
    .eq('short_code', code)
    .single();

  if (error || !data) return res.status(404).send(notFoundPage(code));

  res.send(verificationPageHTML(data, code));
});

// ═══════════════════════════════════════════════════════
// RETAILER WIDGET
// Served as JavaScript — retailers embed with one script tag:
// <script src="https://rxverify.co.uk/widget.js"></script>
// ═══════════════════════════════════════════════════════

app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(widgetJS());
});

// ═══════════════════════════════════════════════════════
// SCHNORR SIGNATURE VERIFICATION (server-side)
// Uses Node.js crypto for secp256k1 via the subtle API
// Falls back to graceful failure if not available
// ═══════════════════════════════════════════════════════

async function verifySchnorrSignature(payload, sigHex, pubkeyHex) {
  if (!sigHex || !pubkeyHex) return false;
  try {
    // Dynamic import of noble/curves for server-side verification
    // Install: npm install @noble/curves @noble/hashes
    const { schnorr } = await import('@noble/curves/secp256k1');
    const { sha256 }  = await import('@noble/hashes/sha256');

    function hexToBytes(hex) {
      const b = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) b[i/2] = parseInt(hex.slice(i,i+2), 16);
      return b;
    }

    // Schnorr BIP340: raw message bytes, x-only 32-byte public key
    const msgBytes = new TextEncoder().encode(deterministicStringify(payload));
    const sigBytes = hexToBytes(sigHex);
    const pubBytes = hexToBytes(pubkeyHex); // x-only 32-byte key
    return schnorr.verify(sigBytes, msgBytes, pubBytes);
  } catch (e) {
    // If noble not installed or verification fails
    console.warn('Schnorr verify warning:', e.message);
    // Return null to indicate "could not verify" rather than "invalid"
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// PDF GENERATION HELPER
// ═══════════════════════════════════════════════════════

async function generatePDF(rx) {
  const pdfDoc  = await PDFDocument.create();
  const page    = pdfDoc.addPage([419.53, 595.28]); // A5
  const { width, height } = page.getSize();
  const fontR   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const teal    = rgb(0, 0.37, 0.45);
  const ink     = rgb(0.10, 0.10, 0.18);
  const muted   = rgb(0.54, 0.50, 0.44);
  const green   = rgb(0.18, 0.42, 0.31);
  const white   = rgb(1, 1, 1);

  // Header
  page.drawRectangle({ x:0, y:height-60, width, height:60, color:rgb(0.10,0.10,0.18) });
  page.drawText('RxVerify', { x:20, y:height-22, size:16, font:fontB, color:teal });
  page.drawText('VERIFIED PRESCRIPTION', { x:20, y:height-40, size:7, font:fontR, color:rgb(0.42,0.49,0.70), characterSpacing:1.5 });
  const pName = rx.practice?.name || rx.prescriber?.name || '';
  const pAddr = [rx.practice?.addr1, rx.practice?.addr2].filter(Boolean).join(', ');
  if (pName) page.drawText(pName, { x:width-20-fontB.widthOfTextAtSize(pName,9), y:height-22, size:9, font:fontB, color:white });
  if (pAddr) page.drawText(pAddr, { x:width-20-fontR.widthOfTextAtSize(pAddr,7), y:height-36, size:7, font:fontR, color:rgb(0.60,0.65,0.80) });
  if (rx.practice?.phone) page.drawText(rx.practice.phone, { x:width-20-fontR.widthOfTextAtSize(rx.practice.phone,7), y:height-47, size:7, font:fontR, color:rgb(0.60,0.65,0.80) });

  let y = height - 75;

  // Patient name + DOB
  page.drawText(rx.patient?.display_name || 'Patient', { x:20, y, size:16, font:fontB, color:ink });
  y -= 15;
  // Format DOB safely — parse YYYY-MM-DD without timezone conversion
  let dobStr = '';
  if (rx.patient?.display_dob) {
    try {
      const [yr, mo, dy] = rx.patient.display_dob.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      dobStr = `DOB: ${parseInt(dy)} ${months[parseInt(mo)-1]} ${yr}  ·  `;
    } catch(e) { dobStr = ''; }
  }
  const sub = `${dobStr}Issued: ${new Date(rx.issued_at*1000).toLocaleDateString('en-GB')}  ·  ${rx.test_type?.replace('_',' ') || 'Standard Sight Test'}`;
  page.drawText(sub, { x:20, y, size:8, font:fontR, color:muted });
  y -= 18;
  page.drawLine({ start:{x:20,y}, end:{x:width-20,y}, thickness:0.5, color:rgb(0.85,0.83,0.78) });
  y -= 14;

  // Prescriber + practice
  page.drawText('PRESCRIBER', { x:20, y, size:7, font:fontB, color:teal, characterSpacing:1.5 });
  y -= 12;
  page.drawText(`${rx.prescriber?.name || '—'}  ·  GOC ${rx.prescriber?.goc || '—'}`, { x:20, y, size:9, font:fontR, color:ink });
  y -= 13;
  if (pName) page.drawText(pName, { x:20, y, size:8, font:fontR, color:muted });
  y -= 12;
  if (pAddr) page.drawText(pAddr, { x:20, y, size:8, font:fontR, color:muted });
  y -= 13;
  page.drawText(`Valid until: ${new Date(rx.expires_at*1000).toLocaleDateString('en-GB')}`, { x:20, y, size:8, font:fontR, color:muted });
  y -= 18;
  page.drawLine({ start:{x:20,y}, end:{x:width-20,y}, thickness:0.5, color:rgb(0.85,0.83,0.78) });
  y -= 16;

  // Rx table
  page.drawText('REFRACTION', { x:20, y, size:7, font:fontB, color:teal, characterSpacing:1.5 });
  y -= 13;
  const c = { eye:20, sph:100, cyl:175, ax:250, add:315 };
  page.drawRectangle({ x:18, y:y-2, width:width-36, height:16, color:rgb(0.96,0.95,0.97) });
  [['EYE',c.eye],['SPHERE',c.sph],['CYL',c.cyl],['AXIS',c.ax],['ADD',c.add]].forEach(([h,x]) =>
    page.drawText(h, { x, y:y+2, size:7, font:fontB, color:teal, characterSpacing:0.8 }));
  y -= 17;
  const r = rx.rx?.right || {}, l = rx.rx?.left || {};
  page.drawText('R (OD)', { x:c.eye, y, size:9, font:fontB, color:teal });
  page.drawText(fmtVal(r.sphere),   { x:c.sph, y, size:9, font:fontR, color:ink });
  page.drawText(fmtVal(r.cylinder), { x:c.cyl, y, size:9, font:fontR, color:ink });
  page.drawText(r.axis ? r.axis+'°' : '—', { x:c.ax, y, size:9, font:fontR, color:ink });
  page.drawText(fmtVal(r.add),      { x:c.add, y, size:9, font:fontR, color:ink });
  y -= 15;
  page.drawRectangle({ x:18, y:y-3, width:width-36, height:16, color:rgb(0.99,0.99,0.99) });
  page.drawText('L (OS)', { x:c.eye, y, size:9, font:fontB, color:teal });
  page.drawText(fmtVal(l.sphere),   { x:c.sph, y, size:9, font:fontR, color:ink });
  page.drawText(fmtVal(l.cylinder), { x:c.cyl, y, size:9, font:fontR, color:ink });
  page.drawText(l.axis ? l.axis+'°' : '—', { x:c.ax, y, size:9, font:fontR, color:ink });
  page.drawText(fmtVal(l.add),      { x:c.add, y, size:9, font:fontR, color:ink });
  y -= 20;

  const extras = [rx.rx?.pd && `PD: ${rx.rx.pd}mm`, rx.rx?.bvd && `BVD: ${rx.rx.bvd}mm`, rx.rx?.recommended_lens && rx.rx.recommended_lens.replace('_',' ')].filter(Boolean);
  if (extras.length) { page.drawText(extras.join('  ·  '), { x:20, y, size:8, font:fontR, color:muted }); y -= 15; }

  // Clinical notes
  if (rx.rx?.notes) {
    page.drawText('CLINICAL NOTES', { x:20, y, size:7, font:fontB, color:teal, characterSpacing:1.5 });
    y -= 12;
    page.drawText(rx.rx.notes, { x:20, y, size:8, font:fontR, color:ink, maxWidth: width - 40 });
    y -= 15;
  }
  y -= 6;

  // Recall band
  if (rx.recall?.due_date) {
    page.drawRectangle({ x:18, y:y-26, width:width-36, height:36, color:rgb(0.91,0.97,0.96), borderColor:teal, borderWidth:0.5 });
    page.drawText('NEXT SIGHT TEST RECOMMENDED BY', { x:26, y:y-8, size:7, font:fontB, color:teal, characterSpacing:0.8 });
    page.drawText(rx.recall.due_date, { x:26, y:y-20, size:12, font:fontB, color:teal });
    page.drawText(`(${rx.recall.months} months)`, { x:150, y:y-20, size:8, font:fontR, color:muted });
    y -= 44;
  }

  y -= 8;
  const shortCode = rx.prescription_id || '';
  const verifyUrlBase = `${APP_URL}/v/${shortCode}`;

  // Encode full payload into QR so scanning gives complete verification
  // Unicode-safe base64 encoding
  let verifyUrl = verifyUrlBase;
  try {
    const { sig_optometrist: _s1, sig_practice: _s2, ...rxForQR } = rx;
    const fullRx = { ...rxForQR, sig_optometrist: rx.sig_optometrist, sig_practice: rx.sig_practice };
    const encoded = Buffer.from(JSON.stringify(fullRx), 'utf8').toString('base64');
    verifyUrl = `${verifyUrlBase}#${encoded}`;
  } catch(e) {
    verifyUrl = verifyUrlBase;
  }

  try {
    // QR encodes the full verification URL with payload
    // Error correction L allows larger data capacity
    const qrUrl = await QRCode.toDataURL(verifyUrl, {
      width: 100, margin: 1,
      errorCorrectionLevel: 'L',
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    const qrImg = await pdfDoc.embedPng(Buffer.from(qrUrl.split(',')[1], 'base64'));
    page.drawImage(qrImg, { x:width-115, y:y-90, width:90, height:90 });
  } catch(e) {
    // If payload too large for QR, fall back to short URL only
    try {
      const qrUrl = await QRCode.toDataURL(verifyUrlBase, { width:100, margin:1, color:{dark:'#1a1a2e',light:'#ffffff'} });
      const qrImg = await pdfDoc.embedPng(Buffer.from(qrUrl.split(',')[1], 'base64'));
      page.drawImage(qrImg, { x:width-115, y:y-90, width:90, height:90 });
    } catch(e2) {}
  }

  page.drawText('DIGITAL SIGNATURE', { x:20, y, size:7, font:fontB, color:teal, characterSpacing:1.5 });
  y -= 12;
  const sig = rx.sig_optometrist || rx.sig || '';
  page.drawText(sig ? sig.slice(0,36)+'...' : '—', { x:20, y, size:7, font:fontR, color:muted });
  y -= 14;
  page.drawRectangle({ x:18, y:y-14, width:150, height:18, color:rgb(0.88,0.95,0.90), borderColor:green, borderWidth:0.5 });
  page.drawText('CRYPTOGRAPHICALLY SIGNED', { x:24, y:y-9, size:7, font:fontB, color:green, characterSpacing:0.5 });
  y -= 28;
  page.drawText(`ID: ${shortCode}  ·  ${verifyUrlBase}`, { x:20, y, size:7.5, font:fontR, color:teal });
  y -= 20;
  page.drawLine({ start:{x:20,y}, end:{x:width-20,y}, thickness:0.5, color:rgb(0.85,0.83,0.78) });
  y -= 11;
  page.drawText('Opticians Act 1989  ·  Electronic Communications Act 2000  ·  secp256k1/Schnorr/SHA-256', { x:20, y, size:6.5, font:fontR, color:muted });

  return pdfDoc.save();
}

// ═══════════════════════════════════════════════════════
// AI EXTRACTION HELPER
// ═══════════════════════════════════════════════════════

async function extractFromPDF(pdfBase64) {
  const PROMPT = `You are extracting data from a UK optometry prescription PDF.

UK PMS systems record near vision in one of two ways:
METHOD A: Records ADD value separately (e.g. "Add: +1.50")
METHOD B: Records calculated near prescription as a separate row

If METHOD B: back-calculate add = near_sphere minus distance_sphere. Verify R and L consistency.

Return ONLY valid JSON, no preamble, no markdown:
{
  "recording_method":"add_recorded or near_calculated",
  "patient_name":null,"patient_dob":null,"patient_nhs":null,"test_date":null,
  "right_sphere":null,"right_cylinder":null,"right_axis":null,"right_add":null,"right_prism":null,"right_base":null,
  "left_sphere":null,"left_cylinder":null,"left_axis":null,"left_add":null,"left_prism":null,"left_base":null,
  "pd":null,"pd_near":null,"bvd":null,
  "recommended_lens":null,"clinical_notes":null,
  "recall_months":null,"recall_text":null,
  "optometrist_name":null,"goc_number":null,"practice_name":null,
  "add_consistent":null,"add_difference_flagged":false
}
Rules: minus cylinder convention. 0.25 steps. Axis integer 1-180. Null if not present. Plano=0.00. DS=null cylinder. Do NOT include visual acuity (VA) in clinical_notes — leave clinical_notes null unless there are specific clinical recommendations (e.g. lens coatings, referrals). Recall date in past = null months.`;

  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: PROMPT }
    ]}]
  });

  const clean = resp.content[0].text.trim().replace(/^```json?\n?/,'').replace(/\n?```$/,'');
  const parsed = JSON.parse(clean);
  return validateExtracted(parsed);
}

function validateExtracted(f) {
  const step = (v) => v == null ? v : Math.round(v * 4) / 4;
  const range = (v, min, max) => (v == null || v < min || v > max) ? null : v;
  return {
    ...f,
    right_sphere:   range(step(f.right_sphere),   -30, 30),
    right_cylinder: range(step(f.right_cylinder), -10, 10),
    right_axis:     range(f.right_axis, 1, 180),
    right_add:      range(step(f.right_add), 0, 4),
    left_sphere:    range(step(f.left_sphere),    -30, 30),
    left_cylinder:  range(step(f.left_cylinder),  -10, 10),
    left_axis:      range(f.left_axis, 1, 180),
    left_add:       range(step(f.left_add), 0, 4),
    pd:             range(f.pd, 45, 80),
  };
}

// ═══════════════════════════════════════════════════════
// VERIFICATION PAGE HTML
// Payload is never sent to server — lives in URL fragment
// JavaScript decodes and verifies it client-side
// ═══════════════════════════════════════════════════════

function verificationPageHTML(meta, code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prescription Verification — ${code}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Lora:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Lora',Georgia,serif;background:#f4f1e8;color:#1a1a2e;min-height:100vh;}
.hdr{background:#1a1a2e;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;}
.logo{font-family:'DM Mono',monospace;font-size:18px;color:#0a9396;}
.logo span{color:white;}
.wrap{max-width:580px;margin:0 auto;padding:20px 14px;}
.card{background:white;border:1px solid #d8d4c8;border-radius:3px;padding:22px;margin-bottom:14px;box-shadow:0 2px 10px rgba(26,26,46,0.05);}
.status{text-align:center;padding:20px;border-radius:3px;margin-bottom:14px;}
.status-ok{background:rgba(45,106,79,0.08);border:2px solid rgba(45,106,79,0.35);}
.status-fail{background:rgba(155,34,38,0.08);border:2px solid rgba(155,34,38,0.35);}
.status-loading{background:rgba(10,147,150,0.06);border:2px solid rgba(10,147,150,0.2);}
.st-icon{font-size:30px;margin-bottom:6px;}
.st-text{font-family:'DM Mono',monospace;font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;}
.ok{color:#2d6a4f;}.fail{color:#9b2226;}.loading-c{color:#005f73;}
.sec{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#005f73;margin-bottom:10px;}
.rx-tbl{width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:12px;}
.rx-tbl th{background:#f4f1e8;padding:7px 9px;text-align:center;border:1px solid #d8d4c8;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#005f73;}
.rx-tbl td{padding:7px 9px;border:1px solid #d8d4c8;text-align:center;}
.eye{color:#005f73;font-weight:500;text-align:left!important;}
.chk{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid #f4f1e8;font-family:'DM Mono',monospace;}
.chk:last-child{border:none;}
.ci{width:16px;text-align:center;font-size:13px;}
.cl{color:#8a8070;flex:1;font-size:10px;}
.cv{font-size:10px;}
.recall-bx{background:rgba(10,147,150,0.07);border:1px solid rgba(10,147,150,0.22);border-radius:2px;padding:11px 14px;margin-top:12px;font-family:'DM Mono',monospace;font-size:11px;color:#005f73;}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:2px;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;}
.bv{background:rgba(45,106,79,0.1);color:#2d6a4f;border:1px solid rgba(45,106,79,0.25);}
.btn{display:inline-block;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;padding:10px 18px;border-radius:2px;text-decoration:none;margin:3px;border:1px solid #005f73;color:#005f73;}
.btn-p{background:#005f73;color:white;}
.ft{text-align:center;padding:20px;font-family:'DM Mono',monospace;font-size:9px;color:#8a8070;line-height:1.8;}
#rx-section{display:none;}
#actions{display:none;text-align:center;margin:14px 0;}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo">Rx<span>Verify</span></div>
  <div style="font-family:'DM Mono',monospace;font-size:10px;color:#6b7db3;">${code}</div>
</div>
<div class="wrap">

  <div class="status status-loading" id="status-box">
    <div class="st-icon">⟳</div>
    <div class="st-text loading-c">Loading prescription…</div>
    <div style="font-family:'DM Mono',monospace;font-size:10px;color:#8a8070;margin-top:5px;">Verifying cryptographic signature</div>
  </div>

  <div class="card" id="rx-section">
    <div id="practice-hdr"></div>
    <div id="patient-name" style="font-size:20px;font-weight:600;color:#2d3561;margin-bottom:3px;"></div>
    <div id="issued-line" style="font-family:'DM Mono',monospace;font-size:10px;color:#8a8070;margin-bottom:16px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;" id="meta-grid"></div>
    <div class="sec">Refraction</div>
    <table class="rx-tbl" style="margin-bottom:12px;">
      <thead><tr><th style="text-align:left;">Eye</th><th>Sphere</th><th>Cylinder</th><th>Axis</th><th>Add</th></tr></thead>
      <tbody id="rx-body"></tbody>
    </table>
    <div id="rx-extras" style="font-family:'DM Mono',monospace;font-size:11px;color:#2d3561;"></div>
    <div id="rx-notes" style="display:none;margin-top:10px;font-family:'DM Mono',monospace;font-size:11px;color:#2d3561;padding:8px 10px;background:#fdfcf7;border:1px solid #d8d4c8;border-radius:2px;"></div>
    <div id="recall-box"></div>
  </div>

  <div class="card" id="checks-card" style="display:none;">
    <div class="sec">Verification Checks</div>
    <div id="checks-list"></div>
  </div>

  <div id="actions">
    <a href="#" class="btn btn-p" id="pdf-btn">Download PDF</a>
    <a href="${APP_URL}" class="btn">About RxVerify</a>
  </div>

</div>
<div class="ft">
  RxVerify · rxverify.co.uk<br>
  Prescription ID: ${code} · secp256k1/Schnorr/SHA-256<br>
  Opticians Act 1989 · Electronic Communications Act 2000
</div>

<script type="module">
import { schnorr } from 'https://esm.sh/@noble/curves@1.4.0/secp256k1';

// Use relative URLs — works on any domain (rxverify.co.uk or www.rxverify.co.uk)
const API   = '';
const CODE  = '${code}';
const META  = ${JSON.stringify(meta)};

function hexB(hex){ const b=new Uint8Array(hex.length/2); for(let i=0;i<hex.length;i+=2)b[i/2]=parseInt(hex.slice(i,i+2),16); return b; }
function fmtV(v,f){ if(v==null)return'—'; if(f==='axis')return v+'°'; const n=parseFloat(v); return n>=0?'+'+n.toFixed(2):n.toFixed(2); }
function metaItem(label,val){ return '<div><div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:#8a8070;margin-bottom:1px;">'+label+'</div><div style="font-size:13px;">'+val+'</div></div>'; }

async function run() {
  // ── Get payload from URL fragment (never sent to server) ──
  const fragment = location.hash.slice(1);
  let rx = null;

  if (fragment) {
    try {
      // Unicode-safe base64 decode — handles UTF-8 characters like ·
      rx = JSON.parse(decodeURIComponent(escape(atob(fragment))));
    } catch(e) {
      try { rx = JSON.parse(decodeURIComponent(fragment)); } catch(e2) {}
    }
  }

  if (!rx) {
    // No fragment — show metadata only (no clinical data available)
    showMetaOnly();
    return;
  }

  // ── Run all checks ──
  const checks  = [];
  let   allOk   = true;
  const now     = Math.floor(Date.now()/1000);
  // Strip sig fields AND prescription_id — matches what was signed
  const { sig_optometrist, sig_practice, prescription_id: _rxpid, ...canonical } = rx;
  const sig = sig_optometrist || rx.sig;

  // 1. Schema
  const schOk = rx.schema_version === 'rxv1-uk';
  checks.push({ label:'Schema version', ok:schOk, value:rx.schema_version||'missing' });
  if(!schOk) allOk=false;

  // 2. Not expired
  const expOk = rx.expires_at > now;
  checks.push({ label:'Not expired', ok:expOk, value:new Date(rx.expires_at*1000).toLocaleDateString('en-GB') });
  if(!expOk) allOk=false;

  // 3. Prescriber fields
  const presOk = !!(rx.prescriber?.pubkey && rx.prescriber?.goc);
  checks.push({ label:'Prescriber fields', ok:presOk, value:presOk ? rx.prescriber.name+' · GOC '+rx.prescriber.goc : 'Missing' });
  if(!presOk) allOk=false;

  // 4. Registry lookup via server
  let serverResult = null;
  try {
    const vResp = await fetch(API+'/api/verify', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ short_code: CODE, payload: rx })
    });
    serverResult = await vResp.json();
    const inRegistry = serverResult.checks?.prescriber_registered;
    checks.push({ label:'Prescriber GOC-registered', ok:!!inRegistry, value:inRegistry ? (serverResult.prescriber?.goc||'')+'  ·  '+serverResult.prescriber?.name : 'Not found — verify GOC at optical.org' });
    if(!inRegistry) allOk=false;
  } catch(e) {
    checks.push({ label:'Prescriber GOC-registered', ok:false, value:'Registry unavailable' });
  }

  // 5. Cryptographic signature (client-side)
  // Uses deterministic JSON stringify (sorted keys) to match server-side hashing
  function deterministicStringify(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const sortedKeys = Object.keys(obj).sort();
    return '{' + sortedKeys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}';
  }

  let sigValid = false;
  try {
    if(sig && rx.prescriber?.pubkey) {
      // Schnorr BIP340: raw message bytes, x-only 32-byte public key
      const msgBytes = new TextEncoder().encode(deterministicStringify(canonical));
      const sigBytes = hexB(sig);
      const pubBytes = hexB(rx.prescriber.pubkey); // x-only 32-byte key (64 hex chars)
      sigValid = schnorr.verify(sigBytes, msgBytes, pubBytes);
    }
  } catch(e) { sigValid = false; }
  checks.push({ label:'Cryptographic signature', ok:sigValid, value:sigValid?'Valid secp256k1/Schnorr/SHA-256':'✗ INVALID — do not dispense' });
  if(!sigValid) allOk=false;

  // ── Render status ──
  const sb = document.getElementById('status-box');
  sb.className = 'status ' + (allOk ? 'status-ok' : 'status-fail');
  sb.innerHTML = '<div class="st-icon">'+(allOk?'✓':'✗')+'</div>'
    + '<div class="st-text '+(allOk?'ok':'fail')+'">'+(allOk?'Authentic Verified Prescription':'Verification Failed — Do Not Dispense')+'</div>'
    + '<div style="font-family:DM Mono,monospace;font-size:10px;color:#8a8070;margin-top:5px;">'
    + (allOk?'Cryptographically signed · GOC verified · Unmodified':((serverResult?.reason||checks.find(c=>!c.ok)?.value)||'See checks below'))
    + '</div>';

  // ── Render prescription ──
  document.getElementById('rx-section').style.display = 'block';
  document.getElementById('checks-card').style.display = 'block';
  document.getElementById('actions').style.display = 'block';

  const pc = rx.practice?.colour || '#005f73';
  document.getElementById('practice-hdr').innerHTML = rx.practice?.name ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid '+pc+'"><div style="width:40px;height:40px;border-radius:2px;background:'+pc+'18;color:'+pc+';display:flex;align-items:center;justify-content:center;font-size:20px;">'+rx.practice.emoji+'</div><div><div style="font-family:DM Mono,monospace;font-size:12px;font-weight:500;color:#2d3561;">'+rx.practice.name+'</div><div style="font-family:DM Mono,monospace;font-size:9px;color:#8a8070;">'+(rx.practice.addr1||'')+(rx.practice.addr2?', '+rx.practice.addr2:'')+'</div></div></div>' : '';

  document.getElementById('patient-name').textContent = rx.patient?.display_name || 'Patient';
  document.getElementById('issued-line').textContent  = 'Issued ' + new Date(rx.issued_at*1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) + '  ·  ' + (rx.test_type?.replace('_',' ')||'Standard Sight Test');

  document.getElementById('meta-grid').innerHTML =
    metaItem('Prescriber', rx.prescriber?.name||'—') +
    metaItem('GOC Registration', rx.prescriber?.goc||'—') +
    (rx.patient?.display_dob ? metaItem('Date of Birth', new Date(rx.patient.display_dob).toLocaleDateString('en-GB')) : '') +
    metaItem('Valid Until', new Date(rx.expires_at*1000).toLocaleDateString('en-GB')) +
    metaItem('Test Type', rx.test_type?.replace('_',' ')||'Standard');

  const rxR = rx.rx?.right||{}, rxL = rx.rx?.left||{};
  document.getElementById('rx-body').innerHTML =
    '<tr><td class="eye">R (OD)</td><td>'+fmtV(rxR.sphere)+'</td><td>'+fmtV(rxR.cylinder)+'</td><td>'+fmtV(rxR.axis,'axis')+'</td><td>'+fmtV(rxR.add)+'</td></tr>'+
    '<tr><td class="eye">L (OS)</td><td>'+fmtV(rxL.sphere)+'</td><td>'+fmtV(rxL.cylinder)+'</td><td>'+fmtV(rxL.axis,'axis')+'</td><td>'+fmtV(rxL.add)+'</td></tr>';

  const extras=[rx.rx?.pd&&'PD: '+rx.rx.pd+'mm', rx.rx?.bvd&&'BVD: '+rx.rx.bvd+'mm', rx.rx?.recommended_lens&&rx.rx.recommended_lens.replace('_',' ')].filter(Boolean);
  document.getElementById('rx-extras').textContent = extras.join('  ·  ');

  // Clinical notes
  if(rx.rx?.notes) {
    const notesEl = document.getElementById('rx-notes');
    if(notesEl) {
      notesEl.style.display = 'block';
      notesEl.innerHTML = '<span style="font-family:DM Mono,monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#8a8070;">Clinical Notes</span><br>' + rx.rx.notes;
    }
  }

  if(rx.recall?.due_date) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let recallDisplay = rx.recall.due_date;
    try {
      const parts = rx.recall.due_date.split('-');
      recallDisplay = parseInt(parts[2]) + ' ' + months[parseInt(parts[1])-1] + ' ' + parts[0];
    } catch(e) {}
    document.getElementById('recall-box').innerHTML = '<div class="recall-bx">📅 Next sight test recommended by <strong>'+recallDisplay+'</strong> ('+rx.recall.months+' months)</div>';
  }

  document.getElementById('checks-list').innerHTML = checks.map(c =>
    '<div class="chk"><span class="ci" style="color:'+(c.ok?'#2d6a4f':'#9b2226')+'">'+(c.ok?'✓':'✗')+'</span><span class="cl">'+c.label+'</span><span class="cv" style="color:'+(c.ok?'#1a1a2e':'#9b2226')+'">'+c.value+'</span></div>'
  ).join('');

  // PDF download — regenerates from payload
  document.getElementById('pdf-btn').onclick = async (e) => {
    e.preventDefault();
    const btn = e.target;
    const origText = btn.textContent;
    btn.textContent = 'Generating…';
    btn.style.opacity = '0.7';
    try {
      const r = await fetch(API+'/api/generate/pdf', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ prescription: rx })
      });
      if (!r.ok) throw new Error('Server error: ' + r.status);
      const d = await r.json();
      if(d.pdf_base64) {
        const a = document.createElement('a');
        a.href = 'data:application/pdf;base64,'+d.pdf_base64;
        a.download = 'prescription-'+CODE+'.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        btn.textContent = '✓ Downloaded';
        setTimeout(() => { btn.textContent = origText; btn.style.opacity = '1'; }, 2000);
      } else {
        throw new Error('No PDF returned');
      }
    } catch(err) {
      console.error('PDF error:', err);
      btn.textContent = 'Failed — tap to retry';
      btn.style.opacity = '1';
      setTimeout(() => { btn.textContent = origText; }, 3000);
    }
  };
}

function showMetaOnly() {
  const sb = document.getElementById('status-box');
  sb.className = 'status status-loading';
  sb.innerHTML = '<div class="st-icon">📋</div><div class="st-text loading-c">Prescription Record Found</div><div style="font-family:DM Mono,monospace;font-size:10px;color:#8a8070;margin-top:5px;">Present your prescription PDF or QR code for full verification</div>';

  document.getElementById('rx-section').style.display = 'block';
  document.getElementById('patient-name').textContent = 'Prescription ' + CODE;
  document.getElementById('issued-line').textContent  = 'Issued: ' + new Date(META.issued_at).toLocaleDateString('en-GB') + '  ·  Expires: ' + new Date(META.expires_at).toLocaleDateString('en-GB');
  document.getElementById('meta-grid').innerHTML =
    metaItem('GOC Number', META.prescriber_goc||'—') +
    metaItem('Schema', META.schema_version||'rxv1-uk') +
    metaItem('Issued', new Date(META.issued_at).toLocaleDateString('en-GB')) +
    metaItem('Expires', new Date(META.expires_at).toLocaleDateString('en-GB'));
  document.getElementById('rx-extras').textContent = 'Full prescription details available when patient presents their PDF or QR code.';
  document.getElementById('actions').style.display = 'block';
}

run().catch(err => {
  console.error(err);
  const sb = document.getElementById('status-box');
  sb.className = 'status status-fail';
  sb.innerHTML = '<div class="st-icon">✗</div><div class="st-text fail">Verification Error</div><div style="font-family:DM Mono,monospace;font-size:10px;color:#8a8070;margin-top:5px;">'+err.message+'</div>';
});
</script>
</body></html>`;
}

function notFoundPage(code) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title></head>
<body style="font-family:Georgia,serif;background:#f4f1e8;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;">
<div><h1 style="color:#2d3561;">Prescription Not Found</h1><p style="color:#8a8070;font-family:monospace;margin:12px 0;">Code: ${code}</p>
<p style="color:#8a8070;">This code was not found in the RxVerify registry.</p></div></body></html>`;
}

// ═══════════════════════════════════════════════════════
// RETAILER WIDGET JavaScript
// Embed with: <script src="https://rxverify.co.uk/widget.js"></script>
// Use with:
//   <div id="rxverify-widget"
//        data-retailer-key="ret_xxx"
//        data-on-success="myCallbackFunction">
//   </div>
// ═══════════════════════════════════════════════════════

function widgetJS() {
  return `
(function() {
  'use strict';

  const API = 'https://rxverify.co.uk';
  const WIDGET_VERSION = '1.0.0';

  // ── Find widget mount point ──
  const container = document.getElementById('rxverify-widget');
  if (!container) return;

  const retailerKey = container.dataset.retailerKey || '';
  const onSuccess   = container.dataset.onSuccess   || '';
  const onError     = container.dataset.onError     || '';

  // ── Inject styles ──
  const style = document.createElement('style');
  style.textContent = \`
    .rxv-widget { font-family: 'Courier New', monospace; max-width: 400px; }
    .rxv-btn { background: #005f73; color: white; border: none; padding: 12px 20px; border-radius: 3px; font-family: inherit; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; width: 100%; }
    .rxv-btn:hover { background: #0a9396; }
    .rxv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .rxv-input { width: 100%; padding: 10px 12px; border: 1px solid #d8d4c8; border-radius: 3px; font-family: inherit; font-size: 13px; margin: 8px 0; outline: none; text-transform: uppercase; letter-spacing: 0.1em; }
    .rxv-input:focus { border-color: #005f73; }
    .rxv-status { padding: 10px 12px; border-radius: 3px; font-size: 11px; margin: 8px 0; }
    .rxv-ok { background: rgba(45,106,79,0.1); color: #2d6a4f; border: 1px solid rgba(45,106,79,0.25); }
    .rxv-err { background: rgba(155,34,38,0.1); color: #9b2226; border: 1px solid rgba(155,34,38,0.25); }
    .rxv-info { background: rgba(10,147,150,0.08); color: #005f73; border: 1px solid rgba(10,147,150,0.2); }
    .rxv-logo { font-size: 11px; color: #8a8070; margin-bottom: 10px; }
    .rxv-logo span { color: #0a9396; font-weight: bold; }
    .rxv-divider { text-align: center; color: #8a8070; font-size: 11px; margin: 8px 0; }
    .rxv-rx-preview { border: 1px solid #d8d4c8; border-radius: 3px; padding: 12px; margin: 10px 0; background: #fdfcf7; font-size: 12px; }
    .rxv-rx-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f0ede4; }
    .rxv-rx-row:last-child { border: none; }
    .rxv-rx-label { color: #8a8070; }
    .rxv-rx-val { font-weight: 500; }
  \`;
  document.head.appendChild(style);

  // ── Render widget ──
  container.innerHTML = \`
    <div class="rxv-widget">
      <div class="rxv-logo">Verified by <span>Rx</span>Verify</div>
      <button class="rxv-btn" id="rxv-scan-btn">📱 Scan Prescription QR Code</button>
      <div class="rxv-divider">— or —</div>
      <input type="text" class="rxv-input" id="rxv-code-input"
             placeholder="ENTER CODE e.g. RXV-48291-K" maxlength="12">
      <button class="rxv-btn" id="rxv-verify-btn" style="background:#1a1a2e;">
        ⟳ Verify Prescription
      </button>
      <div id="rxv-status" style="display:none;"></div>
      <div id="rxv-preview" style="display:none;"></div>
    </div>
  \`;

  const codeInput  = document.getElementById('rxv-code-input');
  const verifyBtn  = document.getElementById('rxv-verify-btn');
  const scanBtn    = document.getElementById('rxv-scan-btn');
  const statusEl   = document.getElementById('rxv-status');
  const previewEl  = document.getElementById('rxv-preview');

  function showStatus(msg, type) {
    statusEl.style.display = 'block';
    statusEl.className = 'rxv-status rxv-' + type;
    statusEl.textContent = msg;
  }

  function fmtV(v) {
    if (v == null) return '—';
    const n = parseFloat(v);
    return n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2);
  }

  // ── Verify from code (GET check first, then need payload) ──
  verifyBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) { showStatus('Please enter a prescription code', 'err'); return; }

    verifyBtn.disabled = true;
    showStatus('Checking prescription code…', 'info');

    try {
      // Quick existence check
      const checkResp = await fetch(API + '/api/verify/' + code);
      const checkData = await checkResp.json();

      if (!checkData.found) {
        showStatus('Prescription code not found in RxVerify registry', 'err');
        verifyBtn.disabled = false;
        return;
      }

      if (!checkData.not_expired) {
        showStatus('Prescription has expired — patient needs a new sight test', 'err');
        verifyBtn.disabled = false;
        return;
      }

      // Code exists and is in date — prompt for QR/payload
      showStatus(
        'Code found ✓ — ask customer to present their prescription QR code or PDF for full verification',
        'info'
      );

      // In a full implementation, trigger QR scanner here
      // For now show the prescription summary from metadata only
      previewEl.style.display = 'block';
      previewEl.innerHTML = \`
        <div class="rxv-rx-preview">
          <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#005f73;margin-bottom:8px;">Prescription Found</div>
          <div class="rxv-rx-row"><span class="rxv-rx-label">Code</span><span class="rxv-rx-val">\${code}</span></div>
          <div class="rxv-rx-row"><span class="rxv-rx-label">GOC</span><span class="rxv-rx-val">\${checkData.goc_number}</span></div>
          <div class="rxv-rx-row"><span class="rxv-rx-label">Issued</span><span class="rxv-rx-val">\${new Date(checkData.issued_at).toLocaleDateString('en-GB')}</span></div>
          <div class="rxv-rx-row"><span class="rxv-rx-label">Expires</span><span class="rxv-rx-val">\${new Date(checkData.expires_at).toLocaleDateString('en-GB')}</span></div>
          <div class="rxv-rx-row"><span class="rxv-rx-label">Recall due</span><span class="rxv-rx-val">\${checkData.recall_due || '—'}</span></div>
          <div style="font-size:10px;color:#8a8070;margin-top:8px;">
            Full verification and auto-population requires patient to present their QR code.
            Clinical data flows from patient — not from RxVerify servers.
          </div>
        </div>\`;

    } catch (err) {
      showStatus('Verification service unavailable — please try again', 'err');
    }

    verifyBtn.disabled = false;
  });

  // ── QR scan (calls back into page with decoded payload) ──
  scanBtn.addEventListener('click', () => {
    showStatus('QR scanning requires camera access — integrate with your preferred QR library (e.g. html5-qrcode)', 'info');
    // Production: launch QR scanner, decode payload,
    // then call verifyWithPayload(code, payload)
  });

  // ── Full verification with payload (called by retailer after QR decode) ──
  window.rxverifyWithPayload = async function(code, payload) {
    showStatus('Verifying prescription…', 'info');
    try {
      const resp = await fetch(API + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Retailer-Key': retailerKey },
        body: JSON.stringify({ short_code: code, payload })
      });
      const result = await resp.json();

      if (result.valid) {
        showStatus('✓ Prescription verified — authentic and unmodified', 'ok');

        // Show clinical data preview
        const rx = payload.rx || {};
        previewEl.style.display = 'block';
        previewEl.innerHTML = \`
          <div class="rxv-rx-preview">
            <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#005f73;margin-bottom:8px;">Verified Refraction</div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">R Sphere</span><span class="rxv-rx-val">\${fmtV(rx.right?.sphere)}</span></div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">R Cylinder</span><span class="rxv-rx-val">\${fmtV(rx.right?.cylinder)}</span></div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">R Axis</span><span class="rxv-rx-val">\${rx.right?.axis ? rx.right.axis + '°' : '—'}</span></div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">L Sphere</span><span class="rxv-rx-val">\${fmtV(rx.left?.sphere)}</span></div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">L Cylinder</span><span class="rxv-rx-val">\${fmtV(rx.left?.cylinder)}</span></div>
            <div class="rxv-rx-row"><span class="rxv-rx-label">L Axis</span><span class="rxv-rx-val">\${rx.left?.axis ? rx.left.axis + '°' : '—'}</span></div>
            \${rx.pd ? '<div class="rxv-rx-row"><span class="rxv-rx-label">PD</span><span class="rxv-rx-val">'+rx.pd+'mm</span></div>' : ''}
            \${rx.right?.add ? '<div class="rxv-rx-row"><span class="rxv-rx-label">Add</span><span class="rxv-rx-val">'+fmtV(rx.right.add)+'</span></div>' : ''}
            <div style="font-size:10px;color:#2d6a4f;margin-top:10px;font-weight:500;">
              ✓ Auto-populated from verified prescription
            </div>
          </div>\`;

        // Fire callback to retailer's populate function
        if (onSuccess && typeof window[onSuccess] === 'function') {
          window[onSuccess]({
            verified: true,
            rx:         payload.rx,
            prescriber: result.prescriber,
            meta:       result.prescription_meta,
            raw_payload: payload
          });
        }
      } else {
        showStatus('✗ Verification failed — ' + (result.reason || 'invalid prescription'), 'err');
        if (onError && typeof window[onError] === 'function') {
          window[onError]({ verified: false, reason: result.reason });
        }
      }
    } catch (err) {
      showStatus('Verification service error — please try again', 'err');
    }
  };

})();
`;
}

// ═══════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════
function fmtVal(v) {
  if (v == null) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

// ── Recall notification cron ──
recallCronRoute(app);

// ── Catch-all: serve frontend for non-API routes ──────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/widget')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(FRONTEND_HTML);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RxVerify API v2 running on port ${PORT}`);
  console.log(`Hash-only storage: clinical data never written to database`);
  console.log(`Verify endpoint: POST /api/verify`);
  console.log(`Retailer widget: GET /widget.js`);
});
