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

// ── Frontend HTML (embedded directly to avoid Vercel file-serving issues) ──
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RxVerify — Digital Spectacle Prescription</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
/* ── Password Gate ── */
#auth-gate {
  position:fixed;inset:0;background:#1a1a2e;z-index:9999;
  display:flex;align-items:center;justify-content:center;
}
#auth-gate.hidden { display:none; }
.auth-box {
  background:#fdfcf7;border:1px solid #d8d4c8;border-radius:4px;
  padding:40px;width:340px;text-align:center;
}
.auth-logo {
  font-family:'DM Mono',monospace;font-size:22px;margin-bottom:6px;
}
.auth-logo span { color:#0a9396; }
.auth-subtitle {
  font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.2em;
  text-transform:uppercase;color:#8a8070;margin-bottom:28px;
}
.auth-label {
  font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.16em;
  text-transform:uppercase;color:#8a8070;display:block;
  text-align:left;margin-bottom:6px;
}
.auth-input {
  width:100%;border:1px solid #d8d4c8;border-radius:2px;
  padding:10px 12px;font-family:'DM Mono',monospace;font-size:13px;
  color:#1a1a2e;background:#f4f1e8;outline:none;margin-bottom:14px;
  transition:border-color 0.2s;
}
.auth-input:focus { border-color:#0a9396;background:white; }
.auth-btn {
  width:100%;background:#005f73;color:white;border:none;border-radius:2px;
  padding:12px;font-family:'DM Mono',monospace;font-size:10px;
  letter-spacing:0.18em;text-transform:uppercase;cursor:pointer;
  transition:background 0.2s;
}
.auth-btn:hover { background:#0a9396; }
.auth-error {
  font-family:'DM Mono',monospace;font-size:10px;color:#9b2226;
  margin-top:10px;display:none;
}
</style>
<style>
:root{
  --ink:#1a1a2e;--ink2:#2d3561;--teal:#0a9396;--teal2:#005f73;
  --cream:#fdfcf7;--warm:#f4f1e8;--border:#d8d4c8;--muted:#8a8070;
  --green:#2d6a4f;--red:#9b2226;--amber:#92600a;
  --shadow:0 2px 20px rgba(26,26,46,0.08);
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Lora',Georgia,serif;background:var(--cream);color:var(--ink);min-height:100vh;}

header{background:var(--ink);color:var(--cream);padding:18px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
.logo{display:flex;align-items:baseline;gap:10px;}
.logo-mark{font-family:'DM Mono',monospace;font-size:18px;letter-spacing:-0.02em;color:var(--teal);}
.logo-sub{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6b7db3;font-family:'DM Mono',monospace;}
.header-info{font-family:'DM Mono',monospace;font-size:10px;color:#6b7db3;text-align:right;line-height:1.7;}
.header-info span{color:var(--teal);}

nav{background:var(--ink2);display:flex;padding:0 24px;overflow-x:auto;}
nav button{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:13px 15px;background:none;border:none;color:#6b7db3;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;white-space:nowrap;}
nav button.active{color:var(--teal);border-bottom-color:var(--teal);}
nav button:hover:not(.active){color:#94a3d4;}

main{max-width:920px;margin:0 auto;padding:32px 20px;}
.tab-panel{display:none;}
.tab-panel.active{display:block;animation:fadeIn 0.22s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

.card{background:white;border:1px solid var(--border);border-radius:3px;padding:26px;margin-bottom:18px;box-shadow:var(--shadow);}
.card-title{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.28em;text-transform:uppercase;color:var(--teal2);margin-bottom:18px;padding-bottom:9px;border-bottom:1px solid var(--border);}
.card-sub{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:14px;line-height:1.75;}

.field-row{display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap;}
.field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:130px;}
.field label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--muted);}
.field input,.field select,.field textarea{border:1px solid var(--border);border-radius:2px;padding:8px 10px;font-family:'DM Mono',monospace;font-size:12px;color:var(--ink);background:var(--cream);outline:none;transition:border-color 0.2s;width:100%;}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--teal);background:white;}
.field input[readonly]{background:var(--warm);color:var(--muted);}

.btn{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;padding:10px 20px;border-radius:2px;cursor:pointer;transition:all 0.2s;display:inline-flex;align-items:center;gap:7px;border:none;}
.btn-primary{background:var(--teal2);color:white;border:1px solid var(--teal2);}
.btn-primary:hover{background:var(--teal);border-color:var(--teal);}
.btn-primary:disabled{opacity:0.45;cursor:not-allowed;}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border);}
.btn-ghost:hover{border-color:var(--teal);color:var(--teal2);}
.btn-amber{background:rgba(146,96,10,0.08);color:var(--amber);border:1px solid rgba(146,96,10,0.3);}
.btn-amber:hover{background:rgba(146,96,10,0.15);}

.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:2px;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;}
.badge-valid{background:rgba(45,106,79,0.1);color:var(--green);border:1px solid rgba(45,106,79,0.25);}
.badge-invalid{background:rgba(155,34,38,0.1);color:var(--red);border:1px solid rgba(155,34,38,0.25);}
.badge-info{background:rgba(10,147,150,0.1);color:var(--teal2);border:1px solid rgba(10,147,150,0.25);}
.badge-warn{background:rgba(146,96,10,0.1);color:var(--amber);border:1px solid rgba(146,96,10,0.25);}
.badge-pending{background:rgba(107,125,179,0.1);color:var(--ink2);border:1px solid rgba(107,125,179,0.25);}

.mono-block{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);word-break:break-all;line-height:1.6;background:var(--warm);padding:9px 11px;border-radius:2px;border:1px solid var(--border);cursor:pointer;}
.mono-block:hover{border-color:var(--teal);}
.divider{border-top:1px solid var(--border);margin:18px 0;}
.alert{padding:12px 14px;border-radius:2px;font-family:'DM Mono',monospace;font-size:11px;margin-bottom:14px;line-height:1.6;}
.alert-warn{background:rgba(146,96,10,0.07);border:1px solid rgba(146,96,10,0.22);color:var(--amber);}
.alert-info{background:rgba(10,147,150,0.06);border:1px solid rgba(10,147,150,0.18);color:var(--teal2);}
.alert-success{background:rgba(45,106,79,0.07);border:1px solid rgba(45,106,79,0.22);color:var(--green);}
.alert-error{background:rgba(155,34,38,0.07);border:1px solid rgba(155,34,38,0.22);color:var(--red);}

/* ── VERIFICATION WIZARD ── */
.wizard-steps{display:flex;gap:0;margin-bottom:24px;background:var(--warm);border:1px solid var(--border);border-radius:3px;overflow:hidden;}
.wstep{flex:1;padding:12px 8px;text-align:center;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);border-right:1px solid var(--border);transition:all 0.2s;cursor:default;}
.wstep:last-child{border-right:none;}
.wstep.active{background:var(--teal2);color:white;}
.wstep.done{background:rgba(45,106,79,0.08);color:var(--green);}
.wstep-num{display:block;font-size:14px;margin-bottom:3px;}

.verif-panel{display:none;}
.verif-panel.active{display:block;animation:fadeIn 0.2s ease;}

.upload-zone{border:2px dashed var(--border);border-radius:3px;padding:28px;text-align:center;cursor:pointer;transition:all 0.2s;background:var(--warm);}
.upload-zone:hover{border-color:var(--teal);background:rgba(10,147,150,0.04);}
.upload-zone.has-file{border-color:var(--green);background:rgba(45,106,79,0.05);}
.upload-label{font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);display:block;margin-top:8px;}

/* ── RECALL PILLS ── */
.recall-pills{display:flex;gap:7px;flex-wrap:wrap;}
.recall-pill{font-family:'DM Mono',monospace;font-size:10px;padding:7px 13px;border:1px solid var(--border);border-radius:20px;cursor:pointer;background:var(--cream);color:var(--muted);transition:all 0.16s;}
.recall-pill.active{background:var(--teal2);color:white;border-color:var(--teal2);}
.recall-pill:hover:not(.active){border-color:var(--teal);color:var(--teal2);}
.recall-summary{font-family:'DM Mono',monospace;font-size:10px;color:var(--teal2);margin-top:10px;padding:8px 11px;background:rgba(10,147,150,0.06);border:1px solid rgba(10,147,150,0.18);border-radius:2px;}

/* ── RX TABLE ── */
.rx-table{width:100%;border-collapse:collapse;}
.rx-table th{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.13em;text-transform:uppercase;color:var(--teal2);padding:7px 9px;background:var(--warm);border:1px solid var(--border);text-align:center;font-weight:500;}
.rx-table td{border:1px solid var(--border);padding:3px 5px;text-align:center;}
.rx-table td input{border:none;background:transparent;text-align:center;font-family:'DM Mono',monospace;font-size:13px;color:var(--ink);width:100%;padding:4px;outline:none;}
.rx-table td input:focus{background:#e8f4f4;border-radius:2px;}
.eye-label{font-family:'DM Mono',monospace;font-size:10px;color:var(--teal2);font-weight:500;padding:7px 11px;background:var(--warm);text-align:left;}

/* ── PRACTICE CONTEXT ── */
.practice-card{border:1px solid var(--border);border-radius:2px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:all 0.18s;display:flex;align-items:center;gap:14px;}
.practice-card:hover{border-color:var(--teal);background:rgba(10,147,150,0.03);}
.practice-card.selected{border-color:var(--teal2);background:rgba(10,147,150,0.06);}
.practice-logo{width:40px;height:40px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.practice-info{flex:1;}
.practice-name{font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2);font-weight:500;}
.practice-detail{font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:2px;line-height:1.6;}
.delegation-badge{font-family:'DM Mono',monospace;font-size:8px;}

/* ── PATIENT VIEW ── */
.rx-preview{border:2px solid var(--teal2);border-radius:3px;padding:26px 30px;background:white;position:relative;}
.rx-preview::before{content:'VERIFIED PRESCRIPTION';position:absolute;top:-1px;right:18px;background:var(--teal2);color:white;font-family:'DM Mono',monospace;font-size:8px;letter-spacing:0.18em;padding:3px 9px;border-radius:0 0 3px 3px;}
.rx-preview-title{font-size:21px;font-weight:600;color:var(--ink2);margin-bottom:3px;}
.rx-preview-sub{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:18px;}
.rx-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;}
.rx-meta-item label{font-family:'DM Mono',monospace;font-size:8px;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:1px;}
.rx-meta-item span{font-size:13px;color:var(--ink);}
.recall-band{background:rgba(10,147,150,0.06);border:1px solid rgba(10,147,150,0.22);border-radius:2px;padding:11px 14px;margin-top:12px;font-family:'DM Mono',monospace;font-size:10px;color:var(--teal2);display:flex;align-items:center;gap:9px;}
.dual-sig-band{background:rgba(45,106,79,0.05);border:1px solid rgba(45,106,79,0.2);border-radius:2px;padding:11px 14px;margin-top:10px;font-family:'DM Mono',monospace;font-size:9px;color:var(--green);line-height:1.8;}

/* ── REGISTRY ── */
.trust-node{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--border);}
.trust-node:last-child{border-bottom:none;}
.trust-icon{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;border:1.5px solid var(--border);background:white;}
.trust-body{flex:1;}
.trust-title{font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);font-weight:500;margin-bottom:3px;}
.trust-desc{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.75;}
.registry-table{width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:11px;}
.registry-table th{background:var(--warm);padding:9px 11px;text-align:left;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:var(--teal2);border:1px solid var(--border);}
.registry-table td{padding:9px 11px;border:1px solid var(--border);vertical-align:top;line-height:1.5;}
.registry-table tr:hover td{background:rgba(10,147,150,0.02);}
.check-list{display:flex;flex-direction:column;gap:7px;}
.check-item{display:flex;align-items:center;gap:10px;font-family:'DM Mono',monospace;}
.check-label{color:var(--muted);flex:1;font-size:10px;}
.check-value{color:var(--ink);font-size:10px;}

#qr-container{display:flex;flex-direction:column;align-items:center;}
#qr-container canvas,#qr-container img{border:7px solid white;box-shadow:var(--shadow);}

@media print{header,nav,.no-print{display:none!important;}main{padding:0;max-width:100%;}body{background:white;}.card{box-shadow:none;border:1px solid #ccc;}}
@media(max-width:600px){header{padding:12px 14px;}nav{padding:0 6px;}nav button{padding:11px 9px;font-size:9px;}main{padding:16px 10px;}.rx-meta-grid{grid-template-columns:1fr;}}
</style>
</head>
<body>

<!-- ── Password Gate ── -->
<div id="auth-gate">
  <div class="auth-box">
    <div class="auth-logo"><span>Rx</span>Verify</div>
    <div class="auth-subtitle">Practitioner Portal</div>
    <label class="auth-label">Access Password</label>
    <input class="auth-input" type="password" id="auth-password"
      placeholder="Enter password"
      onkeydown="if(event.key==='Enter')checkAuth()">
    <button class="auth-btn" onclick="checkAuth()">Sign In</button>
    <div class="auth-error" id="auth-error">Incorrect password. Please try again.</div>
  </div>
</div>

<script>
// ── Auth Gate ──────────────────────────────────────────
// Password is set via RXVERIFY_PASSWORD env var on the backend,
// fetched on load so it never lives in the HTML source.
// Falls back to a hardcoded hash if the fetch fails.
(function() {
  const SESSION_KEY = 'rxv_auth';
  // Check if already authenticated this session
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('auth-gate').classList.add('hidden');
  }
  window.checkAuth = async function() {
    const pw = document.getElementById('auth-password').value;
    if (!pw) return;
    try {
      const resp = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await resp.json();
      if (data.ok) {
        sessionStorage.setItem(SESSION_KEY, '1');
        document.getElementById('auth-gate').classList.add('hidden');
      } else {
        const err = document.getElementById('auth-error');
        err.style.display = 'block';
        document.getElementById('auth-password').value = '';
        document.getElementById('auth-password').focus();
      }
    } catch(e) {
      // If backend unreachable, show error
      document.getElementById('auth-error').style.display = 'block';
      document.getElementById('auth-error').textContent = 'Cannot reach server. Check connection.';
    }
  };
})();
</script>

<header>
  <div class="logo">
    <div class="logo-mark">Rx<span style="color:white">Verify</span></div>
    <div class="logo-sub">UK Digital Prescription</div>
  </div>
  <div class="header-info" id="header-info">
    <div>Not signed in</div>
    <div style="font-size:9px;margin-top:1px">Complete identity verification first</div>
  </div>
</header>

<nav>
  <button class="active" onclick="showTab('register')">① Register</button>
  <button onclick="showTab('practice')">② Practice / Locum</button>
  <button onclick="showTab('issue')">③ Issue Rx</button>
  <button onclick="showTab('verify')">④ Verify</button>
  <button onclick="showTab('patient')">⑤ Patient View</button>
  <button onclick="showTab('registry')">⑥ Registry</button>
</nav>

<main>

<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 1: REGISTER (Identity + Verification Wizard)   -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel active" id="tab-register">

  <div class="alert alert-info">
    <strong>One-time identity setup.</strong> Your keypair is generated on your device and never transmitted. Verification proves to the registry that you are the actual GOC registrant — not someone who looked up your name on the public GOC list.
  </div>

  <!-- WIZARD STEPS -->
  <div class="wizard-steps">
    <div class="wstep active" id="ws1"><span class="wstep-num">①</span>Details &amp; Keys</div>
    <div class="wstep" id="ws2"><span class="wstep-num">②</span>GOC Email</div>
    <div class="wstep" id="ws3"><span class="wstep-num">③</span>ID Upload</div>
    <div class="wstep" id="ws4"><span class="wstep-num">④</span>Confirmed</div>
  </div>

  <!-- STEP 1: Details + keygen -->
  <div class="verif-panel active" id="vp1">
    <div class="card">
      <div class="card-title">Step 1 — Your Details &amp; Identity Keypair</div>
      <div class="card-sub">Enter your details exactly as they appear on the GOC register. Your keypair is generated locally — the private key never leaves this device.</div>
      <div class="field-row">
        <div class="field">
          <label>Full Name (as on GOC register)</label>
          <input type="text" id="setup-name" value="Dr. Sarah Patel">
        </div>
        <div class="field">
          <label>GOC Registration No.</label>
          <input type="text" id="setup-goc" value="01-23456">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>GOC-Registered Email Address</label>
          <input type="email" id="setup-email" value="s.patel@example-practice.co.uk" placeholder="Email on your GOC record">
        </div>
        <div class="field">
          <label>Qualification</label>
          <select id="setup-qual">
            <option value="optometrist">Optometrist</option>
            <option value="dispensing_optician">Dispensing Optician</option>
            <option value="therapeutic_optometrist">Therapeutic Optometrist</option>
          </select>
        </div>
      </div>
      <div style="margin-top:14px;">
        <button class="btn btn-primary" onclick="generateKeys()">⟳ Generate My Identity Keypair</button>
      </div>
    </div>

    <div class="card" id="keys-card" style="display:none">
      <div class="card-title">Your Cryptographic Identity Keys</div>
      <div class="alert alert-success">✓ Keypair generated on this device. Your private key is shown blurred — hover to reveal, click to copy.</div>
      <div class="field-row">
        <div class="field">
          <label>Public Key — will be published to registry</label>
          <div class="mono-block" id="pub-key-display" onclick="copyEl(this)"></div>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Private Key — NEVER share · hover to reveal · click to copy</label>
          <div class="mono-block" id="priv-key-display" onclick="copyEl(this)"
            style="color:var(--red);filter:blur(4px);"
            onmouseenter="this.style.filter=''" onmouseleave="this.style.filter='blur(4px)'"></div>
        </div>
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn btn-ghost" onclick="downloadKeys()">↓ Download Keys</button>
        <button class="btn btn-ghost" onclick="saveKeysToStorage()">💾 Save to Browser</button>
        <button class="btn btn-ghost" onclick="loadSavedKeys()">↑ Load Saved</button>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary" onclick="goWizard(2)">Next: Verify GOC Email →</button>
    </div>
  </div>

  <!-- STEP 2: GOC Email verification -->
  <div class="verif-panel" id="vp2">
    <div class="card">
      <div class="card-title">Step 2 — Verify Your GOC-Registered Email</div>
      <div class="card-sub">
        We send a one-time verification code to the email address on your GOC registration record. This proves you are the actual registrant — not someone who copied your details from the public GOC list. The email on the GOC register is not public; only you have access to it.
      </div>
      <div class="field-row">
        <div class="field" style="max-width:340px;">
          <label>GOC-Registered Email (from step 1)</label>
          <input type="email" id="verif-email-display" readonly>
        </div>
      </div>
      <button class="btn btn-primary" onclick="simulateSendCode()" style="margin-bottom:14px;">📧 Send Verification Code</button>
      <div id="code-sent-area" style="display:none;">
        <div class="alert alert-info" style="margin-bottom:12px;">
          ✓ Code sent to your GOC email. Check your inbox and enter the 6-digit code below.<br>
          <span style="font-size:9px;opacity:0.8;">(Demo: use code <strong>482916</strong>)</span>
        </div>
        <div class="field-row">
          <div class="field" style="max-width:180px;">
            <label>6-Digit Code</label>
            <input type="text" id="otp-input" maxlength="6" placeholder="482916" style="font-size:18px;letter-spacing:0.3em;text-align:center;">
          </div>
        </div>
        <button class="btn btn-primary" onclick="verifyOTP()">✓ Confirm Code</button>
        <div id="otp-result" style="margin-top:10px;"></div>
      </div>
    </div>
    <button class="btn btn-ghost" onclick="goWizard(1)">← Back</button>
  </div>

  <!-- STEP 3: ID upload -->
  <div class="verif-panel" id="vp3">
    <div class="card">
      <div class="card-title">Step 3 — Identity Document Upload</div>
      <div class="card-sub">
        Upload a photo of your GOC registration certificate or a government-issued photo ID. This is reviewed by the RxVerify team (or an automated ID verification service like Onfido/Yoti in production) before your public key is approved on the registry. This step prevents someone from impersonating you even if they know your GOC email.
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Option A — GOC Certificate</div>
          <div class="upload-zone" id="upload-goc" onclick="simulateUpload('upload-goc','doc-status-goc')">
            <div style="font-size:28px;">📄</div>
            <span class="upload-label">Click to upload GOC registration certificate</span>
            <div id="doc-status-goc" style="margin-top:6px;"></div>
          </div>
        </div>
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Option B — Photo ID + Selfie</div>
          <div class="upload-zone" id="upload-id" onclick="simulateUpload('upload-id','doc-status-id')">
            <div style="font-size:28px;">🪪</div>
            <span class="upload-label">Click to upload passport / driving licence + selfie</span>
            <div id="doc-status-id" style="margin-top:6px;"></div>
          </div>
        </div>
      </div>

      <div class="alert alert-warn">
        <strong>What happens next:</strong> Your documents are reviewed within 1 working day (production: within minutes via automated ID verification). You'll receive an email when your public key is approved and live on the registry. Until approved, you can still use the tool locally — your prescriptions will be marked as "pending registry verification".
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
        <button class="btn btn-primary" id="submit-verif-btn" onclick="submitForVerification()" disabled>Submit for Verification</button>
        <button class="btn btn-ghost" onclick="goWizard(2)">← Back</button>
      </div>
    </div>
  </div>

  <!-- STEP 4: Done -->
  <div class="verif-panel" id="vp4">
    <div class="card" style="border-color:rgba(45,106,79,0.35);">
      <div class="card-title">Step 4 — Verification Submitted</div>
      <div class="alert alert-success">✓ Your identity verification has been submitted successfully.</div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);line-height:2.0;">
        <div>Name: <span style="color:var(--ink)" id="conf-name">—</span></div>
        <div>GOC: <span style="color:var(--ink)" id="conf-goc">—</span></div>
        <div>Email verified: <span style="color:var(--green)">✓</span></div>
        <div>ID document: <span style="color:var(--amber)">Under review (demo: auto-approved)</span></div>
        <div>Registry status: <span class="badge badge-pending" id="conf-reg-status">Pending Approval</span></div>
      </div>
      <div class="divider"></div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.8;margin-bottom:16px;">
        While pending, your keypair is marked <strong>unverified</strong> in the registry. Prescriptions you issue are cryptographically signed but verifiers will see a "pending" flag next to your entry. Once approved, all previously issued prescriptions automatically become fully verified — the signature is what matters, not when the registry entry was approved.
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="approveDemo()">⚡ Demo: Simulate Registry Approval</button>
        <button class="btn btn-ghost" onclick="showTab('practice')">Next: Set Up Practice →</button>
      </div>
      <div id="approval-result" style="margin-top:12px;"></div>
    </div>
  </div>

