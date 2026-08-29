// PRE-AUDIT OS — Phase 1 database layer.
//
// Uses Node's built-in `node:sqlite` (stable since Node 22.5, marked
// experimental by Node itself but fully functional) instead of Prisma.
// Reason: this sandbox's network policy blocks binaries.prisma.sh, so
// `prisma generate` cannot fetch its query engine here. node:sqlite
// ships inside Node itself — zero native compilation, zero network
// dependency, and it is a real relational database, not a mock.
//
// Moving to PostgreSQL later (for multi-user / production use, as the
// original spec assumes) means replacing this file with a Postgres
// client (e.g. `postgres` or `pg`) behind the same exported functions —
// the rest of the app (API routes, pages) does not need to change,
// because everything talks to the functions exported here, never to
// SQL directly.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.DATABASE_FILE || path.join(process.cwd(), "data", "dev.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','AUDITOR','EXECUTOR')) DEFAULT 'AUDITOR',
  active        INTEGER NOT NULL DEFAULT 1,
  token_epoch   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id                       TEXT PRIMARY KEY,
  legal_name               TEXT NOT NULL,
  legal_name_ar            TEXT,
  commercial_registration  TEXT,
  vat_number               TEXT,
  currency                 TEXT NOT NULL DEFAULT 'SAR',
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fiscal_years (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('DRAFT','IN_PROGRESS','CLOSED')) DEFAULT 'DRAFT',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, year)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Phase 2 — Excel/CSV import (Trial Balance + General Ledger)
-- ============================================================

-- One row per uploaded file. Holds detection, the confirmed type,
-- the column mapping, the quality report, and the mandatory
-- source-vs-imported reconciliation result. The uploaded file itself
-- is kept on disk at stored_path (the S3 replacement the README noted
-- would arrive in Phase 2) so every imported number can be traced back
-- to the exact bytes it came from.
CREATE TABLE IF NOT EXISTS import_batches (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id        TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  file_name             TEXT NOT NULL,
  sheet_name            TEXT,
  file_size             INTEGER,
  stored_path           TEXT NOT NULL,
  detected_type         TEXT,        -- TRIAL_BALANCE | GENERAL_LEDGER | UNKNOWN
  detection_confidence  REAL,        -- 0..1
  detection_reason      TEXT,
  confirmed_type        TEXT CHECK (confirmed_type IN ('TRIAL_BALANCE','GENERAL_LEDGER')),
  headers_json          TEXT,        -- JSON array of the detected header cells
  mapping_json          TEXT,        -- JSON object: standardField -> sourceColumnHeader
  status                TEXT NOT NULL CHECK (status IN ('UPLOADED','MAPPED','VALIDATED','BLOCKED','COMMITTED')) DEFAULT 'UPLOADED',
  total_rows            INTEGER,
  quality_score         INTEGER,     -- 0..100 (computed, never random)
  quality_json          TEXT,        -- JSON: array of check results
  source_total_debit    REAL,
  source_total_credit   REAL,
  imported_total_debit  REAL,
  imported_total_credit REAL,
  recon_difference      REAL,        -- source total - imported total (must be 0 to be ready)
  created_by            TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable column-mapping templates so a recurring file layout is
-- mapped once and reused. Unique per (name, file_type).
CREATE TABLE IF NOT EXISTS mapping_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  file_type     TEXT NOT NULL CHECK (file_type IN ('TRIAL_BALANCE','GENERAL_LEDGER')),
  mapping_json  TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, file_type)
);

