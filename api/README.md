# RxVerify Backend — Deployment Guide

## Prerequisites completed
- Supabase project created
- Resend account created  
- Anthropic API key obtained
- Vercel account created
- Domain rxverify.co.uk purchased

---

## STEP 1 — Run the database schema (5 minutes)

1. Go to: https://supabase.com/dashboard
2. Select your rxverify project
3. Click "SQL Editor" in left sidebar
4. Click "New Query"
5. Open the file: schema.sql
6. Copy ALL the contents
7. Paste into the SQL editor
8. Click "Run"
9. You should see: "Success. No rows returned"
10. Click "Table Editor" — you should see 5 tables:
    prescriptions, registry_entries, practices, 
    delegations, recall_queue

---

## STEP 2 — Set up environment variables on Vercel (10 minutes)

You will NOT deploy the .env file — instead add these
as environment variables in the Vercel dashboard.

1. Go to: https://vercel.com/dashboard
2. After deploying (step 3), go to your project
3. Click Settings → Environment Variables
4. Add each of these:

   Name                  Value
   ─────────────────────────────────────────────
   SUPABASE_URL          https://sgvbejwqgvzdbqkaohum.supabase.co
   SUPABASE_ANON_KEY     eyJhbGci... (your anon key)
   SUPABASE_SERVICE_KEY  eyJhbGci... (your service key)
   RESEND_API_KEY        re_XgTBn8... (your resend key)
   ANTHROPIC_API_KEY     sk-ant-api03... (your anthropic key)
   EMAIL_FROM            prescriptions@rxverify.co.uk
   EMAIL_FROM_NAME       RxVerify
   APP_URL               https://rxverify.co.uk
   NODE_ENV              production

5. Click Save for each one

IMPORTANT: Rotate your keys after this deployment
since they were shared in a chat. See STEP 6.

---

## STEP 3 — Deploy to Vercel (10 minutes)

Option A — Via GitHub (recommended):

1. Create a GitHub account if needed: github.com
2. Create a new repository called "rxverify-backend"
3. Upload all files from this folder to the repo
   (drag and drop in GitHub interface — no git needed)
4. In Vercel: "Add New Project"
5. Import your rxverify-backend repository
6. Vercel auto-detects Node.js
7. Click Deploy
8. Wait ~2 minutes
9. You get a URL like: rxverify-backend.vercel.app

Option B — Via Vercel CLI:

1. Install Node.js from: nodejs.org (LTS version)
2. Open Terminal (Mac) or Command Prompt (Windows)
3. Run these commands one at a time:

   npm install -g vercel
   cd /path/to/rxverify-backend
   npm install
   vercel

4. Follow the prompts
5. When asked "Link to existing project?" → No
6. When asked project name → rxverify-backend
7. Vercel deploys and gives you a URL

---

## STEP 4 — Connect your domain (10 minutes)

1. In Vercel: Project → Settings → Domains
2. Add: rxverify.co.uk
3. Vercel shows you DNS records to add
4. Go to Namecheap → rxverify.co.uk → DNS
5. Add the A record and CNAME Vercel provides
6. Wait 5-15 minutes for DNS to propagate
7. Visit https://rxverify.co.uk — should show:
   {"service":"RxVerify API","status":"operational"}

---

## STEP 5 — Update the HTML file (2 minutes)

In rxverify-uk.html, find this line near the top of
the JavaScript section:

  const API_URL = 'https://rxverify-backend.vercel.app';

Replace with your actual Vercel URL or custom domain:

  const API_URL = 'https://rxverify.co.uk';

Save the file. This connects the frontend to your backend.

---

## STEP 6 — Rotate your API keys (15 minutes)

Since keys were shared during setup, rotate them all:

Supabase:
  Dashboard → Settings → API → Regenerate JWT secret
  Copy new keys → update Vercel environment variables

Resend:
  Dashboard → API Keys → Delete old key → Create new
  Copy new key → update Vercel environment variable

Anthropic:
  console.anthropic.com → API Keys → Delete old → New
  Copy new key → update Vercel environment variable

After updating each key in Vercel:
  Vercel → Project → Deployments → Redeploy