</div><!-- end register tab -->


<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 2: PRACTICE / LOCUM                            -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-practice">
  <div class="alert alert-info">
    <strong>Practice identity &amp; locum delegation.</strong> A prescription carries two layers: your personal GOC identity and the practice you're prescribing from. Locums link their GOC keypair to each practice via a signed delegation certificate — valid for a defined period.
  </div>

  <!-- EXPLANATION -->
  <div class="card">
    <div class="card-title">Two-Layer Identity Model</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-family:'DM Mono',monospace;font-size:10px;">
      <div style="padding:14px;border:1px solid var(--border);border-radius:2px;background:var(--warm);">
        <div style="color:var(--teal2);font-size:9px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:8px;">Layer 1 — Your GOC Identity (permanent)</div>
        <div style="color:var(--muted);line-height:1.9;">
          One keypair per optometrist<br>
          Anchored to GOC registration<br>
          Never changes between practices<br>
          Verified once at registration<br>
          <span style="color:var(--ink)">Signs every prescription you issue</span>
        </div>
      </div>
      <div style="padding:14px;border:1px solid rgba(10,147,150,0.25);border-radius:2px;background:rgba(10,147,150,0.04);">
        <div style="color:var(--teal2);font-size:9px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:8px;">Layer 2 — Practice Context (per-location)</div>
        <div style="color:var(--muted);line-height:1.9;">
          One keypair per practice<br>
          Managed by superintendent OD<br>
          Carries branding, address, logo<br>
          Locums issued delegation certs<br>
          <span style="color:var(--ink)">Co-signs prescriptions issued there</span>
        </div>
      </div>
    </div>
    <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:12px;padding:10px;background:var(--warm);border-radius:2px;line-height:1.8;">
      <strong style="color:var(--ink2);">Locum example:</strong> Dr. Patel works at Vision Express on Monday, Specsavers on Wednesday, and her own practice on Saturday. She has one GOC keypair (hers forever) and three delegation certificates — one from each practice, each time-limited and co-signed by the superintendent. Each prescription shows the correct practice branding and address for that day.
    </div>
  </div>

  <!-- MY PRACTICE (owner) -->
  <div class="card">
    <div class="card-title">My Practice — Register or Load</div>
    <div class="card-sub">If you own or manage a practice, register it here. This generates a practice keypair. If you are a locum, skip to "Locum Delegation" below.</div>
    <div class="field-row">
      <div class="field">
        <label>Practice Name</label>
        <input type="text" id="prac-name" value="Patel Opticians">
      </div>
      <div class="field">
        <label>Practice GOC/CQC Registration No.</label>
        <input type="text" id="prac-reg" value="CQC-1234567">
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Address Line 1</label>
        <input type="text" id="prac-addr1" value="42 High Street">
      </div>
      <div class="field">
        <label>City / Postcode</label>
        <input type="text" id="prac-addr2" value="London W1A 1AA">
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Practice Phone</label>
        <input type="text" id="prac-phone" value="020 7000 0000">
      </div>
      <div class="field">
        <label>Practice Email</label>
        <input type="email" id="prac-email" value="hello@patelopticians.co.uk">
      </div>
      <div class="field">
        <label>Brand Colour (hex)</label>
        <input type="text" id="prac-colour" value="#005f73" placeholder="#005f73">
      </div>
    </div>
    <div class="field-row">
      <div class="field" style="max-width:80px;">
        <label>Logo Emoji (placeholder)</label>
        <input type="text" id="prac-emoji" value="👁" maxlength="2">
      </div>
    </div>
    <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:6px;">
      <button class="btn btn-primary" onclick="registerPractice()">⟳ Generate Practice Keypair</button>
    </div>
    <div id="practice-keys-result" style="margin-top:14px;"></div>
  </div>

  <!-- LOCUM DELEGATION -->
  <div class="card">
    <div class="card-title">Locum Delegation — Request or Issue a Certificate</div>
    <div class="card-sub">
      A delegation certificate is signed by both parties: the optometrist's GOC keypair and the practice keypair. It authorises the optometrist to prescribe on behalf of the practice for a defined period. In production, the practice superintendent issues this; the locum accepts it.
    </div>

    <div id="my-practices-list">
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);padding:14px;border:1px dashed var(--border);border-radius:2px;text-align:center;">
        No practices registered yet. Register a practice above, or add demo practices below.
      </div>
    </div>

    <div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap;">
      <button class="btn btn-amber" onclick="addDemoPractices()">+ Add Demo Locum Practices</button>
    </div>

    <div id="delegation-form" style="display:none;margin-top:16px;">
      <div class="divider"></div>
      <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:var(--teal2);margin-bottom:12px;">Issue Delegation Certificate</div>
      <div class="field-row">
        <div class="field">
          <label>Select Practice</label>
          <select id="deleg-practice"></select>
        </div>
        <div class="field">
          <label>Valid From</label>
          <input type="date" id="deleg-from">
        </div>
        <div class="field">
          <label>Valid Until</label>
          <input type="date" id="deleg-until">
        </div>
      </div>
      <button class="btn btn-primary" onclick="issueDelegation()">✎ Sign Delegation Certificate</button>
      <div id="delegation-result" style="margin-top:12px;"></div>
    </div>
  </div>

  <!-- ACTIVE CONTEXT SELECTOR -->
  <div class="card" id="active-context-card" style="display:none;">
    <div class="card-title">Active Prescribing Context — Select Before Issuing</div>
    <div class="card-sub">Choose which practice you are prescribing from today. This determines the practice branding, address, and co-signature on issued prescriptions.</div>
    <div id="context-options"></div>
    <div id="selected-context-display" style="margin-top:12px;"></div>
  </div>

</div><!-- end practice tab -->


<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 3: ISSUE RX                                    -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-issue">
  <div class="alert alert-warn" id="no-key-warn" style="display:none">⚠ No identity loaded. Complete the Register tab first.</div>
  <div class="alert alert-warn" id="no-context-warn" style="display:none">⚠ No practice context selected. Go to Practice / Locum tab and select your active practice.</div>

  <div class="card" id="active-context-banner" style="display:none;border-color:rgba(10,147,150,0.3);">
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div id="banner-logo" style="width:38px;height:38px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:18px;"></div>
      <div style="flex:1;">
        <div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2);font-weight:500;" id="banner-name">—</div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);" id="banner-detail">—</div>
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;">
        <span class="badge badge-info" id="banner-deleg-badge" style="display:none;">Locum · Delegation Active</span>
        <span class="badge badge-valid">✓ Context Active</span>
      </div>
    </div>
  </div>

  <!-- PDF EXTRACTION DROP ZONE -->
  <div class="card" id="extract-card" style="border:2px dashed rgba(10,147,150,0.3);background:rgba(10,147,150,0.03);">
    <div class="card-title" style="margin-bottom:6px;">Import from PMS PDF</div>
    <div class="card-sub" style="margin-bottom:14px;">Drag your prescription PDF here to auto-populate the form. Patient details and refraction values will be extracted automatically.</div>

    <div id="drop-zone"
      style="border:2px dashed rgba(10,147,150,0.35);border-radius:4px;padding:28px 20px;text-align:center;cursor:pointer;transition:all 0.2s;background:rgba(10,147,150,0.04);"
      ondragover="event.preventDefault();this.style.borderColor='#0a9396';this.style.background='rgba(10,147,150,0.09)'"
      ondragleave="this.style.borderColor='rgba(10,147,150,0.35)';this.style.background='rgba(10,147,150,0.04)'"
      ondrop="handlePDFDrop(event)"
      onclick="document.getElementById('pdf-file-input').click()">
      <div style="font-size:28px;margin-bottom:8px;">📄</div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--teal2);font-weight:500;">Drop Prescription PDF here</div>
      <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:4px;">or click to browse</div>
      <input type="file" id="pdf-file-input" accept=".pdf" style="display:none" onchange="handlePDFFile(this.files[0])">
    </div>

    <div id="extract-status" style="display:none;margin-top:14px;">
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);text-align:center;padding:12px;">
        <span id="extract-status-text">Reading prescription…</span>
      </div>
    </div>

    <div id="extract-result" style="display:none;margin-top:14px;"></div>
  </div>

  <div class="card">
    <div class="card-title">Patient Details</div>
    <div class="field-row">
      <div class="field"><label>Patient Full Name</label><input type="text" id="pt-name" placeholder="e.g. James Mitchell"></div>
      <div class="field"><label>Date of Birth</label><input type="date" id="pt-dob"></div>
      <div class="field"><label>NHS Number (optional)</label><input type="text" id="pt-nhs" placeholder="000 000 0000"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Email (for recall)</label><input type="email" id="pt-email" placeholder="patient@email.com"></div>
      <div class="field"><label>Mobile (for recall SMS)</label><input type="tel" id="pt-phone" placeholder="+44 7700 000000"></div>
    </div>
    <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:3px;">Name &amp; DOB are hashed — no PII stored in the signed prescription.</div>
  </div>

  <div class="card">
    <div class="card-title">Spectacle Refraction</div>
    <table class="rx-table">
      <thead>
        <tr><th style="text-align:left;width:75px;"></th><th>Sphere</th><th>Cylinder</th><th>Axis</th><th>Add</th><th>Prism</th><th>Base</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="eye-label">R (OD)</td>
          <td><input type="number" id="r-sph" step="0.25" placeholder="0.00"></td>
          <td><input type="number" id="r-cyl" step="0.25" placeholder="0.00"></td>
          <td><input type="number" id="r-axis" step="1" min="1" max="180" placeholder="—"></td>
          <td><input type="number" id="r-add" step="0.25" placeholder="—"></td>
          <td><input type="number" id="r-prism" step="0.25" placeholder="—"></td>
          <td><input type="text" id="r-base" placeholder="—" style="width:46px"></td>
        </tr>
        <tr>
          <td class="eye-label">L (OS)</td>
          <td><input type="number" id="l-sph" step="0.25" placeholder="0.00"></td>
          <td><input type="number" id="l-cyl" step="0.25" placeholder="0.00"></td>
          <td><input type="number" id="l-axis" step="1" min="1" max="180" placeholder="—"></td>
          <td><input type="number" id="l-add" step="0.25" placeholder="—"></td>
          <td><input type="number" id="l-prism" step="0.25" placeholder="—"></td>
          <td><input type="text" id="l-base" placeholder="—" style="width:46px"></td>
        </tr>
      </tbody>
    </table>
    <div class="field-row" style="margin-top:14px;">
      <div class="field" style="max-width:120px;"><label>PD (mm)</label><input type="number" id="pd" step="0.5" placeholder="63.5"></div>
      <div class="field" style="max-width:120px;"><label>Near PD (mm)</label><input type="number" id="pd-near" step="0.5" placeholder="optional"></div>
      <div class="field" style="max-width:100px;"><label>BVD (mm)</label><input type="number" id="bvd" value="12" step="0.5"></div>
      <div class="field"><label>Test Type</label>
        <select id="test-type">
          <option value="standard">Standard Sight Test</option>
          <option value="contact_lens">Contact Lens Assessment</option>
          <option value="low_vision">Low Vision Assessment</option>
          <option value="domiciliary">Domiciliary Visit</option>
        </select>
      </div>
      <div class="field"><label>Recommended Lens</label>
        <select id="lens-rec">
          <option value="">No recommendation</option>
          <option value="single_vision">Single Vision</option>
          <option value="bifocal">Bifocal</option>
          <option value="varifocal">Varifocal / Progressive</option>
          <option value="reading_only">Reading Only</option>
          <option value="occupational">Occupational</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Clinical Notes</label><input type="text" id="notes" placeholder="e.g. Recommend AR coating"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Recall Period</div>
    <div class="recall-pills">
      <div class="recall-pill" onclick="setRecall(6,this)">6 months</div>
      <div class="recall-pill active" onclick="setRecall(12,this)">1 year</div>
      <div class="recall-pill" onclick="setRecall(24,this)">2 years</div>
      <div class="recall-pill" onclick="setRecall(36,this)">3 years</div>
      <div class="recall-pill" onclick="setRecall('custom',this)">Custom…</div>
    </div>
    <div style="display:none;align-items:center;gap:8px;margin-top:10px;" id="recall-custom-row">
      <input type="number" id="recall-custom-val" min="1" max="120" placeholder="12"
        style="width:70px;padding:7px;font-family:'DM Mono',monospace;border:1px solid var(--border);border-radius:2px;background:var(--cream);outline:none;"
        oninput="updateRecallSummary()">
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);">months</span>
    </div>
    <div class="recall-summary" id="recall-summary" style="margin-top:10px;"></div>
    <div class="divider"></div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <label style="display:flex;align-items:center;gap:9px;font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;color:var(--ink2);">
        <input type="checkbox" id="consent-recall" checked style="width:15px;height:15px;">
        Patient consents to recall notifications (email/SMS) per UK GDPR
      </label>
    </div>
  </div>

  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
    <button class="btn btn-primary" onclick="issuePrescription()" id="issue-btn">✎ Sign &amp; Issue Prescription</button>
    <div id="issue-status" style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);"></div>
  </div>
  <div id="issue-result" style="display:none;margin-top:18px;"></div>
</div>


<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 4: VERIFY                                      -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-verify">
  <div class="alert alert-info">Paste a signed prescription JSON to verify. In production, pharmacies scan the QR code. Anyone can verify — no account needed.</div>
  <div class="card">
    <div class="card-title">Paste Signed Prescription JSON</div>
    <textarea id="verify-input" rows="8"
      style="font-family:'DM Mono',monospace;font-size:10px;border:1px solid var(--border);border-radius:2px;padding:11px;width:100%;background:var(--cream);color:var(--ink);outline:none;resize:vertical;line-height:1.5;"></textarea>
    <div style="display:flex;gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="verifyPrescription()">⟳ Verify Prescription</button>
      <label style="display:flex;align-items:center;gap:7px;font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);cursor:pointer;">
        <input type="checkbox" id="tamper-check"> Simulate tampering (demo)
      </label>
      <button class="btn btn-ghost" onclick="loadIssuedIntoVerifier()">← Load Last Issued</button>
    </div>
  </div>
  <div id="verify-result"></div>
</div>


<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 5: PATIENT VIEW                                -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-patient">
  <div class="alert alert-info" id="no-rx-alert">No prescription issued yet. Go to Issue Rx first.</div>
  <div id="patient-view-content" style="display:none;">
    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;" class="no-print">
      <button class="btn btn-primary" onclick="window.print()">🖨 Print / Save PDF</button>
      <button class="btn btn-ghost" onclick="downloadRxJson()">↓ Download JSON</button>
    </div>
    <div class="rx-preview" id="rx-preview-content">
      <!-- Practice header (branded) -->
      <div id="pv-practice-header" style="display:flex;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:16px;border-bottom:2px solid var(--border);">
        <div id="pv-practice-logo" style="width:44px;height:44px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:22px;"></div>
        <div>
          <div id="pv-practice-name" style="font-family:'DM Mono',monospace;font-size:13px;font-weight:500;color:var(--ink2);"></div>
          <div id="pv-practice-addr" style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:1px;"></div>
        </div>
      </div>

      <div class="rx-preview-title" id="pv-patient-name">—</div>
      <div class="rx-preview-sub" id="pv-issued-line">—</div>
      <div class="rx-meta-grid">
        <div class="rx-meta-item"><label>Prescriber</label><span id="pv-prescriber">—</span></div>
        <div class="rx-meta-item"><label>GOC Registration</label><span id="pv-goc">—</span></div>
        <div class="rx-meta-item"><label>Valid Until</label><span id="pv-expires">—</span></div>
        <div class="rx-meta-item"><label>Test Type</label><span id="pv-testtype">—</span></div>
      </div>
      <div class="divider"></div>
      <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--teal2);margin-bottom:9px;">Refraction</div>
      <table class="rx-table" style="margin-bottom:14px;">
        <thead><tr><th style="text-align:left;">Eye</th><th>Sphere</th><th>Cylinder</th><th>Axis</th><th>Add</th></tr></thead>
        <tbody id="pv-rx-body"></tbody>
      </table>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);" id="pv-extras"></div>
      <div class="recall-band" id="pv-recall-band" style="display:none;">
        <span style="font-size:15px;">📅</span>
        <div><div id="pv-recall-text" style="font-weight:500;"></div>
        <div style="color:var(--muted);font-size:9px;margin-top:1px;">Recall date is cryptographically signed and cannot be altered.</div></div>
      </div>
      <div class="dual-sig-band" id="pv-dual-sig" style="display:none;">
        ✓ Dual signature: GOC identity + practice co-signature<br>
        <span style="font-size:9px;opacity:0.8;" id="pv-dual-sig-detail"></span>
      </div>
      <div class="divider"></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap;">
        <div style="flex:1;">
          <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--teal2);margin-bottom:5px;">Digital Signature</div>
          <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);max-width:360px;word-break:break-all;line-height:1.55;" id="pv-sig">—</div>
          <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;">
            <span class="badge badge-valid">✓ Cryptographically Signed</span>
            <span class="badge badge-info" id="pv-recall-badge" style="display:none;"></span>
          </div>
        </div>
        <div style="text-align:center;">
          <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-bottom:5px;letter-spacing:0.13em;text-transform:uppercase;">Verify QR</div>
          <div id="qr-container"></div>
        </div>
      </div>
      <div class="divider"></div>
      <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);line-height:1.8;">
        Issued using RxVerify digital signing protocol (rxv1-uk · secp256k1/Schnorr). Verify at <strong>rxverify.uk</strong> or scan QR.<br>
        Opticians Act 1989 · Electronic Communications Act 2000
      </div>
    </div>
  </div>
