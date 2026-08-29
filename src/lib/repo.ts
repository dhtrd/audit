import db, { id, transaction } from "./db";

// A monotonic in-process counter bumped on every audit-logged write. Read
// models (e.g. the portfolio cache) key their memoization on it so the
// cache is invalidated automatically whenever ANY sensitive write happens —
// correct invalidation, never stale. Resets to 0 on process restart (cache
// simply recomputes then).
let writeVersion = 0;
export function getWriteVersion(): number { return writeVersion; }

export type Role = "ADMIN" | "AUDITOR" | "EXECUTOR";
export type FiscalYearStatus = "DRAFT" | "IN_PROGRESS" | "CLOSED";

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  active: number; // 1 = active, 0 = disabled
  token_epoch: number; // bumped to invalidate existing sessions
  created_at: string;
  updated_at: string;
}

export interface Company {
  id: string;
  legal_name: string;
  legal_name_ar: string | null;
  commercial_registration: string | null;
  vat_number: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface FiscalYear {
  id: string;
  company_id: string;
  year: number;
  start_date: string;
  end_date: string;
  status: FiscalYearStatus;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string | null;
  created_at: string;
}

// ---------- Users ----------
export function createUser(input: { name: string; email: string; passwordHash: string; role?: Role }): User {
  const newId = id();
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`
  ).run(newId, input.name, input.email, input.passwordHash, input.role ?? "AUDITOR");
  return findUserById(newId)!;
}

export function findUserByEmail(email: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as unknown as User | undefined;
}

export function findUserById(userId: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as unknown as User | undefined;
}

export function countUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM users`).get() as { c: number };
  return row.c;
}

export function listUsers(): Omit<User, "password_hash">[] {
  return db
    .prepare(`SELECT id, name, email, role, active, created_at, updated_at FROM users ORDER BY created_at ASC`)
    .all() as unknown as Omit<User, "password_hash">[];
}

/** Number of ACTIVE admins — used to prevent locking out the last admin. */
export function countActiveAdmins(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'ADMIN' AND active = 1`).get() as { c: number };
  return row.c;
}

export function updateUserRole(userId: string, role: Role): User | undefined {
  // No epoch bump needed: getSession reads the role fresh from the DB, so a
  // role change takes effect on the user's very next request (no re-login).
  db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`).run(role, userId);
  return findUserById(userId);
}

export function setUserActive(userId: string, active: boolean): User | undefined {
  // No epoch bump needed: getSession rejects users whose active = 0, so a
  // disable takes effect immediately on the next request.
  db.prepare(`UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?`).run(active ? 1 : 0, userId);
  return findUserById(userId);
}

/** Bump only the token epoch — invalidates all of this user's sessions
 *  (used by "terminate all sessions"). */
export function bumpTokenEpoch(userId: string): User | undefined {
  db.prepare(`UPDATE users SET token_epoch = token_epoch + 1, updated_at = datetime('now') WHERE id = ?`).run(userId);
  return findUserById(userId);
}

export function updateUserPassword(userId: string, passwordHash: string): User | undefined {
  // Bump the epoch so ALL existing tokens for this user become stale — a
  // password change invalidates every other session immediately.
  db.prepare(`UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, userId);
  return findUserById(userId);
}

// ---------- Companies ----------
export function createCompany(input: {
  legalName: string;
  legalNameAr?: string | null;
  commercialRegistration?: string | null;
  vatNumber?: string | null;
  currency?: string;
}): Company {
  const newId = id();
  db.prepare(
    `INSERT INTO companies (id, legal_name, legal_name_ar, commercial_registration, vat_number, currency)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    newId,
    input.legalName,
    input.legalNameAr ?? null,
    input.commercialRegistration ?? null,
    input.vatNumber ?? null,
    input.currency ?? "SAR"
  );
  return getCompany(newId)!;
}

export function updateCompany(companyId: string, input: Partial<{
  legalName: string; legalNameAr: string | null; commercialRegistration: string | null;
  vatNumber: string | null; currency: string;
}>): Company | undefined {
  const current = getCompany(companyId);
  if (!current) return undefined;
  db.prepare(
    `UPDATE companies SET legal_name = ?, legal_name_ar = ?, commercial_registration = ?, vat_number = ?, currency = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.legalName ?? current.legal_name,
    input.legalNameAr !== undefined ? input.legalNameAr : current.legal_name_ar,
    input.commercialRegistration !== undefined ? input.commercialRegistration : current.commercial_registration,
    input.vatNumber !== undefined ? input.vatNumber : current.vat_number,
    input.currency ?? current.currency,
    companyId
  );
  return getCompany(companyId);
}

export function getCompany(companyId: string): Company | undefined {
  return db.prepare(`SELECT * FROM companies WHERE id = ?`).get(companyId) as unknown as Company | undefined;
}

export function listCompanies(): Company[] {
  return db.prepare(`SELECT * FROM companies ORDER BY created_at DESC`).all() as unknown as Company[];
}

export function countCompanies(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM companies`).get() as { c: number };
  return row.c;
}