-- Imported Trial Balance rows. Every row carries its data lineage:
-- source_file, source_sheet, source_row, and import_batch_id.
CREATE TABLE IF NOT EXISTS trial_balances (
  id              TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id  TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  account_code    TEXT NOT NULL,
  account_name    TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  debit           REAL NOT NULL DEFAULT 0,
  credit          REAL NOT NULL DEFAULT 0,
  closing_balance REAL NOT NULL DEFAULT 0,
  source_file     TEXT NOT NULL,
  source_sheet    TEXT,
  source_row      INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Imported General Ledger rows. Same data-lineage columns.
CREATE TABLE IF NOT EXISTS general_ledger (
  id              TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id  TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  entry_date      TEXT,
  journal         TEXT,
  account_code    TEXT NOT NULL,
  account_name    TEXT,
  partner         TEXT,
  reference       TEXT,
  description     TEXT,
  debit           REAL NOT NULL DEFAULT 0,
  credit          REAL NOT NULL DEFAULT 0,
  source_file     TEXT NOT NULL,
  source_sheet    TEXT,
  source_row      INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tb_batch   ON trial_balances(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_tb_account ON trial_balances(company_id, account_code);
CREATE INDEX IF NOT EXISTS idx_gl_batch   ON general_ledger(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_gl_account ON general_ledger(company_id, account_code);

-- ============================================================
-- Phase 3 — Risk assessment & analytical procedures
-- ============================================================

-- Materiality is the single stored setting Phase 3 needs; the analytical
-- procedures themselves are computed live from the imported TB/GL so they
-- are never stale. One materiality per (company, fiscal_year); a NULL
-- fiscal_year row is the company-wide default.
CREATE TABLE IF NOT EXISTS materiality_settings (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id TEXT REFERENCES fiscal_years(id) ON DELETE CASCADE,
  amount         REAL NOT NULL,
  basis_note     TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, fiscal_year_id)
);

-- ============================================================
-- Phase 4 — Evidence & audit procedures
-- ============================================================

-- An audit procedure is a work item, usually generated from a Phase 3
-- risk flag (risk_type + account_code identify what it addresses) but can
-- also be created manually. It carries a status and a conclusion.
CREATE TABLE IF NOT EXISTS audit_procedures (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  risk_type      TEXT,                 -- e.g. TB_GL_MISMATCH, LARGE_ITEM, or NULL for manual
  account_code   TEXT,
  severity       TEXT NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW','INFO','MANUAL')) DEFAULT 'MANUAL',
  title          TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','DONE','NA')) DEFAULT 'OPEN',
  conclusion     TEXT,
  assigned_to    TEXT REFERENCES users(id),
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Evidence files attached to a procedure. The bytes are kept on disk
-- (data/uploads) exactly like the imported source files.
CREATE TABLE IF NOT EXISTS evidence_files (
  id            TEXT PRIMARY KEY,
  procedure_id  TEXT NOT NULL REFERENCES audit_procedures(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  file_size     INTEGER,
  note          TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proc_company  ON audit_procedures(company_id);
CREATE INDEX IF NOT EXISTS idx_proc_riskkey  ON audit_procedures(company_id, risk_type, account_code);
CREATE INDEX IF NOT EXISTS idx_evidence_proc ON evidence_files(procedure_id);

-- ============================================================
-- Phase 5 — Findings, adjustments, management review
-- ============================================================

-- An audit finding, optionally raised from a procedure.
CREATE TABLE IF NOT EXISTS findings (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id      TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  procedure_id        TEXT REFERENCES audit_procedures(id) ON DELETE SET NULL,
  account_code        TEXT,
  title               TEXT NOT NULL,
  description         TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW')) DEFAULT 'MEDIUM',
  recommendation      TEXT,
  management_response TEXT,
  status              TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','ACCEPTED_RISK')) DEFAULT 'OPEN',
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A proposed adjusting journal entry (header). Its lines must balance
-- (sum debit = sum credit) before it can be APPROVED.
CREATE TABLE IF NOT EXISTS adjustments (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  finding_id     TEXT REFERENCES findings(id) ON DELETE SET NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED')) DEFAULT 'PROPOSED',
  created_by     TEXT REFERENCES users(id),
  approved_by    TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adjustment_lines (
  id             TEXT PRIMARY KEY,
  adjustment_id  TEXT NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
  account_code   TEXT NOT NULL,
  account_name   TEXT,
  debit          REAL NOT NULL DEFAULT 0,
  credit         REAL NOT NULL DEFAULT 0
);

-- Management review / sign-off history (append-only).
CREATE TABLE IF NOT EXISTS management_reviews (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id TEXT REFERENCES fiscal_years(id) ON DELETE SET NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('APPROVED','RETURNED')),
  notes          TEXT,
  reviewed_by    TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 12: report integrity signatures (SHA-256 of the report content).
CREATE TABLE IF NOT EXISTS report_signatures (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  note         TEXT,
  signed_by    TEXT REFERENCES users(id),
  signed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repsig_company ON report_signatures(company_id);

CREATE INDEX IF NOT EXISTS idx_findings_company ON findings(company_id);
CREATE INDEX IF NOT EXISTS idx_adj_company      ON adjustments(company_id);
CREATE INDEX IF NOT EXISTS idx_adjlines_adj     ON adjustment_lines(adjustment_id);
CREATE INDEX IF NOT EXISTS idx_review_company    ON management_reviews(company_id);
`);

// ---- Phase 8 migration: allow the EXECUTOR role on pre-existing databases ----
// The users.role CHECK originally allowed only ADMIN/AUDITOR. SQLite can't
// ALTER a CHECK, so if an older users table is detected we rebuild it with
// the safe rename recipe (data + foreign keys preserved).
{
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string } | undefined;
  if (ddl && !ddl.sql.includes("EXECUTOR")) {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    try {
      db.exec(`CREATE TABLE users_new (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('ADMIN','AUDITOR','EXECUTOR')) DEFAULT 'AUDITOR',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      db.exec("INSERT INTO users_new SELECT id, name, email, password_hash, role, created_at, updated_at FROM users");
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_new RENAME TO users");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    db.exec("PRAGMA foreign_keys=ON");
  }
}

// ---- Phase 9 migration: add users.active (enable/disable) to older DBs ----
// ALTER TABLE ADD COLUMN is safe and supported by SQLite (no rebuild needed).
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
  // Phase 11: token_epoch for immediate session invalidation
  const cols2 = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols2.some((c) => c.name === "token_epoch")) {
    db.exec("ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0");
  }
}

export function id() {
  return crypto.randomUUID();
}

/**
 * Run a set of writes inside a single SQLite transaction. If the body
 * throws (e.g. reconciliation fails), everything is rolled back so no
 * half-imported data is ever left behind. Used by the import commit.
 */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export default db;