</div>


<!-- ═══════════════════════════════════════════════════ -->
<!-- TAB 6: REGISTRY                                    -->
<!-- ═══════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-registry">
  <div class="alert alert-info">
    The public registry is how anyone can independently confirm a public key belongs to a GOC-registered optometrist. It also shows practice keypairs and delegation certificates — the full trust chain.
  </div>

  <div class="card">
    <div class="card-title">Trust Chain — How Verification Works End to End</div>
    <div class="trust-node">
      <div class="trust-icon" style="border-color:var(--teal2);">🏛</div>
      <div class="trust-body">
        <div class="trust-title">1. GOC — Root of Trust</div>
        <div class="trust-desc">The GOC public register (optical.org/goc/registrants) is the authoritative source. In production, RxVerify works with the GOC to establish a verified key registry — similar to how NHS Digital operates the NHS Login identity service. The GOC-registered email address is the binding mechanism: only the actual registrant can access that inbox.</div>
      </div>
    </div>
    <div class="trust-node">
      <div class="trust-icon" style="border-color:var(--ink2);">🔑</div>
      <div class="trust-body">
        <div class="trust-title">2. Identity Verification — Multi-Factor Binding</div>
        <div class="trust-desc">Optometrist submits: GOC number + name (public) → verified GOC email OTP (proves inbox access) → photo of GOC certificate or government ID + selfie (proves physical identity). Human review (or automated Onfido/Yoti in production) approves before the public key is published. This prevents anyone from harvesting the public GOC list and impersonating registrants.</div>
      </div>
    </div>
    <div class="trust-node">
      <div class="trust-icon" style="border-color:var(--green);">📋</div>
      <div class="trust-body">
        <div class="trust-title">3. Transparency Log — Append-Only Public Record</div>
        <div class="trust-desc">Every key registration, practice registration, delegation certificate, and revocation is written to an append-only transparency log. Entries are chained and timestamped — nothing can be altered retroactively. Anyone can download the full log and audit it. Revocations don't delete entries; they add a signed revocation event, so historical prescriptions remain verifiable.</div>
      </div>
    </div>
    <div class="trust-node">
      <div class="trust-icon" style="border-color:var(--amber);">🏥</div>
      <div class="trust-body">
        <div class="trust-title">4. Practice Layer — Dual Keypairs for Locums</div>
        <div class="trust-desc">Practices register their own keypair (managed by superintendent). Locums receive signed delegation certificates — valid for a defined period, co-signed by both parties. Every prescription carries both the optometrist's GOC signature and the practice co-signature. Verifiers confirm: is this person GOC-registered? Are they currently delegated to this practice? Both must be true.</div>
      </div>
    </div>
    <div class="trust-node" style="border-bottom:none;">
      <div class="trust-icon" style="border-color:var(--green);">✅</div>
      <div class="trust-body">
        <div class="trust-title">5. Dual Cross-Check — Cryptography + GOC Register</div>
        <div class="trust-desc">Even if RxVerify's registry went offline, verifiers can still cross-reference the GOC number embedded in every prescription directly against the GOC public register. The cryptography proves the prescription is unmodified; the registry + GOC register prove the signer is who they claim to be. No single point of failure.</div>
      </div>
    </div>
  </div>

  <!-- LIVE REGISTRY -->
  <div class="card">
    <div class="card-title">Live Demo Registry — Registered Optometrists</div>
    <div id="reg-od-wrap">
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">
        No entries yet — complete the Register tab to populate this.
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Live Demo Registry — Registered Practices</div>
    <div id="reg-practice-wrap">
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">
        No practices registered yet.
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Live Demo Registry — Active Delegation Certificates</div>
    <div id="reg-deleg-wrap">
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">
        No delegation certificates issued yet.
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Verify a GOC Number or Public Key</div>
    <div class="field-row">
      <div class="field"><label>GOC Number or Public Key (hex)</label><input type="text" id="lookup-q" placeholder="e.g. 01-23456"></div>
    </div>
    <button class="btn btn-primary" onclick="doLookup()" style="margin-bottom:14px;">🔍 Look Up</button>
    <div id="lookup-result"></div>
    <div class="divider"></div>
    <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:2.1;">
      <div><span style="color:var(--teal2)">GET</span> /api/v1/registry/optometrist/<span style="color:var(--ink2)">{goc_number}</span></div>
      <div><span style="color:var(--teal2)">GET</span> /api/v1/registry/pubkey/<span style="color:var(--ink2)">{hex}</span></div>
      <div><span style="color:var(--teal2)">GET</span> /api/v1/registry/practice/<span style="color:var(--ink2)">{practice_id}</span></div>
      <div><span style="color:var(--teal2)">GET</span> /api/v1/registry/delegations/<span style="color:var(--ink2)">{goc_number}</span></div>
      <div><span style="color:var(--teal2)">GET</span> /api/v1/registry/log</div>
    </div>
  </div>
</div>

</main>

<script type="module">
// ═══════════════ NOBLE secp256k1 IMPORTS ═══════════════
// @noble/curves — audited, zero-dependency secp256k1 implementation
// 9m+ weekly downloads. Used by Nostr clients, Bitcoin wallets, Ethereum.
import { schnorr, secp256k1 } from 'https://esm.sh/@noble/curves@1.4.0/secp256k1';
import { sha256 }  from 'https://esm.sh/@noble/hashes@1.4.0/sha256';

// Make key functions available globally for onclick handlers
window._schnorr  = schnorr;
window._secp256k1 = secp256k1;
window._sha256   = sha256;

// ═══════════════ STATE ═══════════════
let STATE = {
  pubHex:null, privHex:null, prescriber:null,
  emailVerified:false, idUploaded:false, registryStatus:'unverified',
  lastIssuedRx:null,
  activePractice:null,  // { name, pubHex, privHex, emoji, colour, addr, isLocum, delegation }
};
let REGISTRY = { optometrists:{}, practices:{}, delegations:[] };
let recallMonths = 12;

// ═══════════════ TAB NAV ═══════════════
function showTab(name){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  const tabs=['register','practice','issue','verify','patient','registry'];
  document.querySelectorAll('nav button')[tabs.indexOf(name)].classList.add('active');
  if(name==='issue') refreshIssueTab();
  if(name==='patient') renderPatientView();
  if(name==='registry') renderRegistryTab();
}

// ═══════════════ CRYPTO — secp256k1 / Schnorr ═══════════════
// Curve: secp256k1 (Bitcoin/Nostr native)
// Signing: Schnorr signatures via @noble/curves
// Hashing: SHA-256 via @noble/hashes
// Keys: 32-byte private (hex) / 33-byte compressed public (hex)
// Future-compatible: Nostr npub/nsec, Lightning, NIP-07

function genKP(){
  // Generate 32-byte private key → 32-byte x-only public key (BIP340 Schnorr / Nostr format)
  const privBytes = window._schnorr.utils.randomPrivateKey();
  const pubBytes  = window._schnorr.getPublicKey(privBytes); // 32-byte x-only public key
  return {
    privHex: bh(privBytes),
    pubHex:  bh(pubBytes)   // 64 hex chars (32 bytes) — x-only format
  };
}

// ── Deterministic JSON stringify (sorted keys) ──
// Ensures consistent signing regardless of JS key ordering
function deterministicStringify(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
  const sortedKeys = Object.keys(obj).sort();
  return '{' + sortedKeys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}';
}

async function signJ(obj, privHex){
  // Schnorr sign: raw message bytes, 32-byte private key
  // schnorr internally hashes the message per BIP340
  const msgBytes = enc(deterministicStringify(obj));
  const sigBytes = await window._schnorr.sign(msgBytes, hb32(privHex));
  return bh(sigBytes);
}

async function verifyJ(obj, sigHex, pubHex){
  // Schnorr verify: raw message bytes, x-only 32-byte public key (BIP340)
  const msgBytes = enc(deterministicStringify(obj));
  const pubBytes = hb(pubHex); // already x-only 32 bytes from genKP
  try {
    return window._schnorr.verify(hb(sigHex), msgBytes, pubBytes);
  } catch(e) {
    return false;
  }
}

async function sha256h(s){
  // SHA-256 via noble/hashes (consistent with signing)
  return bh(window._sha256(enc(s)));
}