// ---------- Fiscal Years ----------
export function createFiscalYear(input: {
  companyId: string; year: number; startDate: string; endDate: string; status?: FiscalYearStatus;
}): FiscalYear {
  const newId = id();
  db.prepare(
    `INSERT INTO fiscal_years (id, company_id, year, start_date, end_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId, input.companyId, input.year, input.startDate, input.endDate, input.status ?? "DRAFT");
  return getFiscalYear(newId)!;
}

export function getFiscalYear(fyId: string): FiscalYear | undefined {
  return db.prepare(`SELECT * FROM fiscal_years WHERE id = ?`).get(fyId) as unknown as FiscalYear | undefined;
}

export function listFiscalYears(companyId?: string): FiscalYear[] {
  if (companyId) {
    return db.prepare(`SELECT * FROM fiscal_years WHERE company_id = ? ORDER BY year DESC`).all(companyId) as unknown as FiscalYear[];
  }
  return db.prepare(`SELECT * FROM fiscal_years ORDER BY year DESC`).all() as unknown as FiscalYear[];
}

export function updateFiscalYearStatus(fyId: string, status: FiscalYearStatus): FiscalYear | undefined {
  db.prepare(`UPDATE fiscal_years SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, fyId);
  return getFiscalYear(fyId);
}

export function countFiscalYears(): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM fiscal_years`).get() as { c: number };
  return row.c;
}

// ---------- Audit Trail ----------
// No delete/update functions are exported for audit_logs on purpose —
// per spec section 49 / invariant 7, logs must not be silently alterable.
export function writeAuditLog(input: {
  userId: string | null; action: string; entityType: string; entityId?: string | null; details?: unknown;
}): void {
  db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id(),
    input.userId,
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.details !== undefined ? JSON.stringify(input.details) : null
  );
  writeVersion++; // every sensitive write bumps the version (portfolio cache key)
}

export function listAuditLogs(limit = 100): (AuditLogEntry & { user_name: string | null })[] {
  return db.prepare(
    `SELECT al.*, u.name as user_name FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ORDER BY al.created_at DESC LIMIT ?`
  ).all(limit) as unknown as (AuditLogEntry & { user_name: string | null })[];
}

// ============================================================
// Phase 2 — Import (Trial Balance + General Ledger)
// ============================================================

export type ImportFileType = "TRIAL_BALANCE" | "GENERAL_LEDGER";
export type ImportStatus = "UPLOADED" | "MAPPED" | "VALIDATED" | "BLOCKED" | "COMMITTED";

export interface ImportBatch {
  id: string;
  company_id: string;
  fiscal_year_id: string | null;
  file_name: string;
  sheet_name: string | null;
  file_size: number | null;
  stored_path: string;
  detected_type: string | null;
  detection_confidence: number | null;
  detection_reason: string | null;
  confirmed_type: ImportFileType | null;
  headers_json: string | null;
  mapping_json: string | null;
  status: ImportStatus;
  total_rows: number | null;
  quality_score: number | null;
  quality_json: string | null;
  source_total_debit: number | null;
  source_total_credit: number | null;
  imported_total_debit: number | null;
  imported_total_credit: number | null;
  recon_difference: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrialBalanceRow {
  id: string;
  import_batch_id: string;
  company_id: string;
  fiscal_year_id: string | null;
  account_code: string;
  account_name: string | null;
  opening_balance: number;
  debit: number;
  credit: number;
  closing_balance: number;
  source_file: string;
  source_sheet: string | null;
  source_row: number;
  created_at: string;
}

export interface GeneralLedgerRow {
  id: string;
  import_batch_id: string;
  company_id: string;
  fiscal_year_id: string | null;
  entry_date: string | null;
  journal: string | null;
  account_code: string;
  account_name: string | null;
  partner: string | null;
  reference: string | null;
  description: string | null;
  debit: number;
  credit: number;
  source_file: string;
  source_sheet: string | null;
  source_row: number;
  created_at: string;
}

export interface MappingTemplate {
  id: string;
  name: string;
  file_type: ImportFileType;
  mapping_json: string;
  created_by: string | null;
  created_at: string;
}

// ---------- Import batches ----------
export function createImportBatch(input: {
  companyId: string;
  fiscalYearId?: string | null;
  fileName: string;
  sheetName?: string | null;
  fileSize?: number | null;
  storedPath: string;
  detectedType?: string | null;
  detectionConfidence?: number | null;
  detectionReason?: string | null;
  headers?: string[];
  totalRows?: number | null;
  createdBy: string | null;
}): ImportBatch {
  const newId = id();
  db.prepare(
    `INSERT INTO import_batches
       (id, company_id, fiscal_year_id, file_name, sheet_name, file_size, stored_path,
        detected_type, detection_confidence, detection_reason, headers_json, total_rows, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED', ?)`
  ).run(
    newId,
    input.companyId,
    input.fiscalYearId ?? null,
    input.fileName,
    input.sheetName ?? null,
    input.fileSize ?? null,
    input.storedPath,
    input.detectedType ?? null,
    input.detectionConfidence ?? null,
    input.detectionReason ?? null,
    input.headers ? JSON.stringify(input.headers) : null,
    input.totalRows ?? null,
    input.createdBy
  );
  return getImportBatch(newId)!;
}