---

## STEP 7 — Test end to end (15 minutes)

1. Open rxverify-uk.html in Chrome
2. Go to Register tab → generate keys
3. Go to Practice tab → register your practice
4. Go to Issue Rx tab → fill in a test prescription
   Use your own email address for the patient email
5. Click Sign & Issue
6. You should see:
   ✓ Signed
   ✓ Saved to server
   ✓ Email sent
7. Check your email — prescription should arrive
8. Click the verification link in the email
9. Page should show ✓ Authentic Verified Prescription
10. All 5 verification checks should be green

If any step fails, check:
  - Vercel function logs (Vercel → Project → Functions)
  - Supabase logs (Supabase → Logs → Edge Functions)
  - Browser console (F12 → Console tab)

---

## API Endpoints Reference

GET  /                              Health check
GET  /api/health                    Health check JSON
POST /api/prescriptions             Store signed prescription
GET  /api/prescriptions/:code       Fetch prescription
GET  /api/registry/goc/:number      Registry lookup by GOC
GET  /api/registry/npub/:npub       Registry lookup by pubkey
POST /api/registry/register         Register new keypair
GET  /api/registry/log              Full transparency log
POST /api/send/email                Send prescription email
POST /api/generate/pdf              Generate PDF
POST /api/extract                   AI extraction from PDF
GET  /v/:code                       Patient verification page

---

## Support

If anything goes wrong, copy the error message and
paste it into Claude — I can debug from the error.

---

## v2 Changes — Hash-Only Storage + Verify Endpoint

### What changed

**prescription_registry table replaces prescriptions table**
Run the updated schema.sql — it drops the old table and creates the new one.
No clinical data is stored. Only the hash, signature, and metadata.

**New endpoint: POST /api/verify**
The core verification endpoint. Retailers and pharmacies call this.
Pass the short_code and the full payload the patient presented.
Returns: valid true/false + all check results + prescriber details.
Clinical data comes from the patient — not from RxVerify.

**New endpoint: GET /widget.js**
Embeddable JavaScript widget for retailers.
Add to any website with one script tag.
Handles verification UI, QR scan prompt, and auto-population callback.

**Verification page updated**
Patient visits rxverify.co.uk/v/RXV-XXXXX-X
Full prescription arrives in the URL fragment (#base64_payload)
Fragment is never sent to the server
JavaScript decodes and verifies client-side
Clinical data never touches RxVerify servers

### For retailers — integration in 3 lines

```html
<!-- Add to your checkout page -->
<script src="https://rxverify.co.uk/widget.js"></script>
<div id="rxverify-widget"
     data-retailer-key="ret_your_key"
     data-on-success="populateOrderForm">
</div>

<script>
function populateOrderForm(verified) {
  // verified.rx contains all clinical values
  // verified.prescriber contains GOC details
  document.getElementById('r-sphere').value = verified.rx.right.sphere;
  document.getElementById('l-sphere').value = verified.rx.left.sphere;
  // etc.
}
</script>
```

### API summary

| Endpoint | Method | Purpose |
|---|---|---|
| /api/prescriptions | POST | Store hash after signing |
| /api/verify | POST | Full verification with payload |
| /api/verify/:code | GET | Quick existence/expiry check |
| /api/registry/goc/:number | GET | Registry lookup |
| /api/registry/npub/:npub | GET | Registry lookup |
| /api/registry/register | POST | Register new keypair |
| /api/registry/log | GET | Transparency log |
| /api/send/email | POST | Send prescription email |
| /api/generate/pdf | POST | Generate branded PDF |
| /api/extract | POST | AI extraction from PMS PDF |
| /v/:code | GET | Patient verification page |
| /widget.js | GET | Retailer embed widget |

### Compliance statement

> RxVerify stores only cryptographic fingerprints (SHA-256 hashes)
> of prescriptions alongside metadata (timestamps, recall dates).
> No patient name, date of birth, refractive data, or any clinical
> content is stored on RxVerify servers at any time.
> The prescription belongs to the patient and is held by the patient.
> RxVerify is a verification infrastructure provider, not a health
> record custodian.