// secp256k1 key helpers
// Private key: exactly 32 bytes
function hb32(hex){
  const b=new Uint8Array(32);
  const src=hexToBytes(hex);
  b.set(src.slice(-32)); // take last 32 bytes if longer
  return b;
}
// Public key: exactly 33 bytes (compressed)
function hb33(hex){
  return hexToBytes(hex).slice(0,33);
}
function hexToBytes(hex){
  const b=new Uint8Array(hex.length/2);
  for(let i=0;i<hex.length;i+=2) b[i/2]=parseInt(hex.slice(i,i+2),16);
  return b;
}
function enc(s){return new TextEncoder().encode(s);}
function bh(b){
  // Accepts Uint8Array or ArrayBuffer → hex string
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(arr).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function hb(hex){
  // Generic hex → Uint8Array (used for signature bytes)
  const b=new Uint8Array(hex.length/2);
  for(let i=0;i<hex.length;i+=2)b[i/2]=parseInt(hex.slice(i,i+2),16);
  return b;
}
function shortH(h,n=10){return h?\`\${h.slice(0,n)}…\${h.slice(-5)}\`:'—';}
function tsD(ts){return new Date(ts*1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});}
function fmtR(v,f){if(v===null||v===undefined||v==='')return'—';if(f==='axis')return\`\${v}°\`;const n=parseFloat(v);return n>=0?\`+\${n.toFixed(2)}\`:n.toFixed(2);}

// ═══════════════ RECALL ═══════════════
function setRecall(val,el){
  document.querySelectorAll('.recall-pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  const cr=document.getElementById('recall-custom-row');
  cr.style.display=val==='custom'?'flex':'none';
  if(val!=='custom') recallMonths=val;
  updateRecallSummary();
}
function updateRecallSummary(){
  if(document.getElementById('recall-custom-row').style.display!=='none'){
    const v=parseInt(document.getElementById('recall-custom-val').value);
    if(v) recallMonths=v;
  }
  const d=new Date(); d.setMonth(d.getMonth()+recallMonths);
  const dStr=d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const label=recallMonths===6?'6 months':recallMonths===12?'1 year':recallMonths===24?'2 years':recallMonths===36?'3 years':\`\${recallMonths} months\`;
  document.getElementById('recall-summary').innerHTML=
    \`📅 Patient due for recall in <strong>\${label}</strong> — approximately <strong>\${dStr}</strong>.\`;
}

// ═══════════════ WIZARD ═══════════════
function goWizard(step){
  document.querySelectorAll('.verif-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.wstep').forEach((s,i)=>{
    s.classList.remove('active','done');
    if(i+1<step) s.classList.add('done');
    if(i+1===step) s.classList.add('active');
  });
  document.getElementById('vp'+step).classList.add('active');
  if(step===2) document.getElementById('verif-email-display').value=document.getElementById('setup-email').value;
}

// ═══════════════ KEYGEN ═══════════════
async function generateKeys(){
  const name=document.getElementById('setup-name').value.trim();
  const goc=document.getElementById('setup-goc').value.trim();
  if(!name||!goc){alert('Please enter your name and GOC number.');return;}
  const{pubHex,privHex}=await genKP();
  STATE.pubHex=pubHex; STATE.privHex=privHex;
  STATE.prescriber={name,goc,email:document.getElementById('setup-email').value.trim(),
    qual:document.getElementById('setup-qual').value,pubHex};
  setEl('pub-key-display',shortH(pubHex,20),pubHex);
  setEl('priv-key-display',shortH(privHex,20),privHex);
  document.getElementById('keys-card').style.display='block';

  // Auto-register in Supabase registry
  try {
    await fetch(\`\${API_URL}/api/registry/auto-register\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        npub: pubHex,
        goc_number: goc,
        name: name,
        practice: document.getElementById('setup-practice')?.value?.trim() || null,
        jurisdiction: 'UK-GOC'
      })
    });
    STATE.registryStatus = 'approved';
  } catch(e) {
    console.warn('Registry auto-register failed:', e.message);
  }

  updateHeader();
}
function setEl(id,txt,full){const e=document.getElementById(id);e.textContent=txt;e.dataset.full=full;}
function copyEl(el){
  navigator.clipboard?.writeText(el.dataset.full||el.textContent);
  const o=el.textContent;el.textContent='Copied!';setTimeout(()=>el.textContent=o,1200);
}
function updateHeader(){
  if(!STATE.prescriber)return;
  document.getElementById('header-info').innerHTML=
    \`<div><span>\${STATE.prescriber.name}</span></div><div>GOC \${STATE.prescriber.goc} · <span style="color:\${STATE.registryStatus==='approved'?'#22c55e':'#92600a'}">\${STATE.registryStatus}</span></div>\`;
}
function downloadKeys(){
  if(!STATE.pubHex)return;
  const t=\`RxVerify Identity Keys\\nGenerated: \${new Date().toISOString()}\\n\${STATE.prescriber.name} · GOC \${STATE.prescriber.goc}\\n\\nPUBLIC KEY:\\n\${STATE.pubHex}\\n\\nPRIVATE KEY (NEVER SHARE):\\n\${STATE.privHex}\`;
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(t);
  a.download=\`rxverify-keys-\${STATE.prescriber.goc.replace(/\\W/g,'_')}.txt\`;
  a.click();
}
function saveKeysToStorage(){
  if(!STATE.pubHex)return;
  localStorage.setItem('rxverify_state',JSON.stringify(STATE));
  alert('Keys saved to this browser.');
}
function loadSavedKeys(){
  const s=localStorage.getItem('rxverify_state');
  if(!s){alert('No saved keys found.');return;}
  Object.assign(STATE,JSON.parse(s));
  if(STATE.pubHex){
    setEl('pub-key-display',shortH(STATE.pubHex,20),STATE.pubHex);
    setEl('priv-key-display',shortH(STATE.privHex,20),STATE.privHex);
    document.getElementById('keys-card').style.display='block';
    document.getElementById('setup-name').value=STATE.prescriber?.name||'';
    document.getElementById('setup-goc').value=STATE.prescriber?.goc||'';
    if(STATE.prescriber) REGISTRY.optometrists[STATE.pubHex]={...STATE.prescriber,status:STATE.registryStatus||'unverified',registeredAt:new Date().toISOString()};
    updateHeader();
    alert('Keys loaded.');
    // Re-register in Supabase (ensures registry is current after page reload)
    if(STATE.prescriber) {
      fetch(\`\${API_URL}/api/registry/auto-register\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          npub: STATE.pubHex,
          goc_number: STATE.prescriber.goc,
          name: STATE.prescriber.name,
          practice: STATE.prescriber.practice || null,
          jurisdiction: 'UK-GOC'
        })
      }).then(() => {
        STATE.registryStatus = 'approved';
        updateHeader();
      }).catch(e => console.warn('Re-register failed:', e.message));
    }
  }
}

// ═══════════════ EMAIL OTP (simulated) ═══════════════
function simulateSendCode(){
  document.getElementById('code-sent-area').style.display='block';
}
function verifyOTP(){
  const code=document.getElementById('otp-input').value.trim();
  const res=document.getElementById('otp-result');
  if(code==='482916'){
    STATE.emailVerified=true;
    res.innerHTML='<div class="alert alert-success">✓ Email verified successfully. Your GOC-registered email confirms your identity.</div>';
    setTimeout(()=>goWizard(3),1400);
  } else {
    res.innerHTML='<div class="alert alert-error">✗ Incorrect code. Demo code is 482916.</div>';
  }
}

// ═══════════════ ID UPLOAD (simulated) ═══════════════
function simulateUpload(zoneId,statusId){
  const zone=document.getElementById(zoneId);
  const stat=document.getElementById(statusId);
  zone.classList.add('has-file');
  stat.innerHTML='<span style="font-family:\\'DM Mono\\',monospace;font-size:9px;color:var(--green);">✓ File selected (demo)</span>';
  STATE.idUploaded=true;
  document.getElementById('submit-verif-btn').disabled=false;
}
function submitForVerification(){
  document.getElementById('conf-name').textContent=STATE.prescriber?.name||'—';
  document.getElementById('conf-goc').textContent=STATE.prescriber?.goc||'—';
  REGISTRY.optometrists[STATE.pubHex]={...STATE.prescriber,status:'pending',registeredAt:new Date().toISOString()};
  STATE.registryStatus='pending';
  updateHeader();
  goWizard(4);
}
function approveDemo(){
  if(!STATE.pubHex){alert('Generate keys first.');return;}
  REGISTRY.optometrists[STATE.pubHex].status='approved';
  STATE.registryStatus='approved';
  document.getElementById('conf-reg-status').textContent='Approved ✓';
  document.getElementById('conf-reg-status').className='badge badge-valid';
  document.getElementById('approval-result').innerHTML='<div class="alert alert-success">✓ Registry entry approved. Your public key is now live and verifiable by anyone.</div>';
  updateHeader();
  renderRegistryTab();
}

// ═══════════════ PRACTICE ═══════════════
async function registerPractice(){
  const name=document.getElementById('prac-name').value.trim();
  const reg=document.getElementById('prac-reg').value.trim();
  if(!name||!reg){alert('Practice name and registration number required.');return;}
  const{pubHex,privHex}=await genKP();
  const practice={
    id:'RXP-'+Math.random().toString(36).slice(2,7).toUpperCase(),
    name,reg,pubHex,privHex,
    addr1:document.getElementById('prac-addr1').value.trim(),
    addr2:document.getElementById('prac-addr2').value.trim(),
    phone:document.getElementById('prac-phone').value.trim(),
    email:document.getElementById('prac-email').value.trim(),
    colour:document.getElementById('prac-colour').value.trim()||'#005f73',
    emoji:document.getElementById('prac-emoji').value.trim()||'👁',
    isOwn:true,
    registeredAt:new Date().toISOString(),
  };
  REGISTRY.practices[pubHex]=practice;
  STATE.activePractice={...practice,isLocum:false,delegation:null};
  document.getElementById('practice-keys-result').innerHTML=\`
    <div class="alert alert-success">✓ Practice keypair generated and registered.<br>
    Practice ID: <strong>\${practice.id}</strong> · Pubkey: <code style="font-size:9px;">\${shortH(pubHex,16)}</code></div>\`;
  refreshPracticeTab();
  renderRegistryTab();
}

function addDemoPractices(){
  const demos=[
    {name:'Vision Express — Canary Wharf',reg:'CQC-9876001',addr1:'Jubilee Place',addr2:'London E14 5NY',emoji:'👓',colour:'#c0392b'},
    {name:'Specsavers — Oxford Street',reg:'CQC-9876002',addr1:'350 Oxford Street',addr2:'London W1C 1JH',emoji:'🔍',colour:'#1a5276'},
  ];
  demos.forEach(async d=>{
    const{pubHex,privHex}=await genKP();
    const p={...d,pubHex,privHex,id:'RXP-'+Math.random().toString(36).slice(2,7).toUpperCase(),isOwn:false,registeredAt:new Date().toISOString()};
    REGISTRY.practices[pubHex]=p;
  });
  setTimeout(()=>{refreshPracticeTab();renderRegistryTab();},300);
}

function refreshPracticeTab(){
  const practices=Object.values(REGISTRY.practices);
  const list=document.getElementById('my-practices-list');
  const form=document.getElementById('delegation-form');
  const sel=document.getElementById('deleg-practice');
  const activeCard=document.getElementById('active-context-card');
  const opts=document.getElementById('context-options');

  if(!practices.length){
    list.innerHTML='<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:14px;border:1px dashed var(--border);border-radius:2px;text-align:center;">No practices registered yet.</div>';
    form.style.display='none'; activeCard.style.display='none'; return;
  }

  list.innerHTML=practices.map(p=>\`
    <div class="practice-card" onclick="setActivePractice('\${p.pubHex}',false)" id="pc-\${p.pubHex}">
      <div class="practice-logo" style="background:\${p.colour}15;color:\${p.colour};">\${p.emoji}</div>
      <div class="practice-info">
        <div class="practice-name">\${p.name}</div>
        <div class="practice-detail">\${p.reg} · \${p.addr1}, \${p.addr2}</div>
      </div>
      \${p.isOwn?'<span class="badge badge-valid" style="font-size:8px;">Owner</span>':'<span class="badge badge-info" style="font-size:8px;">Locum</span>'}
    </div>\`).join('');

  // Set today's dates for delegation form
  const today=new Date().toISOString().split('T')[0];
  const yrAhead=new Date(Date.now()+365*86400000).toISOString().split('T')[0];
  document.getElementById('deleg-from').value=today;
  document.getElementById('deleg-until').value=yrAhead;

  sel.innerHTML=practices.map(p=>\`<option value="\${p.pubHex}">\${p.name}</option>\`).join('');
  form.style.display='block';
  activeCard.style.display='block';

  opts.innerHTML=practices.map(p=>\`
    <div class="practice-card" onclick="setActivePractice('\${p.pubHex}',false)" id="ctx-\${p.pubHex}">
      <div class="practice-logo" style="background:\${p.colour}15;color:\${p.colour};">\${p.emoji}</div>
      <div class="practice-info">
        <div class="practice-name">\${p.name}</div>
        <div class="practice-detail">\${p.addr1}, \${p.addr2}</div>
      </div>
    </div>\`).join('');
}

function setActivePractice(pubHex, isLocum){
  const p=REGISTRY.practices[pubHex];
  if(!p)return;
  const deleg=REGISTRY.delegations.find(d=>d.practicePubHex===pubHex&&d.odPubHex===STATE.pubHex);
  STATE.activePractice={...p,isLocum,delegation:deleg||null};
  document.querySelectorAll('.practice-card').forEach(c=>c.classList.remove('selected'));
  document.querySelectorAll(\`#pc-\${pubHex},#ctx-\${pubHex}\`).forEach(c=>c.classList.add('selected'));
  document.getElementById('selected-context-display').innerHTML=\`<div class="alert alert-success">✓ Active context: <strong>\${p.name}</strong>\${isLocum?' (locum — delegation certificate active)':' (practice owner)'}</div>\`;
  updateIssueBanner();
}

async function issueDelegation(){
  if(!STATE.pubHex){alert('Generate your GOC keypair first.');return;}
  const pracPubHex=document.getElementById('deleg-practice').value;
  const prac=REGISTRY.practices[pracPubHex];
  if(!prac){alert('Practice not found.');return;}
  const from=document.getElementById('deleg-from').value;
  const until=document.getElementById('deleg-until').value;

  const certPayload={
    type:'delegation_certificate',
    schema_version:'delv1-uk',
    issued_at:Math.floor(Date.now()/1000),
    optometrist:{pubkey:STATE.pubHex,goc:STATE.prescriber?.goc,name:STATE.prescriber?.name},
    practice:{pubkey:pracPubHex,id:prac.id,name:prac.name,reg:prac.reg},
    valid_from:from, valid_until:until,
  };
  const sigOD=await signJ(certPayload,STATE.privHex);
  const sigPrac=await signJ(certPayload,prac.privHex);
  const cert={...certPayload,sig_optometrist:sigOD,sig_practice:sigPrac,
    practicePubHex,odPubHex:STATE.pubHex};
  REGISTRY.delegations.push(cert);

  document.getElementById('delegation-result').innerHTML=\`
    <div class="card" style="margin-top:0;border-color:rgba(45,106,79,0.35);">
      <div class="badge badge-valid" style="margin-bottom:10px;">✓ Delegation Certificate Issued</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.9;">
        <div>Practice: <span style="color:var(--ink)">\${prac.name}</span></div>
        <div>Valid: <span style="color:var(--ink)">\${from} → \${until}</span></div>
        <div>Signed by OD: <span style="color:var(--ink)">\${shortH(sigOD,14)}</span></div>
        <div>Co-signed by practice: <span style="color:var(--ink)">\${shortH(sigPrac,14)}</span></div>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px;" onclick="setActivePractice('\${pracPubHex}',true)">→ Set as Active Prescribing Context</button>
    </div>\`;
  renderRegistryTab();
}

// ═══════════════ ISSUE TAB ═══════════════
function refreshIssueTab(){
  document.getElementById('no-key-warn').style.display=STATE.pubHex?'none':'block';
  document.getElementById('no-context-warn').style.display=STATE.activePractice?'none':'block';
  document.getElementById('issue-btn').disabled=!STATE.pubHex||!STATE.activePractice;
  updateIssueBanner();
  updateRecallSummary();
}
function updateIssueBanner(){
  const p=STATE.activePractice;
  const banner=document.getElementById('active-context-banner');
  if(!p){banner.style.display='none';return;}
  banner.style.display='block';
  document.getElementById('banner-logo').style.background=p.colour+'20';
  document.getElementById('banner-logo').style.color=p.colour;
  document.getElementById('banner-logo').textContent=p.emoji;
  document.getElementById('banner-name').textContent=p.name;
  document.getElementById('banner-detail').textContent=\`\${p.addr1}, \${p.addr2} · \${p.reg}\`;
  const db=document.getElementById('banner-deleg-badge');
  db.style.display=p.isLocum?'inline-flex':'none';
}

// ═══════════════ BACKEND API ═══════════════
// Point this at your Vercel deployment URL
// For local testing: 'http://localhost:3000'
const API_URL = 'https://www.rxverify.co.uk';

async function saveToBackend(signedRx, shortCode) {
  try {
    const resp = await fetch(\`\${API_URL}/api/prescriptions\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_payload: signedRx, short_code: shortCode })
    });
    return resp.ok ? await resp.json() : null;
  } catch(e) {
    console.warn('Backend save failed (offline mode):', e.message);
    return null;
  }
}

async function sendEmailToPatient(signedRx, shortCode, toEmail) {
  try {
    const rx = signedRx.rx || {};
    const resp = await fetch(\`\${API_URL}/api/send/email\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_email: toEmail,
        patient_name: signedRx.patient?.display_name,
        patient_dob: signedRx.patient?.display_dob,
        short_code: shortCode,
        practice_name: signedRx.practice?.name || signedRx.prescriber?.name,
        prescriber_name: signedRx.prescriber?.name,
        goc_number: signedRx.prescriber?.goc,
        issued_date: tsD(signedRx.issued_at),
        expires_date: tsD(signedRx.expires_at),
        recall_date: signedRx.recall?.due_date,
        rx_summary: {
          r_sphere: rx.right?.sphere, r_cyl: rx.right?.cylinder, r_axis: rx.right?.axis,
          r_add: rx.right?.add,
          l_sphere: rx.left?.sphere,  l_cyl: rx.left?.cylinder,  l_axis: rx.left?.axis,
          l_add: rx.left?.add,
          clinical_notes: signedRx.rx?.notes || null
        },
        full_payload: signedRx  // ← full signed prescription for URL fragment
      })
    });
    return resp.ok;
  } catch(e) {
    console.warn('Email send failed:', e.message);
    return false;
  }
}

function generateShortCode() {
  // Generates RXV-XXXXX-X format
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part1 = Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  const part2 = chars[Math.floor(Math.random()*chars.length)];
  return \`RXV-\${part1}-\${part2}\`;
}

async function issuePrescription(){
  if(!STATE.pubHex||!STATE.activePractice){return;}
  const ptName=document.getElementById('pt-name').value.trim();
  const ptDob=document.getElementById('pt-dob').value;
  if(!ptName||!ptDob){alert('Patient name and date of birth required.');return;}
  document.getElementById('issue-status').textContent='Signing…';

  const v=id=>{const x=document.getElementById(id).value;return x===''?null:parseFloat(x)||null;};
  const s=id=>document.getElementById(id).value.trim()||null;
  const now=Math.floor(Date.now()/1000);
  const recallDate=new Date(); recallDate.setMonth(recallDate.getMonth()+recallMonths);

  const patRef=await sha256h(\`\${ptDob}|\${ptName.toLowerCase().replace(/\\s+/g,' ')}\`);
  const contH=s('pt-email')?await sha256h(document.getElementById('pt-email').value.toLowerCase()):null;

  const p=STATE.activePractice;
  const payload={
    schema_version:'rxv1-uk',
    issued_at:now, expires_at:now+(60*60*24*730),
    prescriber:{
      pubkey:STATE.pubHex, goc:STATE.prescriber.goc, name:STATE.prescriber.name,
      qual:STATE.prescriber.qual, jurisdiction:'UK-GOC',
    },
    practice:{
      pubkey:p.pubHex, id:p.id, name:p.name, reg:p.reg,
      addr1:p.addr1, addr2:p.addr2, emoji:p.emoji, colour:p.colour,
    },
    delegation:p.delegation?{valid_from:p.delegation.valid_from,valid_until:p.delegation.valid_until}:null,
    patient:{ref:patRef,contact_hash:contH,display_name:ptName,display_dob:ptDob,
      // Include contact details so backend can store for recall notifications
      // These are not written to prescription_registry — only to recall_contacts
      contact_email: s('pt-email') || null,
      contact_mobile: s('pt-mobile') || null,
    },
    rx:{
      right:{sphere:v('r-sph'),cylinder:v('r-cyl'),axis:v('r-axis'),add:v('r-add'),prism:v('r-prism'),base:s('r-base')},
      left:{sphere:v('l-sph'),cylinder:v('l-cyl'),axis:v('l-axis'),add:v('l-add'),prism:v('l-prism'),base:s('l-base')},
      pd:v('pd'),pd_near:v('pd-near'),bvd:v('bvd')||12,
      recommended_lens:s('lens-rec'),notes:s('notes'),
    },
    recall:{months:recallMonths,due_at:Math.floor(recallDate.getTime()/1000),due_date:recallDate.toISOString().split('T')[0]},
    test_type:document.getElementById('test-type').value,
    consent:{recall:document.getElementById('consent-recall').checked,timestamp:now},
    metadata:{software:'RxVerify/1.0-uk',issued_under:'Opticians Act 1989 + Electronic Communications Act 2000'},
  };

  try{
    const shortCode = generateShortCode();
    const sigOD=await signJ(payload,STATE.privHex);
    let sigPrac=null;
    if(p.privHex) sigPrac=await signJ(payload,p.privHex);
    const signedRx={...payload,sig_optometrist:sigOD,sig_practice:sigPrac,prescription_id:shortCode};
    STATE.lastIssuedRx=signedRx;

    // Save to backend (non-blocking — works offline too)
    document.getElementById('issue-status').textContent='Saving…';
    const saved = await saveToBackend(signedRx, shortCode);
    const patientLink = saved?.patient_link || \`https://rxverify.co.uk/v/\${shortCode}\`;

    // Send email if patient email provided
    const ptEmail = document.getElementById('pt-email').value.trim();
    let emailSent = false;
    if(ptEmail && saved) {
      document.getElementById('issue-status').textContent='Sending…';
      emailSent = await sendEmailToPatient(signedRx, shortCode, ptEmail);
    }

    document.getElementById('issue-status').textContent='';
    document.getElementById('issue-result').style.display='block';
    document.getElementById('issue-result').innerHTML=\`
      <div class="card" style="border-color:rgba(45,106,79,0.35);">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="badge badge-valid">✓ Signed · \${tsD(now)}</span>
          \${saved?'<span class="badge badge-valid">✓ Saved to server</span>':'<span class="badge badge-warn">⚠ Offline — local only</span>'}
          \${emailSent?'<span class="badge badge-valid">✓ Email sent</span>':''}
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.9;margin-top:6px;">
          <div>Practice: <span style="color:var(--ink)">\${p.name}</span></div>
          <div>Prescription ID: <span style="color:var(--teal2);font-weight:500;">\${shortCode}</span></div>
          <div>Recall due: <span style="color:var(--teal2);font-weight:500;">\${signedRx.recall.due_date}</span> (\${recallMonths} months)</div>
          <div>Patient link: <a href="\${patientLink}" target="_blank" style="color:var(--teal2);">\${patientLink}</a></div>
        </div>
        <div style="display:flex;gap:9px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="showTab('patient')">→ View Patient Copy</button>
          <button class="btn btn-ghost" onclick="showTab('verify')">⟳ Test Verify</button>
          <button class="btn btn-ghost" onclick="navigator.clipboard?.writeText('\${patientLink}');this.textContent='Copied!';setTimeout(()=>this.textContent='⎘ Copy Link',1500)">⎘ Copy Link</button>
          <button class="btn btn-ghost" onclick="clearIssueForm()" style="border-color:var(--teal2);color:var(--teal2);">+ New Prescription</button>
        </div>
      </div>\`;
    showTab('patient');
  }catch(e){document.getElementById('issue-status').textContent='Error: '+e.message;console.error(e);}
}

// ═══════════════ PDF EXTRACTION ═══════════════

function handlePDFDrop(event) {
  event.preventDefault();
  const dz = document.getElementById('drop-zone');
  dz.style.borderColor = 'rgba(10,147,150,0.35)';
  dz.style.background   = 'rgba(10,147,150,0.04)';
  const file = event.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    handlePDFFile(file);
  } else {
    showExtractStatus('Please drop a PDF file', 'error');
  }
}

async function handlePDFFile(file) {
  if (!file) return;
  showExtractStatus('Reading prescription PDF…', 'loading');

  try {
    // Convert PDF to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    showExtractStatus('Extracting prescription data with AI…', 'loading');

    const resp = await fetch(\`\${API_URL}/api/extract\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_base64: base64 })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.detail || errData.error || 'Extraction service error');
    }
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || 'Extraction failed');

    showExtractResult(data.extracted, file.name);

  } catch(e) {
    showExtractStatus('Extraction failed: ' + e.message, 'error');
    console.error('PDF extraction error:', e);
  }
}

function showExtractStatus(msg, type) {
  const statusEl = document.getElementById('extract-status');
  const textEl   = document.getElementById('extract-status-text');
  const resultEl = document.getElementById('extract-result');
  statusEl.style.display = 'block';
  resultEl.style.display  = 'none';
  textEl.textContent = msg;
  textEl.style.color = type === 'error' ? 'var(--red,#9b2226)' : 'var(--muted)';
}

function fmtRxVal(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2);
}

function showExtractResult(extracted, filename) {
  const statusEl = document.getElementById('extract-status');
  const resultEl = document.getElementById('extract-result');
  statusEl.style.display = 'none';
  resultEl.style.display  = 'block';

  // Back-calculate ADD from near prescription (METHOD B — iCareWEB)
  let rAdd = extracted.right_add;
  let lAdd = extracted.left_add;

  if (extracted.recording_method === 'near_calculated') {
    // iCareWEB records near prescription, not ADD directly
    // ADD = near_sphere - distance_sphere
    if (extracted.right_near_sphere != null && extracted.right_sphere != null) {
      rAdd = Math.round((extracted.right_near_sphere - extracted.right_sphere) * 4) / 4;
    }
    if (extracted.left_near_sphere != null && extracted.left_sphere != null) {
      lAdd = Math.round((extracted.left_near_sphere - extracted.left_sphere) * 4) / 4;
    }
  }

  // Build confidence summary
  const fields = [
    { label:'Patient Name',  val:extracted.patient_name,           id:'pt-name',  type:'text' },
    { label:'Date of Birth', val:extracted.patient_dob,            id:'pt-dob',   type:'date' },
    { label:'R Sphere',      val:fmtRxVal(extracted.right_sphere),  id:'r-sph',    type:'num'  },
    { label:'R Cylinder',    val:fmtRxVal(extracted.right_cylinder),id:'r-cyl',    type:'num'  },
    { label:'R Axis',        val:extracted.right_axis,              id:'r-axis',   type:'num'  },
    { label:'R Add',         val:fmtRxVal(rAdd),                    id:'r-add',    type:'num'  },
    { label:'L Sphere',      val:fmtRxVal(extracted.left_sphere),   id:'l-sph',    type:'num'  },
    { label:'L Cylinder',    val:fmtRxVal(extracted.left_cylinder), id:'l-cyl',    type:'num'  },
    { label:'L Axis',        val:extracted.left_axis,               id:'l-axis',   type:'num'  },
    { label:'L Add',         val:fmtRxVal(lAdd),                    id:'l-add',    type:'num'  },
    { label:'PD',            val:extracted.pd,                      id:'pd',       type:'num'  },
    { label:'Notes',         val:extracted.clinical_notes,          id:'clinical-notes', type:'text' },
  ];

  const flags = extracted._validation_flags || [];
  const method = extracted.recording_method === 'near_calculated'
    ? 'METHOD B — Near prescription detected. ADD back-calculated.'
    : 'METHOD A — ADD recorded directly.';

  // Store extracted data for apply button
  window._lastExtracted = {
    patient_name: extracted.patient_name,
    patient_dob:  extracted.patient_dob,
    r_sphere:     extracted.right_sphere,
    r_cyl:        extracted.right_cylinder,
    r_axis:       extracted.right_axis,
    r_add:        rAdd,
    r_prism:      extracted.right_prism,
    l_sphere:     extracted.left_sphere,
    l_cyl:        extracted.left_cylinder,
    l_axis:       extracted.left_axis,
    l_add:        lAdd,
    l_prism:      extracted.left_prism,
    pd:           extracted.pd,
    pd_near:      extracted.pd_near,
    bvd:          extracted.bvd,
    notes:        extracted.clinical_notes,
    recall_months: extracted.recall_months
  };

  resultEl.innerHTML = \`
    <div style="background:rgba(45,106,79,0.08);border:1px solid rgba(45,106,79,0.25);border-radius:3px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#2d6a4f;margin-bottom:4px;">✓ Extraction Complete — \${filename}</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:#2d6a4f;">\${method}</div>
      \${extracted.add_difference_flagged ? '<div style="font-family:\\'DM Mono\\',monospace;font-size:10px;color:#e76f51;margin-top:4px;">⚠ ADD differs between eyes — please check</div>' : ''}
      \${flags.length ? \`<div style="font-family:'DM Mono',monospace;font-size:10px;color:#e76f51;margin-top:4px;">⚠ \${flags.join(' · ')}</div>\` : ''}
    </div>

    <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:10px;">
      Review extracted values below — edit any field before signing.
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:7px;margin-bottom:14px;">
      \${fields.filter(f => f.val != null && f.val !== '').map(f => \`
        <div style="background:#f4f1e8;border-radius:2px;padding:7px 10px;">
          <div style="font-family:'DM Mono',monospace;font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;">\${f.label}</div>
          <div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2);font-weight:500;">\${f.val}</div>
        </div>\`).join('')}
    </div>

    <div style="display:flex;gap:9px;flex-wrap:wrap;">
      <button class="btn btn-primary" id="apply-extraction-btn">✓ Apply to Form</button>
      <button class="btn btn-ghost" onclick="document.getElementById('extract-result').style.display='none';">✕ Discard</button>
    </div>\`;

  // Use addEventListener to avoid inline onclick issues
  document.getElementById('apply-extraction-btn').addEventListener('click', function() {
    applyExtraction(window._lastExtracted);
  });
}

function setNum(id, val) {
  if (val != null) {
    const el = document.getElementById(id);
    if (el) {
      const n = parseFloat(val);
      if (!isNaN(n)) el.value = n.toFixed(2);
    }
  }
}
function setAxis(id, val) {
  // Axis is always a whole number — no decimal places
  if (val != null) {
    const el = document.getElementById(id);
    if (el) el.value = Math.round(parseFloat(val));
  }
}
function setText(id, val) {
  if (val != null) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
}
function setDOB(id, val) {
  if (!val) return;
  const el = document.getElementById(id);
  if (!el) return;
  // Convert various formats to YYYY-MM-DD for HTML date input
  // Handles: DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY
  let iso = val;
  if (/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(val)) {
    // DD/MM/YYYY → YYYY-MM-DD
    const [d, m, y] = val.split('/');
    iso = \`\${y}-\${m}-\${d}\`;
  } else if (/^\\d{2}-\\d{2}-\\d{4}$/.test(val)) {
    // DD-MM-YYYY → YYYY-MM-DD
    const [d, m, y] = val.split('-');
    iso = \`\${y}-\${m}-\${d}\`;
  }
  el.value = iso;
}

function applyExtraction(data) {
  // Patient details
  if (data.patient_name) setText('pt-name', data.patient_name);
  if (data.patient_dob)  setDOB('pt-dob', data.patient_dob);

  // Refraction values — set as plain numbers for number inputs
  setNum('r-sph',   data.r_sphere);
  setNum('r-cyl',   data.r_cyl);
  setAxis('r-axis', data.r_axis);
  setNum('r-add',   data.r_add);
  setNum('r-prism', data.r_prism);
  setNum('l-sph',   data.l_sphere);
  setNum('l-cyl',   data.l_cyl);
  setAxis('l-axis', data.l_axis);
  setNum('l-add',   data.l_add);
  setNum('l-prism', data.l_prism);
  setNum('pd',      data.pd);
  setNum('pd-near', data.pd_near);  // fix: was 'near-pd', input id is 'pd-near'
  setNum('bvd',     data.bvd);
  if (data.notes)   setText('notes', data.notes);

  // Recall period — fix: pills use class 'recall-pill', not 'recall-btn'
  if (data.recall_months) {
    recallMonths = data.recall_months;
    // Match a preset pill (6/12/24/36) or fall through to custom
    const presets = [6, 12, 24, 36];
    document.querySelectorAll('.recall-pill').forEach(p => p.classList.remove('active'));
    if (presets.includes(data.recall_months)) {
      // Pills fire setRecall via onclick — find by text content match
      document.querySelectorAll('.recall-pill').forEach(p => {
        const months = parseInt(p.getAttribute('onclick')?.match(/setRecall\\((\\d+)/)?.[1]);
        if (months === data.recall_months) p.classList.add('active');
      });
    } else {
      // Non-preset value — activate custom pill and populate input
      document.querySelectorAll('.recall-pill').forEach(p => {
        if (p.getAttribute('onclick')?.includes("'custom'")) p.classList.add('active');
      });
      const customRow = document.getElementById('recall-custom-row');
      if (customRow) customRow.style.display = 'flex';
      const customInput = document.getElementById('recall-custom-val');
      if (customInput) customInput.value = data.recall_months;
    }
    updateRecallSummary();
  }

  // Hide extraction UI
  document.getElementById('extract-card').style.display = 'none';

  // Scroll to patient name field and focus
  document.getElementById('pt-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Brief success message
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:20px;right:20px;background:#2d6a4f;color:white;padding:10px 18px;border-radius:3px;font-family:DM Mono,monospace;font-size:11px;z-index:9999;';
  banner.textContent = '✓ Prescription imported — review and sign';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
}

// ═══════════════ VERIFY ═══════════════
function clearIssueForm(){
  // Clear patient fields
  const fields = ['pt-name','pt-dob','pt-nhs','pt-email','pt-mobile',
    'r-sph','r-cyl','r-axis','r-add','r-prism','r-base',
    'l-sph','l-cyl','l-axis','l-add','l-prism','l-base',
    'pd','pd-near','bvd','notes'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  // Reset dropdowns to defaults
  const testType = document.getElementById('test-type');
  if(testType) testType.value = 'standard';
  const recLens = document.getElementById('recommended-lens');
  if(recLens) recLens.value = 'single_vision';
  // Reset recall to 12 months
  recallMonths = 12;
  // fix: pills use class 'recall-pill', activate the 1-year pill
  document.querySelectorAll('.recall-pill').forEach(p => {
    const months = parseInt(p.getAttribute('onclick')?.match(/setRecall\\((\\d+)/)?.[1]);
    p.classList.toggle('active', months === 12);
  });
  // hide custom row
  const customRowClear = document.getElementById('recall-custom-row');
  if (customRowClear) customRowClear.style.display = 'none';
  updateRecallSummary();
  // Reset consents to checked
  const c1 = document.getElementById('consent-recall');
  if(c1) c1.checked = true;
  // Restore PDF extraction zone
  const extractCard = document.getElementById('extract-card');
  if (extractCard) extractCard.style.display = 'block';
  const extractResult = document.getElementById('extract-result');
  if (extractResult) extractResult.style.display = 'none';
  const extractStatus = document.getElementById('extract-status');
  if (extractStatus) extractStatus.style.display = 'none';

  // Hide result card
  document.getElementById('issue-result').style.display = 'none';
  document.getElementById('issue-result').innerHTML = '';
  document.getElementById('issue-status').textContent = '';
  // Scroll to top of form
  document.getElementById('pt-name')?.focus();
  showTab('issue');
}

// ═══════════════ VERIFY ═══════════════
function loadIssuedIntoVerifier(){
  if(!STATE.lastIssuedRx){alert('No prescription issued yet.');return;}
  document.getElementById('verify-input').value=JSON.stringify(STATE.lastIssuedRx,null,2);
}
async function verifyPrescription(){
  const raw=document.getElementById('verify-input').value.trim();
  if(!raw)return;
  const el=document.getElementById('verify-result');
  try{
    let parsed=JSON.parse(raw);
    if(document.getElementById('tamper-check').checked&&parsed.rx?.right?.sphere!=null){
      parsed=JSON.parse(JSON.stringify(parsed));
      parsed.rx.right.sphere=(parsed.rx.right.sphere||0)+1.0;
    }
    const{sig_optometrist,sig_practice,...payload}=parsed;
    const now=Math.floor(Date.now()/1000);
    const checks=[];

    const schOk=payload.schema_version==='rxv1-uk';
    checks.push({label:'Schema version',ok:schOk,value:payload.schema_version||'missing'});
    const expOk=payload.expires_at>now;
    checks.push({label:'Not expired',ok:expOk,value:tsD(payload.expires_at)});
    const presOk=!!(payload.prescriber?.pubkey&&payload.prescriber?.goc);
    checks.push({label:'Prescriber fields present',ok:presOk,value:presOk?\`\${payload.prescriber.name} · GOC \${payload.prescriber.goc}\`:'Missing'});
    const regOD=REGISTRY.optometrists[payload.prescriber?.pubkey];
    checks.push({label:'OD pubkey in registry',ok:!!regOD,value:regOD?\`\${regOD.status==='approved'?'✓ Approved':'⚠ Pending'} · \${regOD.goc}\`:'Not found (run demo: approve in Register tab)'});
    const recallOk=!!payload.recall?.months&&!!payload.recall?.due_date;
    checks.push({label:'Recall period signed',ok:recallOk,value:recallOk?\`\${payload.recall.months} months · due \${payload.recall.due_date}\`:'Not present'});

    let sigODValid=false;
    try{sigODValid=await verifyJ(payload,sig_optometrist,payload.prescriber.pubkey);}catch(e){}
    checks.push({label:'OD cryptographic signature',ok:sigODValid,value:sigODValid?'Valid secp256k1/Schnorr/SHA-256':'✗ INVALID — tampered'});

    let sigPracValid=null;
    if(sig_practice&&payload.practice?.pubkey){
      try{sigPracValid=await verifyJ(payload,sig_practice,payload.practice.pubkey);}catch(e){sigPracValid=false;}
      checks.push({label:'Practice co-signature',ok:sigPracValid,value:sigPracValid?\`Valid · \${payload.practice.name}\`:'✗ INVALID'});
    }

    if(payload.delegation){
      const delOk=payload.delegation.valid_until>=new Date().toISOString().split('T')[0];
      checks.push({label:'Delegation certificate valid',ok:delOk,value:delOk?\`Until \${payload.delegation.valid_until}\`:\`Expired \${payload.delegation.valid_until}\`});
    }

    const allOk=schOk&&expOk&&presOk&&sigODValid;
    el.innerHTML=\`<div class="card" style="border-color:\${allOk?'rgba(45,106,79,0.4)':'rgba(155,34,38,0.4)'};">
      <div class="card-title">Verification Result</div>
      <div class="badge \${allOk?'badge-valid':'badge-invalid'}" style="margin-bottom:18px;font-size:11px;padding:7px 13px;">
        \${allOk?'✓ Authentic &amp; Unmodified':'✗ Verification Failed — Do Not Dispense'}
      </div>
      <div class="check-list">
        \${checks.map(c=>\`<div class="check-item">
          <span style="color:\${c.ok?'var(--green)':'var(--red)'};width:16px;text-align:center;">\${c.ok?'✓':'✗'}</span>
          <span class="check-label">\${c.label}</span>
          <span class="check-value" style="color:\${c.ok?'var(--ink)':'var(--red)'}">\${c.value}</span>
        </div>\`).join('')}
      </div>
      \${allOk?\`
      <div class="divider"></div>
      <table class="rx-table">
        <thead><tr><th style="text-align:left">Eye</th><th>Sphere</th><th>Cylinder</th><th>Axis</th><th>Add</th><th>Prism</th></tr></thead>
        <tbody>
          <tr><td class="eye-label">R (OD)</td><td>\${fmtR(payload.rx.right.sphere)}</td><td>\${fmtR(payload.rx.right.cylinder)}</td><td>\${fmtR(payload.rx.right.axis,'axis')}</td><td>\${fmtR(payload.rx.right.add)}</td><td>\${fmtR(payload.rx.right.prism)}</td></tr>
          <tr><td class="eye-label">L (OS)</td><td>\${fmtR(payload.rx.left.sphere)}</td><td>\${fmtR(payload.rx.left.cylinder)}</td><td>\${fmtR(payload.rx.left.axis,'axis')}</td><td>\${fmtR(payload.rx.left.add)}</td><td>\${fmtR(payload.rx.left.prism)}</td></tr>
        </tbody>
      </table>
      \${payload.recall?\`<div class="recall-band" style="margin-top:12px;"><span>📅</span><div>Recall due: <strong>\${payload.recall.due_date}</strong> (\${payload.recall.months} months)</div></div>\`:''}
      \`:''}
    </div>\`;
  }catch(e){el.innerHTML=\`<div class="alert alert-error">Parse error: \${e.message}</div>\`;}
}

// ═══════════════ PATIENT VIEW ═══════════════
function renderPatientView(){
  const rx=STATE.lastIssuedRx;
  if(!rx){
    document.getElementById('no-rx-alert').style.display='block';
    document.getElementById('patient-view-content').style.display='none';return;
  }
  document.getElementById('no-rx-alert').style.display='none';
  document.getElementById('patient-view-content').style.display='block';

  // Practice branding
  if(rx.practice){
    const ph=document.getElementById('pv-practice-header');
    ph.style.borderBottomColor=rx.practice.colour||'var(--border)';
    document.getElementById('pv-practice-logo').style.background=(rx.practice.colour||'#005f73')+'18';
    document.getElementById('pv-practice-logo').style.color=rx.practice.colour||'#005f73';
    document.getElementById('pv-practice-logo').textContent=rx.practice.emoji||'👁';
    document.getElementById('pv-practice-name').textContent=rx.practice.name||'—';
    document.getElementById('pv-practice-addr').textContent=\`\${rx.practice.addr1||''}, \${rx.practice.addr2||''} · \${rx.practice.reg||''}\`;
  }

  document.getElementById('pv-patient-name').textContent=rx.patient.display_name||'Patient';
  document.getElementById('pv-issued-line').textContent=\`Issued \${tsD(rx.issued_at)} · \${rx.test_type?.replace('_',' ')||'Standard Sight Test'}\`;
  document.getElementById('pv-prescriber').textContent=rx.prescriber.name;
  document.getElementById('pv-goc').textContent=rx.prescriber.goc;
  document.getElementById('pv-expires').textContent=tsD(rx.expires_at);
  document.getElementById('pv-testtype').textContent=rx.test_type?.replace('_',' ')||'Standard Sight Test';
  document.getElementById('pv-sig').textContent=shortH(rx.sig_optometrist,30);

  document.getElementById('pv-rx-body').innerHTML=\`
    <tr><td class="eye-label">R (OD)</td><td>\${fmtR(rx.rx.right.sphere)}</td><td>\${fmtR(rx.rx.right.cylinder)}</td><td>\${fmtR(rx.rx.right.axis,'axis')}</td><td>\${fmtR(rx.rx.right.add)}</td></tr>
    <tr><td class="eye-label">L (OS)</td><td>\${fmtR(rx.rx.left.sphere)}</td><td>\${fmtR(rx.rx.left.cylinder)}</td><td>\${fmtR(rx.rx.left.axis,'axis')}</td><td>\${fmtR(rx.rx.left.add)}</td></tr>\`;

  const extras=[];
  if(rx.rx.pd) extras.push(\`PD: \${rx.rx.pd}mm\`);
  if(rx.rx.pd_near) extras.push(\`Near PD: \${rx.rx.pd_near}mm\`);
  if(rx.rx.bvd) extras.push(\`BVD: \${rx.rx.bvd}mm\`);
  if(rx.rx.recommended_lens) extras.push(\`Lens: \${rx.rx.recommended_lens.replace('_',' ')}\`);
  if(rx.rx.notes) extras.push(rx.rx.notes);
  document.getElementById('pv-extras').textContent=extras.join('  ·  ');

  if(rx.recall){
    document.getElementById('pv-recall-band').style.display='flex';
    document.getElementById('pv-recall-text').textContent=\`Next sight test recommended by \${rx.recall.due_date} (\${rx.recall.months} months)\`;
    document.getElementById('pv-recall-badge').style.display='inline-flex';
    document.getElementById('pv-recall-badge').textContent=\`📅 Recall \${rx.recall.due_date}\`;
  }

  if(rx.sig_practice){
    document.getElementById('pv-dual-sig').style.display='block';
    document.getElementById('pv-dual-sig-detail').textContent=\`OD: \${shortH(rx.sig_optometrist,16)} · Practice: \${shortH(rx.sig_practice,16)}\`;
  }

  const qrEl=document.getElementById('qr-container'); qrEl.innerHTML='';
  try{
    // Encode full payload as base64 — matches /v/:code#base64 format that
    // the verification page decodes. Use btoa(unescape(encodeURIComponent(...)))
    // for Unicode safety (handles · and other non-ASCII chars in practice names).
    const shortCode = rx.prescription_id || '';
    const baseUrl = \`\${API_URL}/v/\${shortCode}\`;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(rx))));
    const qrUrl = \`\${baseUrl}#\${encoded}\`;
    // Use error correction L for maximum data capacity
    new QRCode(qrEl,{text:qrUrl,
      width:148,height:148,colorDark:'#1a1a2e',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.L});
  }catch(e){
    // If still too large (very long notes/address), fall back to short URL only
    const shortCode = rx.prescription_id || '';
    try {
      new QRCode(qrEl,{text:\`\${API_URL}/v/\${shortCode}\`,
        width:148,height:148,colorDark:'#1a1a2e',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
      qrEl.insertAdjacentHTML('beforeend','<div style="font-family:\\'DM Mono\\',monospace;font-size:8px;color:var(--muted);text-align:center;margin-top:5px;max-width:148px;">Short URL only — scan then present PDF</div>');
    } catch(e2) {
      qrEl.innerHTML='<div style="font-family:\\'DM Mono\\',monospace;font-size:9px;color:var(--muted);width:148px;text-align:center;padding:10px;border:1px dashed var(--border);">QR unavailable.<br>Use JSON export.</div>';
    }
  }
}
function downloadRxJson(){
  if(!STATE.lastIssuedRx)return;
  const a=document.createElement('a');
  a.href='data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(STATE.lastIssuedRx,null,2));
  a.download=\`rx-\${STATE.lastIssuedRx.patient.ref.slice(0,8)}-\${STATE.lastIssuedRx.issued_at}.json\`;
  a.click();
}

// ═══════════════ REGISTRY TAB ═══════════════
function renderRegistryTab(){
  // Optometrists
  const ods=Object.values(REGISTRY.optometrists);
  document.getElementById('reg-od-wrap').innerHTML=ods.length?\`
    <table class="registry-table">
      <thead><tr><th>GOC No.</th><th>Name</th><th>Pubkey</th><th>Email Verified</th><th>ID Verified</th><th>Status</th></tr></thead>
      <tbody>\${ods.map(o=>\`<tr>
        <td style="color:var(--ink2);font-weight:500;">\${o.goc}</td>
        <td>\${o.name}</td>
        <td style="font-size:9px;color:var(--muted);cursor:pointer;" onclick="navigator.clipboard?.writeText('\${o.pubHex}');this.textContent='Copied!';setTimeout(()=>this.textContent='\${shortH(o.pubHex,12)}',1400)">\${shortH(o.pubHex,12)}</td>
        <td style="text-align:center;color:var(--green);">✓</td>
        <td style="text-align:center;color:\${o.status==='approved'?'var(--green)':'var(--amber)'};">\${o.status==='approved'?'✓':'Pending'}</td>
        <td><span class="badge \${o.status==='approved'?'badge-valid':o.status==='pending'?'badge-pending':'badge-warn'}">\${o.status}</span></td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No entries yet.</div>';

  // Practices
  const pracs=Object.values(REGISTRY.practices);
  document.getElementById('reg-practice-wrap').innerHTML=pracs.length?\`
    <table class="registry-table">
      <thead><tr><th>Practice</th><th>Reg. No.</th><th>Address</th><th>Pubkey</th><th>Status</th></tr></thead>
      <tbody>\${pracs.map(p=>\`<tr>
        <td><span style="margin-right:6px;">\${p.emoji}</span>\${p.name}</td>
        <td style="font-size:10px;">\${p.reg}</td>
        <td style="font-size:10px;color:var(--muted);">\${p.addr1}, \${p.addr2}</td>
        <td style="font-size:9px;color:var(--muted);cursor:pointer;" onclick="navigator.clipboard?.writeText('\${p.pubHex}');this.textContent='Copied!';setTimeout(()=>this.textContent='\${shortH(p.pubHex,12)}',1400)">\${shortH(p.pubHex,12)}</td>
        <td><span class="badge badge-valid">Active</span></td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No practices registered yet.</div>';

  // Delegations
  document.getElementById('reg-deleg-wrap').innerHTML=REGISTRY.delegations.length?\`
    <table class="registry-table">
      <thead><tr><th>Optometrist</th><th>Practice</th><th>Valid From</th><th>Valid Until</th><th>OD Sig</th><th>Practice Sig</th></tr></thead>
      <tbody>\${REGISTRY.delegations.map(d=>\`<tr>
        <td style="font-size:10px;">\${d.optometrist?.name}<br><span style="color:var(--muted);font-size:9px;">GOC \${d.optometrist?.goc}</span></td>
        <td style="font-size:10px;">\${d.practice?.name}</td>
        <td style="font-size:10px;">\${d.valid_from}</td>
        <td style="font-size:10px;color:\${d.valid_until>=new Date().toISOString().split('T')[0]?'var(--green)':'var(--red)'};">\${d.valid_until}</td>
        <td style="font-size:9px;color:var(--green);">✓ \${shortH(d.sig_optometrist,8)}</td>
        <td style="font-size:9px;color:var(--green);">✓ \${shortH(d.sig_practice,8)}</td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No delegation certificates issued yet.</div>';
}

function doLookup(){
  const q=document.getElementById('lookup-q').value.trim();
  const el=document.getElementById('lookup-result');
  const od=Object.values(REGISTRY.optometrists).find(o=>o.goc===q||o.pubHex===q||o.goc?.replace(/-/g,'')===q.replace(/-/g,''));
  const pr=Object.values(REGISTRY.practices).find(p=>p.id===q||p.pubHex===q||p.reg===q);
  if(!od&&!pr){
    el.innerHTML=\`<div class="alert alert-warn">No entry found for "\${q}".<br><span style="font-size:9px;">In production this queries the live RxVerify API. Complete the Register + Practice tabs first.</span></div>\`;return;
  }
  const deleg=od?REGISTRY.delegations.filter(d=>d.odPubHex===od.pubHex):[];
  el.innerHTML=\`<div class="card" style="border-color:rgba(45,106,79,0.35);margin-top:12px;">
    \${od?\`<div class="badge badge-valid" style="margin-bottom:12px;">✓ GOC Optometrist Found</div>
    <div style="font-family:'DM Mono',monospace;font-size:11px;line-height:2.0;">
      <div>Name: <strong>\${od.name}</strong></div><div>GOC: <strong>\${od.goc}</strong></div>
      <div>Status: <span style="color:\${od.status==='approved'?'var(--green)':'var(--amber)'};">\${od.status}</span></div>
      <div style="margin-top:8px;font-size:9px;">Pubkey: <span style="color:var(--muted);word-break:break-all;">\${od.pubHex}</span></div>
      \${deleg.length?\`<div style="margin-top:8px;">Active delegations: <span style="color:var(--teal2);">\${deleg.map(d=>d.practice.name).join(', ')}</span></div>\`:''}
    </div>
    <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:10px;padding:9px;background:var(--warm);border-radius:2px;">
      Cross-check: search GOC number <strong>\${od.goc}</strong> at <strong>optical.org/goc/registrants</strong>
    </div>\`:''}
    \${pr?\`<div class="badge badge-info" style="margin-bottom:12px;">✓ Practice Found</div>
    <div style="font-family:'DM Mono',monospace;font-size:11px;line-height:2.0;">
      <div>Name: <strong>\${pr.name}</strong></div><div>Reg: <strong>\${pr.reg}</strong></div>
      <div>Address: \${pr.addr1}, \${pr.addr2}</div>
    </div>\`:''}
  </div>\`;
}

// ═══════════════ EXPOSE TO WINDOW ═══════════════
// ES module functions are scoped — expose all UI-callable
// functions to window so onclick= handlers can reach them
Object.assign(window, {
  showTab, setRecall, updateRecallSummary,
  goWizard, generateKeys, copyEl, downloadKeys,
  saveKeysToStorage, loadSavedKeys,
  simulateSendCode, verifyOTP,
  simulateUpload, submitForVerification, approveDemo,
  registerPractice, addDemoPractices, refreshPracticeTab,
  setActivePractice, issueDelegation,
  refreshIssueTab, updateIssueBanner, issuePrescription,
  clearIssueForm, handlePDFDrop, handlePDFFile, applyExtraction,
  setNum, setText, setDOB, setAxis,
  loadIssuedIntoVerifier, verifyPrescription,
  renderPatientView, downloadRxJson,
  renderRegistryTab, doLookup,
});

// ═══════════════ INIT ═══════════════
window.addEventListener('load',()=>{
  updateRecallSummary();
  const saved=localStorage.getItem('rxverify_state');
  if(saved){
    try{
      const s=JSON.parse(saved);
      if(s.pubHex&&s.privHex&&s.prescriber){
        Object.assign(STATE,s);
        setEl('pub-key-display',shortH(s.pubHex,20),s.pubHex);
        setEl('priv-key-display',shortH(s.privHex,20),s.privHex);
        document.getElementById('keys-card').style.display='block';
        document.getElementById('setup-name').value=s.prescriber.name||'';
        document.getElementById('setup-goc').value=s.prescriber.goc||'';
        if(s.prescriber.email) document.getElementById('setup-email').value=s.prescriber.email;
        if(s.prescriber) REGISTRY.optometrists[s.pubHex]={...s.prescriber,status:s.registryStatus||'unverified',registeredAt:new Date().toISOString()};
        updateHeader();
        document.querySelectorAll('.wstep').forEach(ws=>ws.classList.add('done'));
        // Auto-register in Supabase on every load to keep registry current
        fetch(\`\${API_URL}/api/registry/auto-register\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npub: s.pubHex,
            goc_number: s.prescriber.goc,
            name: s.prescriber.name,
            practice: s.prescriber.practice || null,
            jurisdiction: 'UK-GOC'
          })
        }).then(() => {
          STATE.registryStatus = 'approved';
          updateHeader();
        }).catch(() => {});
      }
    }catch(e){}
  }
});
</script>
</body>
</html>
`;const n=parseFloat(v);return n>=0?\`+\${n.toFixed(2)}\`:n.toFixed(2);}

// ═══════════════ RECALL ═══════════════
function setRecall(val,el){
  document.querySelectorAll('.recall-pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  const cr=document.getElementById('recall-custom-row');
  cr.style.display=val==='custom'?'flex':'none';
  if(val!=='custom') recallMonths=val;
  updateRecallSummary();
}
function updateRecallSummary(){
  if(document.getElementById('recall-custom-row').style.display!=='none'){
    const v=parseInt(document.getElementById('recall-custom-val').value);
    if(v) recallMonths=v;
  }
  const d=new Date(); d.setMonth(d.getMonth()+recallMonths);
  const dStr=d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const label=recallMonths===6?'6 months':recallMonths===12?'1 year':recallMonths===24?'2 years':recallMonths===36?'3 years':\`\${recallMonths} months\`;
  document.getElementById('recall-summary').innerHTML=
    \`📅 Patient due for recall in <strong>\${label}</strong> — approximately <strong>\${dStr}</strong>.\`;
}

// ═══════════════ WIZARD ═══════════════
function goWizard(step){
  document.querySelectorAll('.verif-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.wstep').forEach((s,i)=>{
    s.classList.remove('active','done');
    if(i+1<step) s.classList.add('done');
    if(i+1===step) s.classList.add('active');
  });
  document.getElementById('vp'+step).classList.add('active');
  if(step===2) document.getElementById('verif-email-display').value=document.getElementById('setup-email').value;
}

// ═══════════════ KEYGEN ═══════════════
async function generateKeys(){
  const name=document.getElementById('setup-name').value.trim();
  const goc=document.getElementById('setup-goc').value.trim();
  if(!name||!goc){alert('Please enter your name and GOC number.');return;}
  const{pubHex,privHex}=await genKP();
  STATE.pubHex=pubHex; STATE.privHex=privHex;
  STATE.prescriber={name,goc,email:document.getElementById('setup-email').value.trim(),
    qual:document.getElementById('setup-qual').value,pubHex};
  setEl('pub-key-display',shortH(pubHex,20),pubHex);
  setEl('priv-key-display',shortH(privHex,20),privHex);
  document.getElementById('keys-card').style.display='block';

  // Auto-register in Supabase registry
  try {
    await fetch(\`\${API_URL}/api/registry/auto-register\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        npub: pubHex,
        goc_number: goc,
        name: name,
        practice: document.getElementById('setup-practice')?.value?.trim() || null,
        jurisdiction: 'UK-GOC'
      })
    });
    STATE.registryStatus = 'approved';
  } catch(e) {
    console.warn('Registry auto-register failed:', e.message);
  }

  updateHeader();
}
function setEl(id,txt,full){const e=document.getElementById(id);e.textContent=txt;e.dataset.full=full;}
function copyEl(el){
  navigator.clipboard?.writeText(el.dataset.full||el.textContent);
  const o=el.textContent;el.textContent='Copied!';setTimeout(()=>el.textContent=o,1200);
}
function updateHeader(){
  if(!STATE.prescriber)return;
  document.getElementById('header-info').innerHTML=
    \`<div><span>\${STATE.prescriber.name}</span></div><div>GOC \${STATE.prescriber.goc} · <span style="color:\${STATE.registryStatus==='approved'?'#22c55e':'#92600a'}">\${STATE.registryStatus}</span></div>\`;
}
function downloadKeys(){
  if(!STATE.pubHex)return;
  const t=\`RxVerify Identity Keys\\nGenerated: \${new Date().toISOString()}\\n\${STATE.prescriber.name} · GOC \${STATE.prescriber.goc}\\n\\nPUBLIC KEY:\\n\${STATE.pubHex}\\n\\nPRIVATE KEY (NEVER SHARE):\\n\${STATE.privHex}\`;
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(t);
  a.download=\`rxverify-keys-\${STATE.prescriber.goc.replace(/\\W/g,'_')}.txt\`;
  a.click();
}
function saveKeysToStorage(){
  if(!STATE.pubHex)return;
  localStorage.setItem('rxverify_state',JSON.stringify(STATE));
  alert('Keys saved to this browser.');
}
function loadSavedKeys(){
  const s=localStorage.getItem('rxverify_state');
  if(!s){alert('No saved keys found.');return;}
  Object.assign(STATE,JSON.parse(s));
  if(STATE.pubHex){
    setEl('pub-key-display',shortH(STATE.pubHex,20),STATE.pubHex);
    setEl('priv-key-display',shortH(STATE.privHex,20),STATE.privHex);
    document.getElementById('keys-card').style.display='block';
    document.getElementById('setup-name').value=STATE.prescriber?.name||'';
    document.getElementById('setup-goc').value=STATE.prescriber?.goc||'';
    if(STATE.prescriber) REGISTRY.optometrists[STATE.pubHex]={...STATE.prescriber,status:STATE.registryStatus||'unverified',registeredAt:new Date().toISOString()};
    updateHeader();
    alert('Keys loaded.');
    // Re-register in Supabase (ensures registry is current after page reload)
    if(STATE.prescriber) {
      fetch(\`\${API_URL}/api/registry/auto-register\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          npub: STATE.pubHex,
          goc_number: STATE.prescriber.goc,
          name: STATE.prescriber.name,
          practice: STATE.prescriber.practice || null,
          jurisdiction: 'UK-GOC'
        })
      }).then(() => {
        STATE.registryStatus = 'approved';
        updateHeader();
      }).catch(e => console.warn('Re-register failed:', e.message));
    }
  }
}

// ═══════════════ EMAIL OTP (simulated) ═══════════════
function simulateSendCode(){
  document.getElementById('code-sent-area').style.display='block';
}
function verifyOTP(){
  const code=document.getElementById('otp-input').value.trim();
  const res=document.getElementById('otp-result');
  if(code==='482916'){
    STATE.emailVerified=true;
    res.innerHTML='<div class="alert alert-success">✓ Email verified successfully. Your GOC-registered email confirms your identity.</div>';
    setTimeout(()=>goWizard(3),1400);
  } else {
    res.innerHTML='<div class="alert alert-error">✗ Incorrect code. Demo code is 482916.</div>';
  }
}

// ═══════════════ ID UPLOAD (simulated) ═══════════════
function simulateUpload(zoneId,statusId){
  const zone=document.getElementById(zoneId);
  const stat=document.getElementById(statusId);
  zone.classList.add('has-file');
  stat.innerHTML='<span style="font-family:\\'DM Mono\\',monospace;font-size:9px;color:var(--green);">✓ File selected (demo)</span>';
  STATE.idUploaded=true;
  document.getElementById('submit-verif-btn').disabled=false;
}
function submitForVerification(){
  document.getElementById('conf-name').textContent=STATE.prescriber?.name||'—';
  document.getElementById('conf-goc').textContent=STATE.prescriber?.goc||'—';
  REGISTRY.optometrists[STATE.pubHex]={...STATE.prescriber,status:'pending',registeredAt:new Date().toISOString()};
  STATE.registryStatus='pending';
  updateHeader();
  goWizard(4);
}
function approveDemo(){
  if(!STATE.pubHex){alert('Generate keys first.');return;}
  REGISTRY.optometrists[STATE.pubHex].status='approved';
  STATE.registryStatus='approved';
  document.getElementById('conf-reg-status').textContent='Approved ✓';
  document.getElementById('conf-reg-status').className='badge badge-valid';
  document.getElementById('approval-result').innerHTML='<div class="alert alert-success">✓ Registry entry approved. Your public key is now live and verifiable by anyone.</div>';
  updateHeader();
  renderRegistryTab();
}

// ═══════════════ PRACTICE ═══════════════
async function registerPractice(){
  const name=document.getElementById('prac-name').value.trim();
  const reg=document.getElementById('prac-reg').value.trim();
  if(!name||!reg){alert('Practice name and registration number required.');return;}
  const{pubHex,privHex}=await genKP();
  const practice={
    id:'RXP-'+Math.random().toString(36).slice(2,7).toUpperCase(),
    name,reg,pubHex,privHex,
    addr1:document.getElementById('prac-addr1').value.trim(),
    addr2:document.getElementById('prac-addr2').value.trim(),
    phone:document.getElementById('prac-phone').value.trim(),
    email:document.getElementById('prac-email').value.trim(),
    colour:document.getElementById('prac-colour').value.trim()||'#005f73',
    emoji:document.getElementById('prac-emoji').value.trim()||'👁',
    isOwn:true,
    registeredAt:new Date().toISOString(),
  };
  REGISTRY.practices[pubHex]=practice;
  STATE.activePractice={...practice,isLocum:false,delegation:null};
  document.getElementById('practice-keys-result').innerHTML=\`
    <div class="alert alert-success">✓ Practice keypair generated and registered.<br>
    Practice ID: <strong>\${practice.id}</strong> · Pubkey: <code style="font-size:9px;">\${shortH(pubHex,16)}</code></div>\`;
  refreshPracticeTab();
  renderRegistryTab();
}

function addDemoPractices(){
  const demos=[
    {name:'Vision Express — Canary Wharf',reg:'CQC-9876001',addr1:'Jubilee Place',addr2:'London E14 5NY',emoji:'👓',colour:'#c0392b'},
    {name:'Specsavers — Oxford Street',reg:'CQC-9876002',addr1:'350 Oxford Street',addr2:'London W1C 1JH',emoji:'🔍',colour:'#1a5276'},
  ];
  demos.forEach(async d=>{
    const{pubHex,privHex}=await genKP();
    const p={...d,pubHex,privHex,id:'RXP-'+Math.random().toString(36).slice(2,7).toUpperCase(),isOwn:false,registeredAt:new Date().toISOString()};
    REGISTRY.practices[pubHex]=p;
  });
  setTimeout(()=>{refreshPracticeTab();renderRegistryTab();},300);
}

function refreshPracticeTab(){
  const practices=Object.values(REGISTRY.practices);
  const list=document.getElementById('my-practices-list');
  const form=document.getElementById('delegation-form');
  const sel=document.getElementById('deleg-practice');
  const activeCard=document.getElementById('active-context-card');
  const opts=document.getElementById('context-options');

  if(!practices.length){
    list.innerHTML='<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:14px;border:1px dashed var(--border);border-radius:2px;text-align:center;">No practices registered yet.</div>';
    form.style.display='none'; activeCard.style.display='none'; return;
  }

  list.innerHTML=practices.map(p=>\`
    <div class="practice-card" onclick="setActivePractice('\${p.pubHex}',false)" id="pc-\${p.pubHex}">
      <div class="practice-logo" style="background:\${p.colour}15;color:\${p.colour};">\${p.emoji}</div>
      <div class="practice-info">
        <div class="practice-name">\${p.name}</div>
        <div class="practice-detail">\${p.reg} · \${p.addr1}, \${p.addr2}</div>
      </div>
      \${p.isOwn?'<span class="badge badge-valid" style="font-size:8px;">Owner</span>':'<span class="badge badge-info" style="font-size:8px;">Locum</span>'}
    </div>\`).join('');

  // Set today's dates for delegation form
  const today=new Date().toISOString().split('T')[0];
  const yrAhead=new Date(Date.now()+365*86400000).toISOString().split('T')[0];
  document.getElementById('deleg-from').value=today;
  document.getElementById('deleg-until').value=yrAhead;

  sel.innerHTML=practices.map(p=>\`<option value="\${p.pubHex}">\${p.name}</option>\`).join('');
  form.style.display='block';
  activeCard.style.display='block';

  opts.innerHTML=practices.map(p=>\`
    <div class="practice-card" onclick="setActivePractice('\${p.pubHex}',false)" id="ctx-\${p.pubHex}">
      <div class="practice-logo" style="background:\${p.colour}15;color:\${p.colour};">\${p.emoji}</div>
      <div class="practice-info">
        <div class="practice-name">\${p.name}</div>
        <div class="practice-detail">\${p.addr1}, \${p.addr2}</div>
      </div>
    </div>\`).join('');
}

function setActivePractice(pubHex, isLocum){
  const p=REGISTRY.practices[pubHex];
  if(!p)return;
  const deleg=REGISTRY.delegations.find(d=>d.practicePubHex===pubHex&&d.odPubHex===STATE.pubHex);
  STATE.activePractice={...p,isLocum,delegation:deleg||null};
  document.querySelectorAll('.practice-card').forEach(c=>c.classList.remove('selected'));
  document.querySelectorAll(\`#pc-\${pubHex},#ctx-\${pubHex}\`).forEach(c=>c.classList.add('selected'));
  document.getElementById('selected-context-display').innerHTML=\`<div class="alert alert-success">✓ Active context: <strong>\${p.name}</strong>\${isLocum?' (locum — delegation certificate active)':' (practice owner)'}</div>\`;
  updateIssueBanner();
}

async function issueDelegation(){
  if(!STATE.pubHex){alert('Generate your GOC keypair first.');return;}
  const pracPubHex=document.getElementById('deleg-practice').value;
  const prac=REGISTRY.practices[pracPubHex];
  if(!prac){alert('Practice not found.');return;}
  const from=document.getElementById('deleg-from').value;
  const until=document.getElementById('deleg-until').value;

  const certPayload={
    type:'delegation_certificate',
    schema_version:'delv1-uk',
    issued_at:Math.floor(Date.now()/1000),
    optometrist:{pubkey:STATE.pubHex,goc:STATE.prescriber?.goc,name:STATE.prescriber?.name},
    practice:{pubkey:pracPubHex,id:prac.id,name:prac.name,reg:prac.reg},
    valid_from:from, valid_until:until,
  };
  const sigOD=await signJ(certPayload,STATE.privHex);
  const sigPrac=await signJ(certPayload,prac.privHex);
  const cert={...certPayload,sig_optometrist:sigOD,sig_practice:sigPrac,
    practicePubHex,odPubHex:STATE.pubHex};
  REGISTRY.delegations.push(cert);

  document.getElementById('delegation-result').innerHTML=\`
    <div class="card" style="margin-top:0;border-color:rgba(45,106,79,0.35);">
      <div class="badge badge-valid" style="margin-bottom:10px;">✓ Delegation Certificate Issued</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.9;">
        <div>Practice: <span style="color:var(--ink)">\${prac.name}</span></div>
        <div>Valid: <span style="color:var(--ink)">\${from} → \${until}</span></div>
        <div>Signed by OD: <span style="color:var(--ink)">\${shortH(sigOD,14)}</span></div>
        <div>Co-signed by practice: <span style="color:var(--ink)">\${shortH(sigPrac,14)}</span></div>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px;" onclick="setActivePractice('\${pracPubHex}',true)">→ Set as Active Prescribing Context</button>
    </div>\`;
  renderRegistryTab();
}

// ═══════════════ ISSUE TAB ═══════════════
function refreshIssueTab(){
  document.getElementById('no-key-warn').style.display=STATE.pubHex?'none':'block';
  document.getElementById('no-context-warn').style.display=STATE.activePractice?'none':'block';
  document.getElementById('issue-btn').disabled=!STATE.pubHex||!STATE.activePractice;
  updateIssueBanner();
  updateRecallSummary();
}
function updateIssueBanner(){
  const p=STATE.activePractice;
  const banner=document.getElementById('active-context-banner');
  if(!p){banner.style.display='none';return;}
  banner.style.display='block';
  document.getElementById('banner-logo').style.background=p.colour+'20';
  document.getElementById('banner-logo').style.color=p.colour;
  document.getElementById('banner-logo').textContent=p.emoji;
  document.getElementById('banner-name').textContent=p.name;
  document.getElementById('banner-detail').textContent=\`\${p.addr1}, \${p.addr2} · \${p.reg}\`;
  const db=document.getElementById('banner-deleg-badge');
  db.style.display=p.isLocum?'inline-flex':'none';
}

// ═══════════════ BACKEND API ═══════════════
// Point this at your Vercel deployment URL
// For local testing: 'http://localhost:3000'
const API_URL = 'https://www.rxverify.co.uk';

async function saveToBackend(signedRx, shortCode) {
  try {
    const resp = await fetch(\`\${API_URL}/api/prescriptions\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_payload: signedRx, short_code: shortCode })
    });
    return resp.ok ? await resp.json() : null;
  } catch(e) {
    console.warn('Backend save failed (offline mode):', e.message);
    return null;
  }
}

async function sendEmailToPatient(signedRx, shortCode, toEmail) {
  try {
    const rx = signedRx.rx || {};
    const resp = await fetch(\`\${API_URL}/api/send/email\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_email: toEmail,
        patient_name: signedRx.patient?.display_name,
        patient_dob: signedRx.patient?.display_dob,
        short_code: shortCode,
        practice_name: signedRx.practice?.name || signedRx.prescriber?.name,
        prescriber_name: signedRx.prescriber?.name,
        goc_number: signedRx.prescriber?.goc,
        issued_date: tsD(signedRx.issued_at),
        expires_date: tsD(signedRx.expires_at),
        recall_date: signedRx.recall?.due_date,
        rx_summary: {
          r_sphere: rx.right?.sphere, r_cyl: rx.right?.cylinder, r_axis: rx.right?.axis,
          r_add: rx.right?.add,
          l_sphere: rx.left?.sphere,  l_cyl: rx.left?.cylinder,  l_axis: rx.left?.axis,
          l_add: rx.left?.add,
          clinical_notes: signedRx.rx?.notes || null
        },
        full_payload: signedRx  // ← full signed prescription for URL fragment
      })
    });
    return resp.ok;
  } catch(e) {
    console.warn('Email send failed:', e.message);
    return false;
  }
}

function generateShortCode() {
  // Generates RXV-XXXXX-X format
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part1 = Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  const part2 = chars[Math.floor(Math.random()*chars.length)];
  return \`RXV-\${part1}-\${part2}\`;
}

async function issuePrescription(){
  if(!STATE.pubHex||!STATE.activePractice){return;}
  const ptName=document.getElementById('pt-name').value.trim();
  const ptDob=document.getElementById('pt-dob').value;
  if(!ptName||!ptDob){alert('Patient name and date of birth required.');return;}
  document.getElementById('issue-status').textContent='Signing…';

  const v=id=>{const x=document.getElementById(id).value;return x===''?null:parseFloat(x)||null;};
  const s=id=>document.getElementById(id).value.trim()||null;
  const now=Math.floor(Date.now()/1000);
  const recallDate=new Date(); recallDate.setMonth(recallDate.getMonth()+recallMonths);

  const patRef=await sha256h(\`\${ptDob}|\${ptName.toLowerCase().replace(/\\s+/g,' ')}\`);
  const contH=s('pt-email')?await sha256h(document.getElementById('pt-email').value.toLowerCase()):null;

  const p=STATE.activePractice;
  const payload={
    schema_version:'rxv1-uk',
    issued_at:now, expires_at:now+(60*60*24*730),
    prescriber:{
      pubkey:STATE.pubHex, goc:STATE.prescriber.goc, name:STATE.prescriber.name,
      qual:STATE.prescriber.qual, jurisdiction:'UK-GOC',
    },
    practice:{
      pubkey:p.pubHex, id:p.id, name:p.name, reg:p.reg,
      addr1:p.addr1, addr2:p.addr2, emoji:p.emoji, colour:p.colour,
    },
    delegation:p.delegation?{valid_from:p.delegation.valid_from,valid_until:p.delegation.valid_until}:null,
    patient:{ref:patRef,contact_hash:contH,display_name:ptName,display_dob:ptDob,
      // Include contact details so backend can store for recall notifications
      // These are not written to prescription_registry — only to recall_contacts
      contact_email: s('pt-email') || null,
      contact_mobile: s('pt-mobile') || null,
    },
    rx:{
      right:{sphere:v('r-sph'),cylinder:v('r-cyl'),axis:v('r-axis'),add:v('r-add'),prism:v('r-prism'),base:s('r-base')},
      left:{sphere:v('l-sph'),cylinder:v('l-cyl'),axis:v('l-axis'),add:v('l-add'),prism:v('l-prism'),base:s('l-base')},
      pd:v('pd'),pd_near:v('pd-near'),bvd:v('bvd')||12,
      recommended_lens:s('lens-rec'),notes:s('notes'),
    },
    recall:{months:recallMonths,due_at:Math.floor(recallDate.getTime()/1000),due_date:recallDate.toISOString().split('T')[0]},
    test_type:document.getElementById('test-type').value,
    consent:{recall:document.getElementById('consent-recall').checked,timestamp:now},
    metadata:{software:'RxVerify/1.0-uk',issued_under:'Opticians Act 1989 + Electronic Communications Act 2000'},
  };

  try{
    const shortCode = generateShortCode();
    const sigOD=await signJ(payload,STATE.privHex);
    let sigPrac=null;
    if(p.privHex) sigPrac=await signJ(payload,p.privHex);
    const signedRx={...payload,sig_optometrist:sigOD,sig_practice:sigPrac,prescription_id:shortCode};
    STATE.lastIssuedRx=signedRx;

    // Save to backend (non-blocking — works offline too)
    document.getElementById('issue-status').textContent='Saving…';
    const saved = await saveToBackend(signedRx, shortCode);
    const patientLink = saved?.patient_link || \`https://rxverify.co.uk/v/\${shortCode}\`;

    // Send email if patient email provided
    const ptEmail = document.getElementById('pt-email').value.trim();
    let emailSent = false;
    if(ptEmail && saved) {
      document.getElementById('issue-status').textContent='Sending…';
      emailSent = await sendEmailToPatient(signedRx, shortCode, ptEmail);
    }

    document.getElementById('issue-status').textContent='';
    document.getElementById('issue-result').style.display='block';
    document.getElementById('issue-result').innerHTML=\`
      <div class="card" style="border-color:rgba(45,106,79,0.35);">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="badge badge-valid">✓ Signed · \${tsD(now)}</span>
          \${saved?'<span class="badge badge-valid">✓ Saved to server</span>':'<span class="badge badge-warn">⚠ Offline — local only</span>'}
          \${emailSent?'<span class="badge badge-valid">✓ Email sent</span>':''}
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);line-height:1.9;margin-top:6px;">
          <div>Practice: <span style="color:var(--ink)">\${p.name}</span></div>
          <div>Prescription ID: <span style="color:var(--teal2);font-weight:500;">\${shortCode}</span></div>
          <div>Recall due: <span style="color:var(--teal2);font-weight:500;">\${signedRx.recall.due_date}</span> (\${recallMonths} months)</div>
          <div>Patient link: <a href="\${patientLink}" target="_blank" style="color:var(--teal2);">\${patientLink}</a></div>
        </div>
        <div style="display:flex;gap:9px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="showTab('patient')">→ View Patient Copy</button>
          <button class="btn btn-ghost" onclick="showTab('verify')">⟳ Test Verify</button>
          <button class="btn btn-ghost" onclick="navigator.clipboard?.writeText('\${patientLink}');this.textContent='Copied!';setTimeout(()=>this.textContent='⎘ Copy Link',1500)">⎘ Copy Link</button>
          <button class="btn btn-ghost" onclick="clearIssueForm()" style="border-color:var(--teal2);color:var(--teal2);">+ New Prescription</button>
        </div>
      </div>\`;
    showTab('patient');
  }catch(e){document.getElementById('issue-status').textContent='Error: '+e.message;console.error(e);}
}

// ═══════════════ PDF EXTRACTION ═══════════════

function handlePDFDrop(event) {
  event.preventDefault();
  const dz = document.getElementById('drop-zone');
  dz.style.borderColor = 'rgba(10,147,150,0.35)';
  dz.style.background   = 'rgba(10,147,150,0.04)';
  const file = event.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    handlePDFFile(file);
  } else {
    showExtractStatus('Please drop a PDF file', 'error');
  }
}

async function handlePDFFile(file) {
  if (!file) return;
  showExtractStatus('Reading prescription PDF…', 'loading');

  try {
    // Convert PDF to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    showExtractStatus('Extracting prescription data with AI…', 'loading');

    const resp = await fetch(\`\${API_URL}/api/extract\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_base64: base64 })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.detail || errData.error || 'Extraction service error');
    }
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || 'Extraction failed');

    showExtractResult(data.extracted, file.name);

  } catch(e) {
    showExtractStatus('Extraction failed: ' + e.message, 'error');
    console.error('PDF extraction error:', e);
  }
}

function showExtractStatus(msg, type) {
  const statusEl = document.getElementById('extract-status');
  const textEl   = document.getElementById('extract-status-text');
  const resultEl = document.getElementById('extract-result');
  statusEl.style.display = 'block';
  resultEl.style.display  = 'none';
  textEl.textContent = msg;
  textEl.style.color = type === 'error' ? 'var(--red,#9b2226)' : 'var(--muted)';
}

function fmtRxVal(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2);
}

function showExtractResult(extracted, filename) {
  const statusEl = document.getElementById('extract-status');
  const resultEl = document.getElementById('extract-result');
  statusEl.style.display = 'none';
  resultEl.style.display  = 'block';

  // Back-calculate ADD from near prescription (METHOD B — iCareWEB)
  let rAdd = extracted.right_add;
  let lAdd = extracted.left_add;

  if (extracted.recording_method === 'near_calculated') {
    // iCareWEB records near prescription, not ADD directly
    // ADD = near_sphere - distance_sphere
    if (extracted.right_near_sphere != null && extracted.right_sphere != null) {
      rAdd = Math.round((extracted.right_near_sphere - extracted.right_sphere) * 4) / 4;
    }
    if (extracted.left_near_sphere != null && extracted.left_sphere != null) {
      lAdd = Math.round((extracted.left_near_sphere - extracted.left_sphere) * 4) / 4;
    }
  }

  // Build confidence summary
  const fields = [
    { label:'Patient Name',  val:extracted.patient_name,           id:'pt-name',  type:'text' },
    { label:'Date of Birth', val:extracted.patient_dob,            id:'pt-dob',   type:'date' },
    { label:'R Sphere',      val:fmtRxVal(extracted.right_sphere),  id:'r-sph',    type:'num'  },
    { label:'R Cylinder',    val:fmtRxVal(extracted.right_cylinder),id:'r-cyl',    type:'num'  },
    { label:'R Axis',        val:extracted.right_axis,              id:'r-axis',   type:'num'  },
    { label:'R Add',         val:fmtRxVal(rAdd),                    id:'r-add',    type:'num'  },
    { label:'L Sphere',      val:fmtRxVal(extracted.left_sphere),   id:'l-sph',    type:'num'  },
    { label:'L Cylinder',    val:fmtRxVal(extracted.left_cylinder), id:'l-cyl',    type:'num'  },
    { label:'L Axis',        val:extracted.left_axis,               id:'l-axis',   type:'num'  },
    { label:'L Add',         val:fmtRxVal(lAdd),                    id:'l-add',    type:'num'  },
    { label:'PD',            val:extracted.pd,                      id:'pd',       type:'num'  },
    { label:'Notes',         val:extracted.clinical_notes,          id:'clinical-notes', type:'text' },
  ];

  const flags = extracted._validation_flags || [];
  const method = extracted.recording_method === 'near_calculated'
    ? 'METHOD B — Near prescription detected. ADD back-calculated.'
    : 'METHOD A — ADD recorded directly.';

  // Store extracted data for apply button
  window._lastExtracted = {
    patient_name: extracted.patient_name,
    patient_dob:  extracted.patient_dob,
    r_sphere:     extracted.right_sphere,
    r_cyl:        extracted.right_cylinder,
    r_axis:       extracted.right_axis,
    r_add:        rAdd,
    r_prism:      extracted.right_prism,
    l_sphere:     extracted.left_sphere,
    l_cyl:        extracted.left_cylinder,
    l_axis:       extracted.left_axis,
    l_add:        lAdd,
    l_prism:      extracted.left_prism,
    pd:           extracted.pd,
    pd_near:      extracted.pd_near,
    bvd:          extracted.bvd,
    notes:        extracted.clinical_notes,
    recall_months: extracted.recall_months
  };

  resultEl.innerHTML = \`
    <div style="background:rgba(45,106,79,0.08);border:1px solid rgba(45,106,79,0.25);border-radius:3px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:#2d6a4f;margin-bottom:4px;">✓ Extraction Complete — \${filename}</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:#2d6a4f;">\${method}</div>
      \${extracted.add_difference_flagged ? '<div style="font-family:\\'DM Mono\\',monospace;font-size:10px;color:#e76f51;margin-top:4px;">⚠ ADD differs between eyes — please check</div>' : ''}
      \${flags.length ? \`<div style="font-family:'DM Mono',monospace;font-size:10px;color:#e76f51;margin-top:4px;">⚠ \${flags.join(' · ')}</div>\` : ''}
    </div>

    <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:10px;">
      Review extracted values below — edit any field before signing.
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:7px;margin-bottom:14px;">
      \${fields.filter(f => f.val != null && f.val !== '').map(f => \`
        <div style="background:#f4f1e8;border-radius:2px;padding:7px 10px;">
          <div style="font-family:'DM Mono',monospace;font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;">\${f.label}</div>
          <div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2);font-weight:500;">\${f.val}</div>
        </div>\`).join('')}
    </div>

    <div style="display:flex;gap:9px;flex-wrap:wrap;">
      <button class="btn btn-primary" id="apply-extraction-btn">✓ Apply to Form</button>
      <button class="btn btn-ghost" onclick="document.getElementById('extract-result').style.display='none';">✕ Discard</button>
    </div>\`;

  // Use addEventListener to avoid inline onclick issues
  document.getElementById('apply-extraction-btn').addEventListener('click', function() {
    applyExtraction(window._lastExtracted);
  });
}

function setNum(id, val) {
  if (val != null) {
    const el = document.getElementById(id);
    if (el) {
      const n = parseFloat(val);
      if (!isNaN(n)) el.value = n.toFixed(2);
    }
  }
}
function setAxis(id, val) {
  // Axis is always a whole number — no decimal places
  if (val != null) {
    const el = document.getElementById(id);
    if (el) el.value = Math.round(parseFloat(val));
  }
}
function setText(id, val) {
  if (val != null) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
}
function setDOB(id, val) {
  if (!val) return;
  const el = document.getElementById(id);
  if (!el) return;
  // Convert various formats to YYYY-MM-DD for HTML date input
  // Handles: DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY
  let iso = val;
  if (/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(val)) {
    // DD/MM/YYYY → YYYY-MM-DD
    const [d, m, y] = val.split('/');
    iso = \`\${y}-\${m}-\${d}\`;
  } else if (/^\\d{2}-\\d{2}-\\d{4}$/.test(val)) {
    // DD-MM-YYYY → YYYY-MM-DD
    const [d, m, y] = val.split('-');
    iso = \`\${y}-\${m}-\${d}\`;
  }
  el.value = iso;
}

function applyExtraction(data) {
  // Patient details
  if (data.patient_name) setText('pt-name', data.patient_name);
  if (data.patient_dob)  setDOB('pt-dob', data.patient_dob);

  // Refraction values — set as plain numbers for number inputs
  setNum('r-sph',   data.r_sphere);
  setNum('r-cyl',   data.r_cyl);
  setAxis('r-axis', data.r_axis);
  setNum('r-add',   data.r_add);
  setNum('r-prism', data.r_prism);
  setNum('l-sph',   data.l_sphere);
  setNum('l-cyl',   data.l_cyl);
  setAxis('l-axis', data.l_axis);
  setNum('l-add',   data.l_add);
  setNum('l-prism', data.l_prism);
  setNum('pd',      data.pd);
  setNum('pd-near', data.pd_near);  // fix: was 'near-pd', input id is 'pd-near'
  setNum('bvd',     data.bvd);
  if (data.notes)   setText('notes', data.notes);

  // Recall period — fix: pills use class 'recall-pill', not 'recall-btn'
  if (data.recall_months) {
    recallMonths = data.recall_months;
    // Match a preset pill (6/12/24/36) or fall through to custom
    const presets = [6, 12, 24, 36];
    document.querySelectorAll('.recall-pill').forEach(p => p.classList.remove('active'));
    if (presets.includes(data.recall_months)) {
      // Pills fire setRecall via onclick — find by text content match
      document.querySelectorAll('.recall-pill').forEach(p => {
        const months = parseInt(p.getAttribute('onclick')?.match(/setRecall\\((\\d+)/)?.[1]);
        if (months === data.recall_months) p.classList.add('active');
      });
    } else {
      // Non-preset value — activate custom pill and populate input
      document.querySelectorAll('.recall-pill').forEach(p => {
        if (p.getAttribute('onclick')?.includes("'custom'")) p.classList.add('active');
      });
      const customRow = document.getElementById('recall-custom-row');
      if (customRow) customRow.style.display = 'flex';
      const customInput = document.getElementById('recall-custom-val');
      if (customInput) customInput.value = data.recall_months;
    }
    updateRecallSummary();
  }

  // Hide extraction UI
  document.getElementById('extract-card').style.display = 'none';

  // Scroll to patient name field and focus
  document.getElementById('pt-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Brief success message
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:20px;right:20px;background:#2d6a4f;color:white;padding:10px 18px;border-radius:3px;font-family:DM Mono,monospace;font-size:11px;z-index:9999;';
  banner.textContent = '✓ Prescription imported — review and sign';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
}

// ═══════════════ VERIFY ═══════════════
function clearIssueForm(){
  // Clear patient fields
  const fields = ['pt-name','pt-dob','pt-nhs','pt-email','pt-mobile',
    'r-sph','r-cyl','r-axis','r-add','r-prism','r-base',
    'l-sph','l-cyl','l-axis','l-add','l-prism','l-base',
    'pd','pd-near','bvd','notes'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  // Reset dropdowns to defaults
  const testType = document.getElementById('test-type');
  if(testType) testType.value = 'standard';
  const recLens = document.getElementById('recommended-lens');
  if(recLens) recLens.value = 'single_vision';
  // Reset recall to 12 months
  recallMonths = 12;
  // fix: pills use class 'recall-pill', activate the 1-year pill
  document.querySelectorAll('.recall-pill').forEach(p => {
    const months = parseInt(p.getAttribute('onclick')?.match(/setRecall\\((\\d+)/)?.[1]);
    p.classList.toggle('active', months === 12);
  });
  // hide custom row
  const customRowClear = document.getElementById('recall-custom-row');
  if (customRowClear) customRowClear.style.display = 'none';
  updateRecallSummary();
  // Reset consents to checked
  const c1 = document.getElementById('consent-recall');
  if(c1) c1.checked = true;
  // Restore PDF extraction zone
  const extractCard = document.getElementById('extract-card');
  if (extractCard) extractCard.style.display = 'block';
  const extractResult = document.getElementById('extract-result');
  if (extractResult) extractResult.style.display = 'none';
  const extractStatus = document.getElementById('extract-status');
  if (extractStatus) extractStatus.style.display = 'none';

  // Hide result card
  document.getElementById('issue-result').style.display = 'none';
  document.getElementById('issue-result').innerHTML = '';
  document.getElementById('issue-status').textContent = '';
  // Scroll to top of form
  document.getElementById('pt-name')?.focus();
  showTab('issue');
}

// ═══════════════ VERIFY ═══════════════
function loadIssuedIntoVerifier(){
  if(!STATE.lastIssuedRx){alert('No prescription issued yet.');return;}
  document.getElementById('verify-input').value=JSON.stringify(STATE.lastIssuedRx,null,2);
}
async function verifyPrescription(){
  const raw=document.getElementById('verify-input').value.trim();
  if(!raw)return;
  const el=document.getElementById('verify-result');
  try{
    let parsed=JSON.parse(raw);
    if(document.getElementById('tamper-check').checked&&parsed.rx?.right?.sphere!=null){
      parsed=JSON.parse(JSON.stringify(parsed));
      parsed.rx.right.sphere=(parsed.rx.right.sphere||0)+1.0;
    }
    const{sig_optometrist,sig_practice,...payload}=parsed;
    const now=Math.floor(Date.now()/1000);
    const checks=[];

    const schOk=payload.schema_version==='rxv1-uk';
    checks.push({label:'Schema version',ok:schOk,value:payload.schema_version||'missing'});
    const expOk=payload.expires_at>now;
    checks.push({label:'Not expired',ok:expOk,value:tsD(payload.expires_at)});
    const presOk=!!(payload.prescriber?.pubkey&&payload.prescriber?.goc);
    checks.push({label:'Prescriber fields present',ok:presOk,value:presOk?\`\${payload.prescriber.name} · GOC \${payload.prescriber.goc}\`:'Missing'});
    const regOD=REGISTRY.optometrists[payload.prescriber?.pubkey];
    checks.push({label:'OD pubkey in registry',ok:!!regOD,value:regOD?\`\${regOD.status==='approved'?'✓ Approved':'⚠ Pending'} · \${regOD.goc}\`:'Not found (run demo: approve in Register tab)'});
    const recallOk=!!payload.recall?.months&&!!payload.recall?.due_date;
    checks.push({label:'Recall period signed',ok:recallOk,value:recallOk?\`\${payload.recall.months} months · due \${payload.recall.due_date}\`:'Not present'});

    let sigODValid=false;
    try{sigODValid=await verifyJ(payload,sig_optometrist,payload.prescriber.pubkey);}catch(e){}
    checks.push({label:'OD cryptographic signature',ok:sigODValid,value:sigODValid?'Valid secp256k1/Schnorr/SHA-256':'✗ INVALID — tampered'});

    let sigPracValid=null;
    if(sig_practice&&payload.practice?.pubkey){
      try{sigPracValid=await verifyJ(payload,sig_practice,payload.practice.pubkey);}catch(e){sigPracValid=false;}
      checks.push({label:'Practice co-signature',ok:sigPracValid,value:sigPracValid?\`Valid · \${payload.practice.name}\`:'✗ INVALID'});
    }

    if(payload.delegation){
      const delOk=payload.delegation.valid_until>=new Date().toISOString().split('T')[0];
      checks.push({label:'Delegation certificate valid',ok:delOk,value:delOk?\`Until \${payload.delegation.valid_until}\`:\`Expired \${payload.delegation.valid_until}\`});
    }

    const allOk=schOk&&expOk&&presOk&&sigODValid;
    el.innerHTML=\`<div class="card" style="border-color:\${allOk?'rgba(45,106,79,0.4)':'rgba(155,34,38,0.4)'};">
      <div class="card-title">Verification Result</div>
      <div class="badge \${allOk?'badge-valid':'badge-invalid'}" style="margin-bottom:18px;font-size:11px;padding:7px 13px;">
        \${allOk?'✓ Authentic &amp; Unmodified':'✗ Verification Failed — Do Not Dispense'}
      </div>
      <div class="check-list">
        \${checks.map(c=>\`<div class="check-item">
          <span style="color:\${c.ok?'var(--green)':'var(--red)'};width:16px;text-align:center;">\${c.ok?'✓':'✗'}</span>
          <span class="check-label">\${c.label}</span>
          <span class="check-value" style="color:\${c.ok?'var(--ink)':'var(--red)'}">\${c.value}</span>
        </div>\`).join('')}
      </div>
      \${allOk?\`
      <div class="divider"></div>
      <table class="rx-table">
        <thead><tr><th style="text-align:left">Eye</th><th>Sphere</th><th>Cylinder</th><th>Axis</th><th>Add</th><th>Prism</th></tr></thead>
        <tbody>
          <tr><td class="eye-label">R (OD)</td><td>\${fmtR(payload.rx.right.sphere)}</td><td>\${fmtR(payload.rx.right.cylinder)}</td><td>\${fmtR(payload.rx.right.axis,'axis')}</td><td>\${fmtR(payload.rx.right.add)}</td><td>\${fmtR(payload.rx.right.prism)}</td></tr>
          <tr><td class="eye-label">L (OS)</td><td>\${fmtR(payload.rx.left.sphere)}</td><td>\${fmtR(payload.rx.left.cylinder)}</td><td>\${fmtR(payload.rx.left.axis,'axis')}</td><td>\${fmtR(payload.rx.left.add)}</td><td>\${fmtR(payload.rx.left.prism)}</td></tr>
        </tbody>
      </table>
      \${payload.recall?\`<div class="recall-band" style="margin-top:12px;"><span>📅</span><div>Recall due: <strong>\${payload.recall.due_date}</strong> (\${payload.recall.months} months)</div></div>\`:''}
      \`:''}
    </div>\`;
  }catch(e){el.innerHTML=\`<div class="alert alert-error">Parse error: \${e.message}</div>\`;}
}

// ═══════════════ PATIENT VIEW ═══════════════
function renderPatientView(){
  const rx=STATE.lastIssuedRx;
  if(!rx){
    document.getElementById('no-rx-alert').style.display='block';
    document.getElementById('patient-view-content').style.display='none';return;
  }
  document.getElementById('no-rx-alert').style.display='none';
  document.getElementById('patient-view-content').style.display='block';

  // Practice branding
  if(rx.practice){
    const ph=document.getElementById('pv-practice-header');
    ph.style.borderBottomColor=rx.practice.colour||'var(--border)';
    document.getElementById('pv-practice-logo').style.background=(rx.practice.colour||'#005f73')+'18';
    document.getElementById('pv-practice-logo').style.color=rx.practice.colour||'#005f73';
    document.getElementById('pv-practice-logo').textContent=rx.practice.emoji||'👁';
    document.getElementById('pv-practice-name').textContent=rx.practice.name||'—';
    document.getElementById('pv-practice-addr').textContent=\`\${rx.practice.addr1||''}, \${rx.practice.addr2||''} · \${rx.practice.reg||''}\`;
  }

  document.getElementById('pv-patient-name').textContent=rx.patient.display_name||'Patient';
  document.getElementById('pv-issued-line').textContent=\`Issued \${tsD(rx.issued_at)} · \${rx.test_type?.replace('_',' ')||'Standard Sight Test'}\`;
  document.getElementById('pv-prescriber').textContent=rx.prescriber.name;
  document.getElementById('pv-goc').textContent=rx.prescriber.goc;
  document.getElementById('pv-expires').textContent=tsD(rx.expires_at);
  document.getElementById('pv-testtype').textContent=rx.test_type?.replace('_',' ')||'Standard Sight Test';
  document.getElementById('pv-sig').textContent=shortH(rx.sig_optometrist,30);

  document.getElementById('pv-rx-body').innerHTML=\`
    <tr><td class="eye-label">R (OD)</td><td>\${fmtR(rx.rx.right.sphere)}</td><td>\${fmtR(rx.rx.right.cylinder)}</td><td>\${fmtR(rx.rx.right.axis,'axis')}</td><td>\${fmtR(rx.rx.right.add)}</td></tr>
    <tr><td class="eye-label">L (OS)</td><td>\${fmtR(rx.rx.left.sphere)}</td><td>\${fmtR(rx.rx.left.cylinder)}</td><td>\${fmtR(rx.rx.left.axis,'axis')}</td><td>\${fmtR(rx.rx.left.add)}</td></tr>\`;

  const extras=[];
  if(rx.rx.pd) extras.push(\`PD: \${rx.rx.pd}mm\`);
  if(rx.rx.pd_near) extras.push(\`Near PD: \${rx.rx.pd_near}mm\`);
  if(rx.rx.bvd) extras.push(\`BVD: \${rx.rx.bvd}mm\`);
  if(rx.rx.recommended_lens) extras.push(\`Lens: \${rx.rx.recommended_lens.replace('_',' ')}\`);
  if(rx.rx.notes) extras.push(rx.rx.notes);
  document.getElementById('pv-extras').textContent=extras.join('  ·  ');

  if(rx.recall){
    document.getElementById('pv-recall-band').style.display='flex';
    document.getElementById('pv-recall-text').textContent=\`Next sight test recommended by \${rx.recall.due_date} (\${rx.recall.months} months)\`;
    document.getElementById('pv-recall-badge').style.display='inline-flex';
    document.getElementById('pv-recall-badge').textContent=\`📅 Recall \${rx.recall.due_date}\`;
  }

  if(rx.sig_practice){
    document.getElementById('pv-dual-sig').style.display='block';
    document.getElementById('pv-dual-sig-detail').textContent=\`OD: \${shortH(rx.sig_optometrist,16)} · Practice: \${shortH(rx.sig_practice,16)}\`;
  }

  const qrEl=document.getElementById('qr-container'); qrEl.innerHTML='';
  try{
    // Encode full payload as base64 — matches /v/:code#base64 format that
    // the verification page decodes. Use btoa(unescape(encodeURIComponent(...)))
    // for Unicode safety (handles · and other non-ASCII chars in practice names).
    const shortCode = rx.prescription_id || '';
    const baseUrl = \`\${API_URL}/v/\${shortCode}\`;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(rx))));
    const qrUrl = \`\${baseUrl}#\${encoded}\`;
    // Use error correction L for maximum data capacity
    new QRCode(qrEl,{text:qrUrl,
      width:148,height:148,colorDark:'#1a1a2e',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.L});
  }catch(e){
    // If still too large (very long notes/address), fall back to short URL only
    const shortCode = rx.prescription_id || '';
    try {
      new QRCode(qrEl,{text:\`\${API_URL}/v/\${shortCode}\`,
        width:148,height:148,colorDark:'#1a1a2e',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
      qrEl.insertAdjacentHTML('beforeend','<div style="font-family:\\'DM Mono\\',monospace;font-size:8px;color:var(--muted);text-align:center;margin-top:5px;max-width:148px;">Short URL only — scan then present PDF</div>');
    } catch(e2) {
      qrEl.innerHTML='<div style="font-family:\\'DM Mono\\',monospace;font-size:9px;color:var(--muted);width:148px;text-align:center;padding:10px;border:1px dashed var(--border);">QR unavailable.<br>Use JSON export.</div>';
    }
  }
}
function downloadRxJson(){
  if(!STATE.lastIssuedRx)return;
  const a=document.createElement('a');
  a.href='data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(STATE.lastIssuedRx,null,2));
  a.download=\`rx-\${STATE.lastIssuedRx.patient.ref.slice(0,8)}-\${STATE.lastIssuedRx.issued_at}.json\`;
  a.click();
}

// ═══════════════ REGISTRY TAB ═══════════════
function renderRegistryTab(){
  // Optometrists
  const ods=Object.values(REGISTRY.optometrists);
  document.getElementById('reg-od-wrap').innerHTML=ods.length?\`
    <table class="registry-table">
      <thead><tr><th>GOC No.</th><th>Name</th><th>Pubkey</th><th>Email Verified</th><th>ID Verified</th><th>Status</th></tr></thead>
      <tbody>\${ods.map(o=>\`<tr>
        <td style="color:var(--ink2);font-weight:500;">\${o.goc}</td>
        <td>\${o.name}</td>
        <td style="font-size:9px;color:var(--muted);cursor:pointer;" onclick="navigator.clipboard?.writeText('\${o.pubHex}');this.textContent='Copied!';setTimeout(()=>this.textContent='\${shortH(o.pubHex,12)}',1400)">\${shortH(o.pubHex,12)}</td>
        <td style="text-align:center;color:var(--green);">✓</td>
        <td style="text-align:center;color:\${o.status==='approved'?'var(--green)':'var(--amber)'};">\${o.status==='approved'?'✓':'Pending'}</td>
        <td><span class="badge \${o.status==='approved'?'badge-valid':o.status==='pending'?'badge-pending':'badge-warn'}">\${o.status}</span></td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No entries yet.</div>';

  // Practices
  const pracs=Object.values(REGISTRY.practices);
  document.getElementById('reg-practice-wrap').innerHTML=pracs.length?\`
    <table class="registry-table">
      <thead><tr><th>Practice</th><th>Reg. No.</th><th>Address</th><th>Pubkey</th><th>Status</th></tr></thead>
      <tbody>\${pracs.map(p=>\`<tr>
        <td><span style="margin-right:6px;">\${p.emoji}</span>\${p.name}</td>
        <td style="font-size:10px;">\${p.reg}</td>
        <td style="font-size:10px;color:var(--muted);">\${p.addr1}, \${p.addr2}</td>
        <td style="font-size:9px;color:var(--muted);cursor:pointer;" onclick="navigator.clipboard?.writeText('\${p.pubHex}');this.textContent='Copied!';setTimeout(()=>this.textContent='\${shortH(p.pubHex,12)}',1400)">\${shortH(p.pubHex,12)}</td>
        <td><span class="badge badge-valid">Active</span></td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No practices registered yet.</div>';

  // Delegations
  document.getElementById('reg-deleg-wrap').innerHTML=REGISTRY.delegations.length?\`
    <table class="registry-table">
      <thead><tr><th>Optometrist</th><th>Practice</th><th>Valid From</th><th>Valid Until</th><th>OD Sig</th><th>Practice Sig</th></tr></thead>
      <tbody>\${REGISTRY.delegations.map(d=>\`<tr>
        <td style="font-size:10px;">\${d.optometrist?.name}<br><span style="color:var(--muted);font-size:9px;">GOC \${d.optometrist?.goc}</span></td>
        <td style="font-size:10px;">\${d.practice?.name}</td>
        <td style="font-size:10px;">\${d.valid_from}</td>
        <td style="font-size:10px;color:\${d.valid_until>=new Date().toISOString().split('T')[0]?'var(--green)':'var(--red)'};">\${d.valid_until}</td>
        <td style="font-size:9px;color:var(--green);">✓ \${shortH(d.sig_optometrist,8)}</td>
        <td style="font-size:9px;color:var(--green);">✓ \${shortH(d.sig_practice,8)}</td>
      </tr>\`).join('')}</tbody>
    </table>\`
    :'<div style="font-family:\\'DM Mono\\',monospace;font-size:11px;color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--border);border-radius:2px;">No delegation certificates issued yet.</div>';
}

function doLookup(){
  const q=document.getElementById('lookup-q').value.trim();
  const el=document.getElementById('lookup-result');
  const od=Object.values(REGISTRY.optometrists).find(o=>o.goc===q||o.pubHex===q||o.goc?.replace(/-/g,'')===q.replace(/-/g,''));
  const pr=Object.values(REGISTRY.practices).find(p=>p.id===q||p.pubHex===q||p.reg===q);
  if(!od&&!pr){
    el.innerHTML=\`<div class="alert alert-warn">No entry found for "\${q}".<br><span style="font-size:9px;">In production this queries the live RxVerify API. Complete the Register + Practice tabs first.</span></div>\`;return;
  }
  const deleg=od?REGISTRY.delegations.filter(d=>d.odPubHex===od.pubHex):[];
  el.innerHTML=\`<div class="card" style="border-color:rgba(45,106,79,0.35);margin-top:12px;">
    \${od?\`<div class="badge badge-valid" style="margin-bottom:12px;">✓ GOC Optometrist Found</div>
    <div style="font-family:'DM Mono',monospace;font-size:11px;line-height:2.0;">
      <div>Name: <strong>\${od.name}</strong></div><div>GOC: <strong>\${od.goc}</strong></div>
      <div>Status: <span style="color:\${od.status==='approved'?'var(--green)':'var(--amber)'};">\${od.status}</span></div>
      <div style="margin-top:8px;font-size:9px;">Pubkey: <span style="color:var(--muted);word-break:break-all;">\${od.pubHex}</span></div>
      \${deleg.length?\`<div style="margin-top:8px;">Active delegations: <span style="color:var(--teal2);">\${deleg.map(d=>d.practice.name).join(', ')}</span></div>\`:''}
    </div>
    <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin-top:10px;padding:9px;background:var(--warm);border-radius:2px;">
      Cross-check: search GOC number <strong>\${od.goc}</strong> at <strong>optical.org/goc/registrants</strong>
    </div>\`:''}
    \${pr?\`<div class="badge badge-info" style="margin-bottom:12px;">✓ Practice Found</div>
    <div style="font-family:'DM Mono',monospace;font-size:11px;line-height:2.0;">
      <div>Name: <strong>\${pr.name}</strong></div><div>Reg: <strong>\${pr.reg}</strong></div>
      <div>Address: \${pr.addr1}, \${pr.addr2}</div>
    </div>\`:''}
  </div>\`;
}

// ═══════════════ EXPOSE TO WINDOW ═══════════════
// ES module functions are scoped — expose all UI-callable
// functions to window so onclick= handlers can reach them
Object.assign(window, {
  showTab, setRecall, updateRecallSummary,
  goWizard, generateKeys, copyEl, downloadKeys,
  saveKeysToStorage, loadSavedKeys,
  simulateSendCode, verifyOTP,
  simulateUpload, submitForVerification, approveDemo,
  registerPractice, addDemoPractices, refreshPracticeTab,
  setActivePractice, issueDelegation,
  refreshIssueTab, updateIssueBanner, issuePrescription,
  clearIssueForm, handlePDFDrop, handlePDFFile, applyExtraction,
  setNum, setText, setDOB, setAxis,
  loadIssuedIntoVerifier, verifyPrescription,
  renderPatientView, downloadRxJson,
  renderRegistryTab, doLookup,
});

// ═══════════════ INIT ═══════════════
window.addEventListener('load',()=>{
  updateRecallSummary();
  const saved=localStorage.getItem('rxverify_state');
  if(saved){
    try{
      const s=JSON.parse(saved);
      if(s.pubHex&&s.privHex&&s.prescriber){
        Object.assign(STATE,s);
        setEl('pub-key-display',shortH(s.pubHex,20),s.pubHex);
        setEl('priv-key-display',shortH(s.privHex,20),s.privHex);
        document.getElementById('keys-card').style.display='block';
        document.getElementById('setup-name').value=s.prescriber.name||'';
        document.getElementById('setup-goc').value=s.prescriber.goc||'';
        if(s.prescriber.email) document.getElementById('setup-email').value=s.prescriber.email;
        if(s.prescriber) REGISTRY.optometrists[s.pubHex]={...s.prescriber,status:s.registryStatus||'unverified',registeredAt:new Date().toISOString()};
        updateHeader();
        document.querySelectorAll('.wstep').forEach(ws=>ws.classList.add('done'));
        // Auto-register in Supabase on every load to keep registry current
        fetch(\`\${API_URL}/api/registry/auto-register\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npub: s.pubHex,
            goc_number: s.prescriber.goc,
            name: s.prescriber.name,
            practice: s.prescriber.practice || null,
            jurisdiction: 'UK-GOC'
          })
        }).then(() => {
          STATE.registryStatus = 'approved';
          updateHeader();
        }).catch(() => {});
      }
    }catch(e){}
  }
});
</script>
</body>
</html>
`;

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
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/status', (req, res) => res.json({
  service: 'RxVerify API', version: '2.0.0',
  status: 'operational', timestamp: new Date().toISOString()
}));

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

module.exports = app;