export function getImportBatch(batchId: string): ImportBatch | undefined {
  return db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId) as unknown as ImportBatch | undefined;
}

export function listImportBatches(companyId?: string): (ImportBatch & { company_name: string | null; creator_name: string | null })[] {
  const base = `SELECT ib.*, c.legal_name as company_name, u.name as creator_name
     FROM import_batches ib
     LEFT JOIN companies c ON c.id = ib.company_id
     LEFT JOIN users u ON u.id = ib.created_by`;
  if (companyId) {
    return db.prepare(`${base} WHERE ib.company_id = ? ORDER BY ib.created_at DESC`).all(companyId) as any;
  }
  return db.prepare(`${base} ORDER BY ib.created_at DESC`).all() as any;
}

export function saveImportMapping(batchId: string, input: {
  confirmedType: ImportFileType;
  mapping: Record<string, string>;
}): ImportBatch | undefined {
  db.prepare(
    `UPDATE import_batches
       SET confirmed_type = ?, mapping_json = ?, status = 'MAPPED', updated_at = datetime('now')
     WHERE id = ?`
  ).run(input.confirmedType, JSON.stringify(input.mapping), batchId);
  return getImportBatch(batchId);
}

/** Persist the result of a commit attempt (quality, source/imported totals, recon, final status). */
export function saveImportResult(batchId: string, input: {
  status: ImportStatus;
  qualityScore: number;
  qualityJson: unknown;
  totalRows: number;
  sourceTotalDebit: number;
  sourceTotalCredit: number;
  importedTotalDebit: number;
  importedTotalCredit: number;
  reconDifference: number;
}): ImportBatch | undefined {
  db.prepare(
    `UPDATE import_batches SET
       status = ?, quality_score = ?, quality_json = ?, total_rows = ?,
       source_total_debit = ?, source_total_credit = ?,
       imported_total_debit = ?, imported_total_credit = ?,
       recon_difference = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.status,
    input.qualityScore,
    JSON.stringify(input.qualityJson),
    input.totalRows,
    input.sourceTotalDebit,
    input.sourceTotalCredit,
    input.importedTotalDebit,
    input.importedTotalCredit,
    input.reconDifference,
    batchId
  );
  return getImportBatch(batchId);
}

// ---------- Committed rows (with data lineage) ----------
/** Delete any previously-imported rows for a batch (used before a re-commit). */
export function deleteImportedRows(batchId: string): void {
  db.prepare(`DELETE FROM trial_balances WHERE import_batch_id = ?`).run(batchId);
  db.prepare(`DELETE FROM general_ledger WHERE import_batch_id = ?`).run(batchId);
}

export function insertTrialBalanceRows(
  batch: { id: string; company_id: string; fiscal_year_id: string | null; file_name: string; sheet_name: string | null },
  rows: {
    accountCode: string; accountName: string | null;
    openingBalance: number; debit: number; credit: number; closingBalance: number;
    sourceRow: number;
  }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO trial_balances
       (id, import_batch_id, company_id, fiscal_year_id, account_code, account_name,
        opening_balance, debit, credit, closing_balance, source_file, source_sheet, source_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(
      id(), batch.id, batch.company_id, batch.fiscal_year_id,
      r.accountCode, r.accountName, r.openingBalance, r.debit, r.credit, r.closingBalance,
      batch.file_name, batch.sheet_name, r.sourceRow
    );
  }
}

export function insertGeneralLedgerRows(
  batch: { id: string; company_id: string; fiscal_year_id: string | null; file_name: string; sheet_name: string | null },
  rows: {
    entryDate: string | null; journal: string | null; accountCode: string; accountName: string | null;
    partner: string | null; reference: string | null; description: string | null;
    debit: number; credit: number; sourceRow: number;
  }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO general_ledger
       (id, import_batch_id, company_id, fiscal_year_id, entry_date, journal, account_code, account_name,
        partner, reference, description, debit, credit, source_file, source_sheet, source_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(
      id(), batch.id, batch.company_id, batch.fiscal_year_id,
      r.entryDate, r.journal, r.accountCode, r.accountName, r.partner, r.reference, r.description,
      r.debit, r.credit, batch.file_name, batch.sheet_name, r.sourceRow
    );
  }
}

export function sumTrialBalanceImported(batchId: string): { debit: number; credit: number; rows: number } {
  const row = db.prepare(
    `SELECT COALESCE(SUM(debit),0) as debit, COALESCE(SUM(credit),0) as credit, COUNT(*) as rows
     FROM trial_balances WHERE import_batch_id = ?`
  ).get(batchId) as { debit: number; credit: number; rows: number };
  return row;
}

export function sumGeneralLedgerImported(batchId: string): { debit: number; credit: number; rows: number } {
  const row = db.prepare(
    `SELECT COALESCE(SUM(debit),0) as debit, COALESCE(SUM(credit),0) as credit, COUNT(*) as rows
     FROM general_ledger WHERE import_batch_id = ?`
  ).get(batchId) as { debit: number; credit: number; rows: number };
  return row;
}

// ---------- Read models for the UI ----------
export function listTrialBalances(companyId: string): (TrialBalanceRow & { entry_count: number })[] {
  // entry_count = how many GL lines exist for the same account (drives the
  // real drill-down affordance — computed by SQL, not hardcoded).
  return db.prepare(
    `SELECT tb.*,
       (SELECT COUNT(*) FROM general_ledger gl
         WHERE gl.company_id = tb.company_id AND gl.account_code = tb.account_code) as entry_count
     FROM trial_balances tb
     WHERE tb.company_id = ?
     ORDER BY tb.account_code ASC`
  ).all(companyId) as any;
}

export function listGeneralLedgerByAccount(companyId: string, accountCode: string): GeneralLedgerRow[] {
  return db.prepare(
    `SELECT * FROM general_ledger
     WHERE company_id = ? AND account_code = ?
     ORDER BY entry_date ASC, source_row ASC`
  ).all(companyId, accountCode) as unknown as GeneralLedgerRow[];
}

export function getTrialBalanceAccount(companyId: string, accountCode: string): TrialBalanceRow | undefined {
  return db.prepare(
    `SELECT * FROM trial_balances WHERE company_id = ? AND account_code = ? LIMIT 1`
  ).get(companyId, accountCode) as unknown as TrialBalanceRow | undefined;
}

export function countImportedRows(): { tb: number; gl: number } {
  const tb = (db.prepare(`SELECT COUNT(*) as c FROM trial_balances`).get() as { c: number }).c;
  const gl = (db.prepare(`SELECT COUNT(*) as c FROM general_ledger`).get() as { c: number }).c;
  return { tb, gl };
}

// ---------- Mapping templates ----------
export function createMappingTemplate(input: {
  name: string; fileType: ImportFileType; mapping: Record<string, string>; createdBy: string | null;
}): MappingTemplate {
  const newId = id();
  db.prepare(
    `INSERT INTO mapping_templates (id, name, file_type, mapping_json, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(newId, input.name, input.fileType, JSON.stringify(input.mapping), input.createdBy);
  return db.prepare(`SELECT * FROM mapping_templates WHERE id = ?`).get(newId) as unknown as MappingTemplate;
}

export function listMappingTemplates(fileType?: ImportFileType): MappingTemplate[] {
  if (fileType) {
    return db.prepare(`SELECT * FROM mapping_templates WHERE file_type = ? ORDER BY name ASC`).all(fileType) as unknown as MappingTemplate[];
  }
  return db.prepare(`SELECT * FROM mapping_templates ORDER BY name ASC`).all() as unknown as MappingTemplate[];
}

// ============================================================
// Phase 3 — Risk assessment & analytical procedures
// ============================================================

export interface MaterialitySetting {
  id: string;
  company_id: string;
  fiscal_year_id: string | null;
  amount: number;
  basis_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountMovement {
  account_code: string;
  account_name: string | null;
  debit: number;
  credit: number;
  count: number;
}

/** Get materiality for a company (optionally a specific fiscal year, else the company-wide NULL row). */
export function getMateriality(companyId: string, fiscalYearId?: string | null): MaterialitySetting | undefined {
  if (fiscalYearId) {
    return db.prepare(`SELECT * FROM materiality_settings WHERE company_id = ? AND fiscal_year_id = ?`)
      .get(companyId, fiscalYearId) as unknown as MaterialitySetting | undefined;
  }
  return db.prepare(`SELECT * FROM materiality_settings WHERE company_id = ? AND fiscal_year_id IS NULL`)
    .get(companyId) as unknown as MaterialitySetting | undefined;
}

/** Insert or update the materiality for a (company, fiscal_year) pair. */
export function setMateriality(input: {
  companyId: string; fiscalYearId?: string | null; amount: number; basisNote?: string | null; createdBy: string | null;
}): MaterialitySetting {
  const existing = getMateriality(input.companyId, input.fiscalYearId ?? null);
  if (existing) {
    db.prepare(
      `UPDATE materiality_settings SET amount = ?, basis_note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(input.amount, input.basisNote ?? null, existing.id);
    return getMateriality(input.companyId, input.fiscalYearId ?? null)!;
  }
  const newId = id();
  db.prepare(
    `INSERT INTO materiality_settings (id, company_id, fiscal_year_id, amount, basis_note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId, input.companyId, input.fiscalYearId ?? null, input.amount, input.basisNote ?? null, input.createdBy);
  return getMateriality(input.companyId, input.fiscalYearId ?? null)!;
}

/** TB movement aggregated per account (summed across all committed batches). */
export function trialBalanceMovementByAccount(companyId: string): AccountMovement[] {
  return db.prepare(
    `SELECT account_code,
            MAX(account_name) as account_name,
            COALESCE(SUM(debit),0) as debit,
            COALESCE(SUM(credit),0) as credit,
            COUNT(*) as count
     FROM trial_balances WHERE company_id = ?
     GROUP BY account_code ORDER BY account_code`
  ).all(companyId) as unknown as AccountMovement[];
}

/** GL movement aggregated per account. */
export function generalLedgerMovementByAccount(companyId: string): AccountMovement[] {
  return db.prepare(
    `SELECT account_code,
            MAX(account_name) as account_name,
            COALESCE(SUM(debit),0) as debit,
            COALESCE(SUM(credit),0) as credit,
            COUNT(*) as count
     FROM general_ledger WHERE company_id = ?
     GROUP BY account_code ORDER BY account_code`
  ).all(companyId) as unknown as AccountMovement[];
}

/** All GL rows for a company (used for entry-level analytical procedures). */
export function listGeneralLedgerByCompany(companyId: string): GeneralLedgerRow[] {
  return db.prepare(
    `SELECT * FROM general_ledger WHERE company_id = ? ORDER BY entry_date ASC, source_row ASC`
  ).all(companyId) as unknown as GeneralLedgerRow[];
}

// ============================================================
// Phase 4 — Evidence & audit procedures
// ============================================================

export type ProcedureStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "NA";
export type ProcedureSeverity = "HIGH" | "MEDIUM" | "LOW" | "INFO" | "MANUAL";

export interface AuditProcedure {
  id: string;
  company_id: string;
  fiscal_year_id: string | null;
  risk_type: string | null;
  account_code: string | null;
  severity: ProcedureSeverity;
  title: string;
  description: string | null;
  status: ProcedureStatus;
  conclusion: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceFile {
  id: string;
  procedure_id: string;
  company_id: string;
  file_name: string;
  stored_path: string;
  file_size: number | null;
  note: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

export function createProcedure(input: {
  companyId: string; fiscalYearId?: string | null; riskType?: string | null; accountCode?: string | null;
  severity?: ProcedureSeverity; title: string; description?: string | null; createdBy: string | null;
}): AuditProcedure {
  const newId = id();
  db.prepare(
    `INSERT INTO audit_procedures
       (id, company_id, fiscal_year_id, risk_type, account_code, severity, title, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId, input.companyId, input.fiscalYearId ?? null, input.riskType ?? null, input.accountCode ?? null,
    input.severity ?? "MANUAL", input.title, input.description ?? null, input.createdBy
  );
  return getProcedure(newId)!;
}

export function getProcedure(procId: string): AuditProcedure | undefined {
  return db.prepare(`SELECT * FROM audit_procedures WHERE id = ?`).get(procId) as unknown as AuditProcedure | undefined;
}

export function listProcedures(companyId: string): (AuditProcedure & { evidence_count: number; assignee_name: string | null })[] {
  return db.prepare(
    `SELECT ap.*,
       (SELECT COUNT(*) FROM evidence_files ef WHERE ef.procedure_id = ap.id) as evidence_count,
       u.name as assignee_name
     FROM audit_procedures ap
     LEFT JOIN users u ON u.id = ap.assigned_to
     WHERE ap.company_id = ?
     ORDER BY CASE ap.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 WHEN 'MANUAL' THEN 3 ELSE 4 END,
              ap.created_at ASC`
  ).all(companyId) as any;
}

/** Distinct (risk_type, account_code) pairs that already have a procedure — used to avoid duplicate auto-generation. */
export function existingProcedureKeys(companyId: string): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT risk_type, account_code FROM audit_procedures WHERE company_id = ? AND risk_type IS NOT NULL`
  ).all(companyId) as { risk_type: string | null; account_code: string | null }[];
  return new Set(rows.map((r) => `${r.risk_type}|${r.account_code ?? ""}`));
}

export function updateProcedure(procId: string, input: Partial<{
  status: ProcedureStatus; conclusion: string | null; assignedTo: string | null; title: string; description: string | null;
}>): AuditProcedure | undefined {
  const current = getProcedure(procId);
  if (!current) return undefined;
  db.prepare(
    `UPDATE audit_procedures SET status = ?, conclusion = ?, assigned_to = ?, title = ?, description = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.status ?? current.status,
    input.conclusion !== undefined ? input.conclusion : current.conclusion,
    input.assignedTo !== undefined ? input.assignedTo : current.assigned_to,
    input.title ?? current.title,
    input.description !== undefined ? input.description : current.description,
    procId
  );
  return getProcedure(procId);
}

export function procedureStatusCounts(companyId: string): Record<ProcedureStatus, number> {
  const rows = db.prepare(
    `SELECT status, COUNT(*) as c FROM audit_procedures WHERE company_id = ? GROUP BY status`
  ).all(companyId) as { status: ProcedureStatus; c: number }[];
  const out: Record<ProcedureStatus, number> = { OPEN: 0, IN_PROGRESS: 0, DONE: 0, NA: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

/** Keys (risk_type|account_code) of procedures that are resolved (DONE or NA) — used for coverage. */
export function resolvedProcedureKeys(companyId: string): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT risk_type, account_code FROM audit_procedures
     WHERE company_id = ? AND risk_type IS NOT NULL AND status IN ('DONE','NA')`
  ).all(companyId) as { risk_type: string | null; account_code: string | null }[];
  return new Set(rows.map((r) => `${r.risk_type}|${r.account_code ?? ""}`));
}

// ---------- Evidence ----------
export function addEvidence(input: {
  procedureId: string; companyId: string; fileName: string; storedPath: string; fileSize?: number | null;
  note?: string | null; uploadedBy: string | null;
}): EvidenceFile {
  const newId = id();
  db.prepare(
    `INSERT INTO evidence_files (id, procedure_id, company_id, file_name, stored_path, file_size, note, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId, input.procedureId, input.companyId, input.fileName, input.storedPath, input.fileSize ?? null, input.note ?? null, input.uploadedBy);
  return db.prepare(`SELECT * FROM evidence_files WHERE id = ?`).get(newId) as unknown as EvidenceFile;
}

export function listEvidence(procedureId: string): (EvidenceFile & { uploader_name: string | null })[] {
  return db.prepare(
    `SELECT ef.*, u.name as uploader_name FROM evidence_files ef
     LEFT JOIN users u ON u.id = ef.uploaded_by
     WHERE ef.procedure_id = ? ORDER BY ef.uploaded_at ASC`
  ).all(procedureId) as any;
}

// ============================================================
// Phase 5 — Findings, adjustments, management review
// ============================================================

export type FindingSeverity = "HIGH" | "MEDIUM" | "LOW";
export type FindingStatus = "OPEN" | "RESOLVED" | "ACCEPTED_RISK";
export type AdjustmentStatus = "PROPOSED" | "APPROVED" | "REJECTED";

export interface Finding {
  id: string; company_id: string; fiscal_year_id: string | null; procedure_id: string | null;
  account_code: string | null; title: string; description: string | null; severity: FindingSeverity;
  recommendation: string | null; management_response: string | null; status: FindingStatus;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface Adjustment {
  id: string; company_id: string; fiscal_year_id: string | null; finding_id: string | null;
  description: string; status: AdjustmentStatus; created_by: string | null; approved_by: string | null;
  created_at: string; updated_at: string;
}
export interface AdjustmentLine {
  id: string; adjustment_id: string; account_code: string; account_name: string | null; debit: number; credit: number;
}
export interface ManagementReview {
  id: string; company_id: string; fiscal_year_id: string | null; decision: "APPROVED" | "RETURNED";
  notes: string | null; reviewed_by: string | null; created_at: string;
}

// ---------- Findings ----------
export function createFinding(input: {
  companyId: string; fiscalYearId?: string | null; procedureId?: string | null; accountCode?: string | null;
  title: string; description?: string | null; severity?: FindingSeverity; recommendation?: string | null; createdBy: string | null;
}): Finding {
  const newId = id();
  db.prepare(
    `INSERT INTO findings (id, company_id, fiscal_year_id, procedure_id, account_code, title, description, severity, recommendation, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId, input.companyId, input.fiscalYearId ?? null, input.procedureId ?? null, input.accountCode ?? null,
    input.title, input.description ?? null, input.severity ?? "MEDIUM", input.recommendation ?? null, input.createdBy);
  return getFinding(newId)!;
}
export function getFinding(fid: string): Finding | undefined {
  return db.prepare(`SELECT * FROM findings WHERE id = ?`).get(fid) as unknown as Finding | undefined;
}
export function listFindings(companyId: string): (Finding & { adjustment_count: number })[] {
  return db.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM adjustments a WHERE a.finding_id = f.id) as adjustment_count
     FROM findings f WHERE f.company_id = ?
     ORDER BY CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, f.created_at ASC`
  ).all(companyId) as any;
}
export function updateFinding(fid: string, input: Partial<{
  status: FindingStatus; managementResponse: string | null; recommendation: string | null; severity: FindingSeverity; title: string; description: string | null;
}>): Finding | undefined {
  const cur = getFinding(fid);
  if (!cur) return undefined;
  db.prepare(
    `UPDATE findings SET status=?, management_response=?, recommendation=?, severity=?, title=?, description=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    input.status ?? cur.status,
    input.managementResponse !== undefined ? input.managementResponse : cur.management_response,
    input.recommendation !== undefined ? input.recommendation : cur.recommendation,
    input.severity ?? cur.severity,
    input.title ?? cur.title,
    input.description !== undefined ? input.description : cur.description,
    fid
  );
  return getFinding(fid);
}
export function findingStatusCounts(companyId: string): Record<FindingStatus, number> {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM findings WHERE company_id=? GROUP BY status`).all(companyId) as { status: FindingStatus; c: number }[];
  const out: Record<FindingStatus, number> = { OPEN: 0, RESOLVED: 0, ACCEPTED_RISK: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// ---------- Adjustments ----------
export function createAdjustment(input: {
  companyId: string; fiscalYearId?: string | null; findingId?: string | null; description: string;
  lines: { accountCode: string; accountName?: string | null; debit: number; credit: number }[]; createdBy: string | null;
}): Adjustment {
  const newId = id();
  transaction(() => {
    db.prepare(
      `INSERT INTO adjustments (id, company_id, fiscal_year_id, finding_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(newId, input.companyId, input.fiscalYearId ?? null, input.findingId ?? null, input.description, input.createdBy);
    const stmt = db.prepare(`INSERT INTO adjustment_lines (id, adjustment_id, account_code, account_name, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const l of input.lines) stmt.run(id(), newId, l.accountCode, l.accountName ?? null, l.debit, l.credit);
  });
  return getAdjustment(newId)!;
}
export function getAdjustment(aid: string): Adjustment | undefined {
  return db.prepare(`SELECT * FROM adjustments WHERE id = ?`).get(aid) as unknown as Adjustment | undefined;
}
export function listAdjustmentLines(adjustmentId: string): AdjustmentLine[] {
  return db.prepare(`SELECT * FROM adjustment_lines WHERE adjustment_id = ? ORDER BY rowid ASC`).all(adjustmentId) as unknown as AdjustmentLine[];
}
export function listAdjustments(companyId: string): (Adjustment & { total_debit: number; total_credit: number; line_count: number })[] {
  return db.prepare(
    `SELECT a.*,
       (SELECT COALESCE(SUM(debit),0) FROM adjustment_lines l WHERE l.adjustment_id=a.id) as total_debit,
       (SELECT COALESCE(SUM(credit),0) FROM adjustment_lines l WHERE l.adjustment_id=a.id) as total_credit,
       (SELECT COUNT(*) FROM adjustment_lines l WHERE l.adjustment_id=a.id) as line_count
     FROM adjustments a WHERE a.company_id=? ORDER BY a.created_at ASC`
  ).all(companyId) as any;
}
export function setAdjustmentStatus(aid: string, status: AdjustmentStatus, approvedBy: string | null): Adjustment | undefined {
  db.prepare(`UPDATE adjustments SET status=?, approved_by=?, updated_at=datetime('now') WHERE id=?`).run(status, approvedBy, aid);
  return getAdjustment(aid);
}

/** Adjusted trial balance: imported TB net + APPROVED adjustment lines, per account. */
export function adjustedTrialBalance(companyId: string): {
  account_code: string; account_name: string | null; tb_debit: number; tb_credit: number;
  adj_debit: number; adj_credit: number; adjusted_net: number;
}[] {
  return db.prepare(
    `WITH tb AS (
        SELECT account_code, MAX(account_name) account_name,
               COALESCE(SUM(debit),0) debit, COALESCE(SUM(credit),0) credit
        FROM trial_balances WHERE company_id=? GROUP BY account_code
     ),
     adj AS (
        SELECT l.account_code, MAX(l.account_name) account_name,
               COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
        FROM adjustment_lines l JOIN adjustments a ON a.id=l.adjustment_id
        WHERE a.company_id=? AND a.status='APPROVED' GROUP BY l.account_code
     )
     SELECT COALESCE(tb.account_code, adj.account_code) as account_code,
            COALESCE(tb.account_name, adj.account_name) as account_name,
            COALESCE(tb.debit,0) as tb_debit, COALESCE(tb.credit,0) as tb_credit,
            COALESCE(adj.debit,0) as adj_debit, COALESCE(adj.credit,0) as adj_credit,
            (COALESCE(tb.debit,0)-COALESCE(tb.credit,0)) + (COALESCE(adj.debit,0)-COALESCE(adj.credit,0)) as adjusted_net
     FROM tb LEFT JOIN adj ON adj.account_code=tb.account_code
     UNION
     SELECT adj.account_code, adj.account_name, COALESCE(tb.debit,0), COALESCE(tb.credit,0),
            adj.debit, adj.credit,
            (COALESCE(tb.debit,0)-COALESCE(tb.credit,0)) + (adj.debit-adj.credit)
     FROM adj LEFT JOIN tb ON tb.account_code=adj.account_code WHERE tb.account_code IS NULL
     ORDER BY account_code`
  ).all(companyId, companyId) as any;
}

export function adjustmentStatusCounts(companyId: string): Record<AdjustmentStatus, number> {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM adjustments WHERE company_id=? GROUP BY status`).all(companyId) as { status: AdjustmentStatus; c: number }[];
  const out: Record<AdjustmentStatus, number> = { PROPOSED: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// ---------- Management review ----------
export function createManagementReview(input: {
  companyId: string; fiscalYearId?: string | null; decision: "APPROVED" | "RETURNED"; notes?: string | null; reviewedBy: string | null;
}): ManagementReview {
  const newId = id();
  db.prepare(
    `INSERT INTO management_reviews (id, company_id, fiscal_year_id, decision, notes, reviewed_by) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId, input.companyId, input.fiscalYearId ?? null, input.decision, input.notes ?? null, input.reviewedBy);
  return db.prepare(`SELECT * FROM management_reviews WHERE id=?`).get(newId) as unknown as ManagementReview;
}
export function listManagementReviews(companyId: string): (ManagementReview & { reviewer_name: string | null })[] {
  return db.prepare(
    `SELECT mr.*, u.name reviewer_name FROM management_reviews mr LEFT JOIN users u ON u.id=mr.reviewed_by
     WHERE mr.company_id=? ORDER BY mr.created_at DESC`
  ).all(companyId) as any;
}
export function latestManagementReview(companyId: string): (ManagementReview & { reviewer_name: string | null }) | undefined {
  return listManagementReviews(companyId)[0];
}

// ---------- Aggregates for readiness ----------
export function committedBatchStats(companyId: string): { committed: number; blocked: number; avgQuality: number; hasTB: number; hasGL: number } {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN status='COMMITTED' THEN 1 ELSE 0 END) committed,
       SUM(CASE WHEN status='BLOCKED' THEN 1 ELSE 0 END) blocked,
       COALESCE(AVG(CASE WHEN status='COMMITTED' THEN quality_score END),0) avgQuality,
       SUM(CASE WHEN status='COMMITTED' AND confirmed_type='TRIAL_BALANCE' THEN 1 ELSE 0 END) hasTB,
       SUM(CASE WHEN status='COMMITTED' AND confirmed_type='GENERAL_LEDGER' THEN 1 ELSE 0 END) hasGL
     FROM import_batches WHERE company_id=?`
  ).get(companyId) as any;
  return {
    committed: row.committed ?? 0, blocked: row.blocked ?? 0,
    avgQuality: Math.round(row.avgQuality ?? 0), hasTB: row.hasTB ?? 0, hasGL: row.hasGL ?? 0,
  };
}
export function lastImportAt(companyId: string): string | null {
  const row = db.prepare(`SELECT MAX(created_at) as m FROM import_batches WHERE company_id = ?`).get(companyId) as { m: string | null };
  return row?.m ?? null;
}

export function proceduresWithEvidenceStats(companyId: string): { done: number; doneWithEvidence: number } {
  const done = (db.prepare(`SELECT COUNT(*) c FROM audit_procedures WHERE company_id=? AND status='DONE'`).get(companyId) as { c: number }).c;
  const doneWithEvidence = (db.prepare(
    `SELECT COUNT(*) c FROM audit_procedures ap WHERE ap.company_id=? AND ap.status='DONE'
       AND EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.procedure_id=ap.id)`
  ).get(companyId) as { c: number }).c;
  return { done, doneWithEvidence };
}

// ---------- Report signatures (Phase 12) ----------
export interface ReportSignature {
  id: string; company_id: string; content_hash: string; note: string | null;
  signed_by: string | null; signed_at: string;
}

export function createReportSignature(input: {
  companyId: string; contentHash: string; note?: string | null; signedBy: string | null;
}): ReportSignature {
  const newId = id();
  db.prepare(
    `INSERT INTO report_signatures (id, company_id, content_hash, note, signed_by) VALUES (?, ?, ?, ?, ?)`
  ).run(newId, input.companyId, input.contentHash, input.note ?? null, input.signedBy);
  return db.prepare(`SELECT * FROM report_signatures WHERE id = ?`).get(newId) as unknown as ReportSignature;
}

export function latestReportSignature(companyId: string): (ReportSignature & { signer_name: string | null }) | undefined {
  return db.prepare(
    `SELECT rs.*, u.name as signer_name FROM report_signatures rs
     LEFT JOIN users u ON u.id = rs.signed_by
     WHERE rs.company_id = ? ORDER BY rs.signed_at DESC, rs.rowid DESC LIMIT 1`
  ).get(companyId) as any;
}

export { transaction };
