-- ═══════════════════════════════════════════════════════
-- RxVerify Database Schema v2
-- Hash-only prescription storage — zero clinical data
--
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

-- ── Drop old tables if re-running ───────────────────────
DROP TABLE IF EXISTS prescription_registry CASCADE;
DROP TABLE IF EXISTS prescriptions          CASCADE;
DROP TABLE IF EXISTS verification_log       CASCADE;
DROP TABLE IF EXISTS registry_entries       CASCADE;
DROP TABLE IF EXISTS practices              CASCADE;
DROP TABLE IF EXISTS delegations            CASCADE;
DROP TABLE IF EXISTS recall_queue           CASCADE;

-- ═══════════════════════════════════════════════════════
-- PRESCRIPTION REGISTRY
-- Stores only the cryptographic fingerprint and metadata
-- NO patient name, NO date of birth, NO refractive data
-- NO clinical content of any kind
-- 
-- Compliance position:
--   "We store only a cryptographic hash (fingerprint)
--    of each prescription and associated metadata.
--    No health data or PII is stored on our servers.
--    The prescription belongs to the patient."
-- ═══════════════════════════════════════════════════════
CREATE TABLE prescription_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  short_code      TEXT UNIQUE NOT NULL,     -- RXV-XXXXX-X
  payload_hash    TEXT NOT NULL,            -- sha256(canonical_payload)
  sig             TEXT NOT NULL,            -- secp256k1 Schnorr signature

  -- Prescriber (public information — already on GOC register)
  prescriber_goc  TEXT NOT NULL,            -- e.g. 01-23456
  prescriber_npub TEXT NOT NULL,            -- secp256k1 public key

  -- Temporal metadata
  schema_version  TEXT DEFAULT 'rxv1-uk',
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,

  -- Recall (date only — no clinical context)
  recall_months   INTEGER,
  recall_due      DATE,

  -- Contact (hashed — for recall notifications only)
  -- sha256(email) — cannot be reversed to obtain email
  contact_hash    TEXT,

  -- Audit
  claimed_at      TIMESTAMPTZ,             -- when patient first opened link
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  -- NOT STORED:
  -- patient_name, patient_dob, patient_address
  -- sphere, cylinder, axis, add, prism
  -- any refractive or clinical data
  -- any personally identifiable information

  CONSTRAINT short_code_format CHECK (short_code ~ '^RXV-[A-Z0-9]{5}-[A-Z0-9]$')
);

-- ═══════════════════════════════════════════════════════
-- REGISTRY ENTRIES
-- Maps prescriber public keys to GOC registration numbers
-- All fields are professional/public information
-- ═══════════════════════════════════════════════════════
CREATE TABLE registry_entries (
  npub            TEXT PRIMARY KEY,         -- secp256k1 public key
  goc_number      TEXT UNIQUE NOT NULL,     -- GOC registration number
  name            TEXT NOT NULL,            -- as on GOC register
  practice        TEXT,
  address         TEXT,
  jurisdiction    TEXT DEFAULT 'UK-GOC',
  status          TEXT DEFAULT 'pending',   -- pending|approved|revoked|lapsed
  email_verified  BOOLEAN DEFAULT FALSE,
  id_verified     BOOLEAN DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT status_values CHECK (status IN ('pending','approved','revoked','lapsed'))
);

-- ═══════════════════════════════════════════════════════
-- PRACTICES
-- Practice identity and branding
-- ═══════════════════════════════════════════════════════
CREATE TABLE practices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  registration    TEXT,
  address_1       TEXT,
  address_2       TEXT,
  phone           TEXT,
  email           TEXT,
  colour          TEXT DEFAULT '#005f73',
  emoji           TEXT DEFAULT '👁',
  npub            TEXT,
  registered_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- DELEGATIONS
-- Locum authorisation certificates
-- ═══════════════════════════════════════════════════════
CREATE TABLE delegations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  od_npub         TEXT NOT NULL,
  practice_id     TEXT NOT NULL,
  valid_from      DATE NOT NULL,
  valid_until     DATE NOT NULL,
  sig_od          TEXT NOT NULL,
  issued_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- RECALL QUEUE
-- Stores only recall date + hashed contact
-- No clinical data, no prescription content
-- ═══════════════════════════════════════════════════════
CREATE TABLE recall_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code      TEXT REFERENCES prescription_registry(short_code),
  contact_hash    TEXT NOT NULL,           -- sha256(email)
  recall_due      DATE NOT NULL,
  sent_at         TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- VERIFICATION LOG
-- Audit trail of verification events
-- No clinical data — just metadata about checks performed
-- ═══════════════════════════════════════════════════════
CREATE TABLE verification_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code      TEXT NOT NULL,
  verified_at     TIMESTAMPTZ NOT NULL,
  result          TEXT NOT NULL,           -- valid|invalid
  checks          JSONB,                   -- which checks passed/failed
  retailer_key    TEXT,                    -- which retailer verified (if any)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════
ALTER TABLE prescription_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE practices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE recall_queue          ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_log      ENABLE ROW LEVEL SECURITY;

-- Public read — anyone can verify
CREATE POLICY "Public read prescription_registry"
  ON prescription_registry FOR SELECT USING (true);

CREATE POLICY "Public read registry_entries"
  ON registry_entries FOR SELECT USING (true);

CREATE POLICY "Public read practices"
  ON practices FOR SELECT USING (true);

-- Service role writes (backend uses service key)
CREATE POLICY "Service insert prescription_registry"
  ON prescription_registry FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update prescription_registry"
  ON prescription_registry FOR UPDATE USING (true);

CREATE POLICY "Service insert registry_entries"
  ON registry_entries FOR INSERT WITH CHECK (true);

CREATE POLICY "Service update registry_entries"
  ON registry_entries FOR UPDATE USING (true);

CREATE POLICY "Service insert practices"
  ON practices FOR INSERT WITH CHECK (true);

CREATE POLICY "Service insert delegations"
  ON delegations FOR INSERT WITH CHECK (true);

CREATE POLICY "Service all recall_queue"
  ON recall_queue FOR ALL USING (true);

CREATE POLICY "Service insert verification_log"
  ON verification_log FOR INSERT WITH CHECK (true);

CREATE POLICY "Service read verification_log"
  ON verification_log FOR SELECT USING (true);

-- ═══════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════
CREATE INDEX idx_prescription_short_code
  ON prescription_registry(short_code);

CREATE INDEX idx_prescription_goc
  ON prescription_registry(prescriber_goc);

CREATE INDEX idx_prescription_recall
  ON prescription_registry(recall_due)
  WHERE recall_due IS NOT NULL;

CREATE INDEX idx_registry_goc
  ON registry_entries(goc_number);

CREATE INDEX idx_registry_npub
  ON registry_entries(npub);

CREATE INDEX idx_recall_due
  ON recall_queue(recall_due)
  WHERE status = 'pending';

CREATE INDEX idx_verification_log_code
  ON verification_log(short_code);

-- ═══════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════
-- Expected tables in Supabase Table Editor:
--   prescription_registry  ← hash only, no clinical data
--   registry_entries       ← GOC keypair mapping
--   practices              ← practice identity
--   delegations            ← locum authorisation
--   recall_queue           ← recall scheduler
--   verification_log       ← audit trail
--
-- What is NOT stored anywhere:
--   Patient name
--   Patient date of birth
--   Sphere, cylinder, axis, add
--   Any refractive or clinical data
--   Any unencrypted PII
