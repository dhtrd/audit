#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
منصة المراجعة الشاملة — خادم إعادة البناء (النوع الثاني / المرحلة الأولى)
Internal Audit Platform — re-platform backend (Type 2 / Phase 1).

A zero-dependency (Python standard library only) multi-user backend that adds the
security features that a single-page browser app cannot provide on its own:

  * Server-enforced user accounts with PBKDF2 password hashing.
  * Session login (random opaque tokens in an httpOnly cookie).
  * Role-Based Access Control (RBAC) — every mutating endpoint is permission-checked.
  * Append-only audit trail — every create/update/delete is recorded and there is
    NO API path that can modify or delete an audit row.
  * Segregation of Duties (SoD) — the person who raised a finding cannot close it.
  * Server-side persistence of the internal-audit entities (risks / controls /
    findings) in SQLite, scoped by engagement.

Design note: FastAPI + PostgreSQL is the documented scale-up target. This module
uses the standard library + SQLite so it keeps the project's "just run Python 3"
property while delivering the same security semantics. The HTTP/JSON contract is
framework-agnostic, so migrating the transport later does not change the model.

Run:      python3 audit_backend.py            (serves on http://localhost:8090)
Env:      MY_AUDIT_BACKEND_DB   sqlite path (default ./audit_backend.db)
          MY_AUDIT_BACKEND_PORT port (default 8090)
          MY_AUDIT_BOOTSTRAP_ADMIN=admin:password  create/reset the first admin
"""

import os
import re
import sys
import json
import time
import hmac
import base64
import hashlib
import secrets
import sqlite3
import datetime
import threading
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.cookies import SimpleCookie
import urllib.parse


class PayloadTooLarge(Exception):
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('MY_AUDIT_BACKEND_DB', os.path.join(_HERE, 'audit_backend.db'))
PORT = int(os.environ.get('MY_AUDIT_BACKEND_PORT', '8090'))
EVIDENCE_DIR = os.environ.get('MY_AUDIT_EVIDENCE_DIR', os.path.join(_HERE, 'evidence'))
BACKUP_DIR = os.environ.get('MY_AUDIT_BACKUP_DIR', os.path.join(_HERE, 'backups'))
BACKUP_KEY = os.environ.get('MY_AUDIT_BACKUP_KEY', '')  # passphrase for encrypted backups
SESSION_TTL_HOURS = 12
PBKDF2_ROUNDS = 200_000
MAX_EVIDENCE_BYTES = int(os.environ.get('MY_AUDIT_MAX_EVIDENCE', str(25 * 1024 * 1024)))
# Hard cap on any request body (base64 evidence of 25 MB is ~34 MB, so allow 40 MB).
MAX_REQUEST_BYTES = int(os.environ.get('MY_AUDIT_MAX_REQUEST', str(40 * 1024 * 1024)))
# Login brute-force throttle (per username+IP).
LOGIN_MAX_FAILS = int(os.environ.get('MY_AUDIT_LOGIN_MAX_FAILS', '5'))
LOGIN_WINDOW_SECONDS = int(os.environ.get('MY_AUDIT_LOGIN_WINDOW', '300'))
_login_fails = {}
_login_lock = threading.Lock()
# A fixed dummy hash so a login for a non-existent user costs the same PBKDF2 time
# as a real one (defeats username enumeration by timing).
_DUMMY_SALT = 'enumeration_guard_salt'
_DUMMY_HASH, _ = None, None  # filled lazily

# ----------------------------------------------------------------------------
# RBAC: role -> set of permissions. '*' means every permission.
# ----------------------------------------------------------------------------
ROLE_PERMISSIONS = {
    'admin':            {'*'},
    'internal_auditor': {'risk.read', 'risk.write', 'control.read', 'control.write',
                         'finding.read', 'finding.write', 'audit.read',
                         'evidence.read', 'evidence.write', 'pbc.fulfill', 'report.read',
                         'universe.read', 'universe.write', 'plan.read', 'plan.write',
                         'engagement.read', 'engagement.write', 'wp.read', 'wp.write',
                         'wp.review', 'data.validate'},
    'manager':          {'risk.read', 'control.read', 'finding.read', 'finding.write',
                         'finding.close', 'audit.read',
                         'evidence.read', 'pbc.fulfill', 'report.read',
                         'universe.read', 'plan.read', 'plan.write', 'engagement.read',
                         'wp.read', 'wp.review', 'wp.approve', 'data.validate'},
    'external_auditor': {'finding.read', 'control.read',
                         'evidence.read', 'pbc.request', 'pbc.review', 'report.read'},
    'viewer':           {'risk.read', 'control.read', 'finding.read', 'report.read',
                         'universe.read', 'plan.read', 'engagement.read', 'wp.read'},
}
VALID_ROLES = set(ROLE_PERMISSIONS.keys())


def has_permission(role, perm):
    perms = ROLE_PERMISSIONS.get(role, set())
    return '*' in perms or perm in perms


def now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON;')
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );
    -- Append-only: the application exposes no UPDATE/DELETE path for this table.
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        before_json TEXT,
        after_json TEXT,
        ip TEXT
    );
    CREATE TABLE IF NOT EXISTS risks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        category TEXT,
        owner TEXT,
        likelihood INTEGER NOT NULL DEFAULT 1,
        impact INTEGER NOT NULL DEFAULT 1,
        control_strength INTEGER NOT NULL DEFAULT 0,
        response TEXT,
        status TEXT,
        description TEXT,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS controls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        risk_id INTEGER,
        type TEXT,
        frequency TEXT,
        owner TEXT,
        design TEXT,
        sample_size INTEGER NOT NULL DEFAULT 0,
        exceptions INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        priority TEXT,
        owner TEXT,
        due_date TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        condition TEXT,
        criteria TEXT,
        cause TEXT,
        effect TEXT,
        recommendation TEXT,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT
    );
    -- Phase 2: tamper-evident evidence (SHA-256 of the stored bytes).
    CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        entity TEXT NOT NULL,          -- risks | controls | findings | pbc
        entity_id TEXT,
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        note TEXT,
        path TEXT NOT NULL,
        uploaded_by INTEGER,
        uploaded_by_name TEXT,
        created_at TEXT NOT NULL
    );
    -- Audit Universe: the population of auditable activities/processes.
    CREATE TABLE IF NOT EXISTS audit_universe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        department TEXT,
        description TEXT,
        risk_score INTEGER NOT NULL DEFAULT 0,
        last_reviewed TEXT,
        created_by INTEGER, created_at TEXT, updated_at TEXT
    );
    -- Annual risk-based audit plan (each row plans one activity in a period).
    CREATE TABLE IF NOT EXISTS audit_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        fiscal_year TEXT,
        activity_id INTEGER,
        quarter TEXT,
        priority TEXT,
        planned_hours INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        created_by INTEGER, created_at TEXT, updated_at TEXT
    );
    -- Audit engagements (independent audit files).
    CREATE TABLE IF NOT EXISTS engagements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        objective TEXT,
        scope TEXT,
        period_from TEXT,
        period_to TEXT,
        materiality TEXT,
        lead_auditor TEXT,
        status TEXT,
        created_by INTEGER, created_at TEXT, updated_at TEXT
    );
    -- Workpapers with a Prepared -> Reviewed -> Approved -> Locked lifecycle.
    CREATE TABLE IF NOT EXISTS workpapers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_ref INTEGER,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        objective TEXT,
        procedure TEXT,
        comments TEXT,
        status TEXT NOT NULL DEFAULT 'prepared',
        version INTEGER NOT NULL DEFAULT 1,
        prepared_by INTEGER, prepared_by_name TEXT,
        reviewed_by INTEGER, reviewed_by_name TEXT, reviewed_at TEXT,
        approved_by INTEGER, approved_by_name TEXT, approved_at TEXT,
        locked_at TEXT,
        created_by INTEGER, created_at TEXT, updated_at TEXT
    );
    -- Phase 3: Prepared-By-Client requests (external-auditor workflow).
    CREATE TABLE IF NOT EXISTS pbc_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engagement_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'requested',   -- requested|in_progress|submitted|accepted|rejected
        requested_by INTEGER,
        requested_by_name TEXT,
        assigned_to TEXT,
        due_date TEXT,
        review_note TEXT,
        created_at TEXT,
        updated_at TEXT
    );
    """)
    conn.commit()
    conn.close()


# ----------------------------------------------------------------------------
# Password hashing (PBKDF2-HMAC-SHA256) + constant-time verify
# ----------------------------------------------------------------------------
def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), PBKDF2_ROUNDS)
    return dk.hex(), salt


def verify_password(password, salt, expected_hex):
    calc, _ = hash_password(password, salt)
    return hmac.compare_digest(calc, expected_hex)


def dummy_verify():
    """Spend the same PBKDF2 time as a real verify (username-enumeration guard)."""
    hashlib.pbkdf2_hmac('sha256', b'x', _DUMMY_SALT.encode('utf-8'), PBKDF2_ROUNDS)


def login_throttled(key):
    now = time.time()
    with _login_lock:
        fails = [t for t in _login_fails.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_fails[key] = fails
        return len(fails) >= LOGIN_MAX_FAILS


def record_login_fail(key):
    now = time.time()
    with _login_lock:
        fails = [t for t in _login_fails.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
        fails.append(now)
        _login_fails[key] = fails


def clear_login_fails(key):
    with _login_lock:
        _login_fails.pop(key, None)


def create_user(conn, username, password, full_name, role):
    if role not in VALID_ROLES:
        raise ValueError('invalid role')
    pw_hash, salt = hash_password(password)
    conn.execute(
        'INSERT INTO users (username, pw_hash, salt, full_name, role, active, created_at) VALUES (?,?,?,?,?,1,?)',
        (username, pw_hash, salt, full_name or username, role, now_iso()))
    conn.commit()
    return conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()


def bootstrap_admin():
    """Create/reset the first admin from MY_AUDIT_BOOTSTRAP_ADMIN=user:pass. If no
    users exist and no spec is given, create 'admin' with a RANDOM one-time password
    printed once to the console (no weak hardcoded default)."""
    conn = get_db()
    spec = os.environ.get('MY_AUDIT_BOOTSTRAP_ADMIN', '')
    count = conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
    if spec and ':' in spec:
        u, p = spec.split(':', 1)
        row = conn.execute('SELECT id FROM users WHERE username=?', (u,)).fetchone()
        pw_hash, salt = hash_password(p)
        if row:
            conn.execute('UPDATE users SET pw_hash=?, salt=?, role=?, active=1 WHERE username=?',
                         (pw_hash, salt, 'admin', u))
        else:
            create_user(conn, u, p, 'System Administrator', 'admin')
        conn.commit()
        print('[bootstrap] admin ready: %s' % u)
    elif count == 0:
        gen = secrets.token_urlsafe(12)
        create_user(conn, 'admin', gen, 'System Administrator', 'admin')
        print('=' * 64)
        print('[bootstrap] created initial admin. ONE-TIME PASSWORD (change it now):')
        print('    username: admin')
        print('    password: %s' % gen)
        print('=' * 64)
    conn.close()


# ----------------------------------------------------------------------------
# Sessions
# ----------------------------------------------------------------------------
def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    created = datetime.datetime.utcnow()
    expires = created + datetime.timedelta(hours=SESSION_TTL_HOURS)
    conn.execute('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)',
                 (token, user_id, created.isoformat() + 'Z', expires.isoformat() + 'Z'))
    conn.commit()
    return token


def resolve_session(conn, token):
    if not token:
        return None
    row = conn.execute('SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?',
                       (token,)).fetchone()
    if not row:
        return None
    try:
        exp = datetime.datetime.fromisoformat(row['expires_at'].replace('Z', ''))
    except Exception:
        return None
    if exp < datetime.datetime.utcnow():
        conn.execute('DELETE FROM sessions WHERE token=?', (token,))
        conn.commit()
        return None
    if not row['active']:
        return None
    return row


def ensure_dirs():
    for d in (EVIDENCE_DIR, BACKUP_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass


# ----------------------------------------------------------------------------
# Encrypted backup (stdlib only): PBKDF2 key -> SHA-256 CTR keystream, encrypt-
# then-MAC with HMAC-SHA256. Authenticated and password-based.
# NOTE: this is a standard-library construction so the project stays dependency
# free. For production prefer a vetted AEAD (AES-GCM via `cryptography`) or an
# external tool (`age` / `gpg`); the on-disk format below is versioned to allow
# swapping the cipher without breaking older archives.
# ----------------------------------------------------------------------------
_BACKUP_MAGIC = b'MYAB1'


def _derive_key(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ROUNDS, dklen=64)


def _keystream(key_enc, nonce, n):
    out = bytearray()
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(key_enc + nonce + counter.to_bytes(8, 'big')).digest()
        counter += 1
    return bytes(out[:n])


def encrypt_blob(plaintext, password):
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(16)
    dk = _derive_key(password, salt)
    ke, km = dk[:32], dk[32:]
    ks = _keystream(ke, nonce, len(plaintext))
    ct = bytes(a ^ b for a, b in zip(plaintext, ks))
    mac = hmac.new(km, salt + nonce + ct, hashlib.sha256).digest()
    return _BACKUP_MAGIC + salt + nonce + mac + ct


def decrypt_blob(blob, password):
    if blob[:5] != _BACKUP_MAGIC:
        raise ValueError('unrecognized backup format')
    salt, nonce, mac, ct = blob[5:21], blob[21:37], blob[37:69], blob[69:]
    dk = _derive_key(password, salt)
    ke, km = dk[:32], dk[32:]
    if not hmac.compare_digest(mac, hmac.new(km, salt + nonce + ct, hashlib.sha256).digest()):
        raise ValueError('authentication failed (wrong password or corrupted archive)')
    ks = _keystream(ke, nonce, len(ct))
    return bytes(a ^ b for a, b in zip(ct, ks))


def make_encrypted_backup(password):
    """Consistent SQLite snapshot -> encrypted archive on disk. Returns metadata."""
    ensure_dirs()
    # Consistent snapshot via the SQLite online-backup API (safe while serving).
    tmp = os.path.join(BACKUP_DIR, '.snapshot.tmp')
    src = get_db()
    dst = sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    with open(tmp, 'rb') as f:
        raw = f.read()
    os.remove(tmp)
    blob = encrypt_blob(raw, password)
    ts = datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    name = 'audit-backup-%s.enc' % ts
    path = os.path.join(BACKUP_DIR, name)
    with open(path, 'wb') as f:
        f.write(blob)
    return {'file': name, 'path': path, 'plain_size': len(raw), 'enc_size': len(blob),
            'sha256': hashlib.sha256(blob).hexdigest()}


def audit(conn, actor, action, entity, entity_id, before, after, ip):
    conn.execute(
        'INSERT INTO audit_log (ts, actor_id, actor_name, action, entity, entity_id, before_json, after_json, ip) '
        'VALUES (?,?,?,?,?,?,?,?,?)',
        (now_iso(), actor['id'] if actor else None, actor['username'] if actor else None,
         action, entity, str(entity_id) if entity_id is not None else None,
         json.dumps(before, ensure_ascii=False) if before is not None else None,
         json.dumps(after, ensure_ascii=False) if after is not None else None, ip))
    conn.commit()


# ----------------------------------------------------------------------------
# Entity helpers (generic over the three registers)
# ----------------------------------------------------------------------------
ENTITY_FIELDS = {
    'risks': ['title', 'category', 'owner', 'likelihood', 'impact', 'control_strength', 'response', 'status', 'description'],
    'controls': ['title', 'risk_id', 'type', 'frequency', 'owner', 'design', 'sample_size', 'exceptions', 'description'],
    'findings': ['title', 'priority', 'owner', 'due_date', 'progress', 'status', 'condition', 'criteria', 'cause', 'effect', 'recommendation'],
    'universe': ['title', 'department', 'description', 'risk_score', 'last_reviewed'],
    'plans': ['title', 'fiscal_year', 'activity_id', 'quarter', 'priority', 'planned_hours', 'status'],
    'engagements': ['title', 'objective', 'scope', 'period_from', 'period_to', 'materiality', 'lead_auditor', 'status'],
}
ENTITY_PERM = {'risks': 'risk', 'controls': 'control', 'findings': 'finding',
               'universe': 'universe', 'plans': 'plan', 'engagements': 'engagement'}
ENTITY_TABLE = {'risks': 'risks', 'controls': 'controls', 'findings': 'findings',
                'universe': 'audit_universe', 'plans': 'audit_plans', 'engagements': 'engagements'}


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


# ----------------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = 'MyAuditBackend/1.0'

    def log_message(self, fmt, *args):
        pass  # quiet

    # ---- helpers ----
    def _client_ip(self):
        return self.headers.get('X-Forwarded-For', self.client_address[0] if self.client_address else '')

    def _send(self, code, payload, set_cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # Hardening headers (defence in depth; HTTPS/HSTS is added by the reverse proxy).
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        if set_cookie is not None:
            self.send_header('Set-Cookie', set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length <= 0:
            return {}
        if length > MAX_REQUEST_BYTES:
            # Reject before reading, so an oversized Content-Length cannot exhaust memory.
            raise PayloadTooLarge('request body exceeds %d bytes' % MAX_REQUEST_BYTES)
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def _cookie_token(self):
        ck = SimpleCookie(self.headers.get('Cookie', ''))
        return ck['sid'].value if 'sid' in ck else None

    def _current_user(self, conn):
        return resolve_session(conn, self._cookie_token())

    # ---- routing ----
    def do_POST(self):
        self._route('POST')

    def do_GET(self):
        self._route('GET')

    def do_PUT(self):
        self._route('PUT')

    def do_DELETE(self):
        self._route('DELETE')

    def _route(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'
        conn = get_db()
        try:
            # public endpoints
            if path == '/health' and method == 'GET':
                return self._send(200, {'status': 'ok'})
            if path == '/api/auth/login' and method == 'POST':
                return self._login(conn)

            # everything else requires a session
            user = self._current_user(conn)
            if not user:
                return self._send(401, {'error': 'unauthorized', 'detail': 'login required'})

            if path == '/api/auth/logout' and method == 'POST':
                conn.execute('DELETE FROM sessions WHERE token=?', (self._cookie_token(),))
                conn.commit()
                return self._send(200, {'ok': True})
            if path == '/api/me' and method == 'GET':
                return self._send(200, {'user': self._public_user(user), 'permissions': sorted(
                    ['*'] if has_permission(user['role'], '*') else list(ROLE_PERMISSIONS.get(user['role'], set())))})
            if path == '/api/auth/register' and method == 'POST':
                return self._register(conn, user)
            if path == '/api/users' and method == 'GET':
                return self._list_users(conn, user)
            if path == '/api/audit-log' and method == 'GET':
                return self._audit_log(conn, user)

            # Phase 2 — evidence
            if path == '/api/evidence' and method == 'GET':
                return self._list_evidence(conn, user)
            if path == '/api/evidence' and method == 'POST':
                return self._upload_evidence(conn, user)
            me = re.match(r'^/api/evidence/(\d+)/download$', path)
            if me and method == 'GET':
                return self._download_evidence(conn, user, int(me.group(1)))
            me2 = re.match(r'^/api/evidence/(\d+)$', path)
            if me2 and method == 'DELETE':
                return self._delete_evidence(conn, user, int(me2.group(1)))

            # Phase 2 — audit committee report
            if path == '/api/reports/committee' and method == 'GET':
                return self._committee_report(conn, user)

            # Phase 3 — PBC (Prepared By Client)
            if path == '/api/pbc' and method == 'GET':
                return self._list_pbc(conn, user)
            if path == '/api/pbc' and method == 'POST':
                return self._create_pbc(conn, user)
            mp = re.match(r'^/api/pbc/(\d+)$', path)
            if mp and method == 'PUT':
                return self._update_pbc(conn, user, int(mp.group(1)))

            # Phase 3 — encrypted backup
            if path == '/api/backup' and method == 'POST':
                return self._backup(conn, user)

            # Workpapers (custom lifecycle) — must precede the generic matcher.
            if path == '/api/workpapers' and method == 'GET':
                return self._list_workpapers(conn, user)
            if path == '/api/workpapers' and method == 'POST':
                return self._create_workpaper(conn, user)
            mwt = re.match(r'^/api/workpapers/(\d+)/transition$', path)
            if mwt and method == 'POST':
                return self._transition_workpaper(conn, user, int(mwt.group(1)))
            mw = re.match(r'^/api/workpapers/(\d+)$', path)
            if mw and method == 'PUT':
                return self._update_workpaper(conn, user, int(mw.group(1)))
            if mw and method == 'DELETE':
                return self._delete_workpaper(conn, user, int(mw.group(1)))

            # Data-quality / validation engine
            if path == '/api/validate' and method == 'POST':
                return self._validate_data(conn, user)

            # entity collections:  /api/<entity>  and  /api/<entity>/<id>
            m = re.match(r'^/api/(risks|controls|findings|universe|plans|engagements)(?:/(\d+))?$', path)
            if m:
                entity, ent_id = m.group(1), m.group(2)
                if method == 'GET' and ent_id is None:
                    return self._list_entities(conn, user, entity)
                if method == 'POST' and ent_id is None:
                    return self._create_entity(conn, user, entity)
                if method == 'PUT' and ent_id is not None:
                    return self._update_entity(conn, user, entity, int(ent_id))
                if method == 'DELETE' and ent_id is not None:
                    return self._delete_entity(conn, user, entity, int(ent_id))

            return self._send(404, {'error': 'not_found', 'path': path})
        except PermissionError as pe:
            return self._send(403, {'error': 'forbidden', 'detail': str(pe)})
        except ValueError as ve:
            return self._send(400, {'error': 'bad_request', 'detail': str(ve)})
        except PayloadTooLarge as pl:
            return self._send(413, {'error': 'payload_too_large', 'detail': str(pl)})
        except Exception:
            # Never leak internal details to the client; log server-side instead.
            traceback.print_exc()
            return self._send(500, {'error': 'server_error'})
        finally:
            conn.close()

    # ---- auth ----
    def _public_user(self, u):
        return {'id': u['id'], 'username': u['username'], 'full_name': u['full_name'], 'role': u['role']}

    def _login(self, conn):
        data = self._body_json()
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        # Throttle on the real socket peer (not the spoofable X-Forwarded-For) plus the
        # username, so a single host cannot evade the limit by rotating XFF headers.
        peer = self.client_address[0] if self.client_address else ''
        throttle_key = peer + '|' + username
        if login_throttled(throttle_key):
            audit(conn, None, 'login.throttled', 'auth', username, None, None, self._client_ip())
            return self._send(429, {'error': 'too_many_attempts', 'detail': 'حاول مرة أخرى لاحقاً'})
        row = conn.execute('SELECT * FROM users WHERE username=? AND active=1', (username,)).fetchone()
        # Constant-ish time: run PBKDF2 even when the user does not exist.
        ok = verify_password(password, row['salt'], row['pw_hash']) if row else (dummy_verify() or False)
        if not row or not ok:
            record_login_fail(throttle_key)
            audit(conn, None, 'login.failed', 'auth', username, None, None, self._client_ip())
            return self._send(401, {'error': 'invalid_credentials'})
        clear_login_fails(throttle_key)
        token = create_session(conn, row['id'])
        audit(conn, row, 'login.success', 'auth', row['id'], None, None, self._client_ip())
        cookie = 'sid=%s; HttpOnly; Path=/; SameSite=Strict; Max-Age=%d' % (token, SESSION_TTL_HOURS * 3600)
        return self._send(200, {'user': self._public_user(row),
                                'permissions': ['*'] if has_permission(row['role'], '*') else sorted(ROLE_PERMISSIONS.get(row['role'], set()))},
                          set_cookie=cookie)

    def _register(self, conn, user):
        if not has_permission(user['role'], '*'):
            raise PermissionError('only an admin may create users')
        data = self._body_json()
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        role = (data.get('role') or 'viewer').strip()
        full_name = (data.get('full_name') or username).strip()
        if not username or not password:
            raise ValueError('username and password are required')
        if role not in VALID_ROLES:
            raise ValueError('invalid role: %s' % role)
        if conn.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
            raise ValueError('username already exists')
        newu = create_user(conn, username, password, full_name, role)
        audit(conn, user, 'user.create', 'user', newu['id'], None, self._public_user(newu), self._client_ip())
        return self._send(201, {'user': self._public_user(newu)})

    def _list_users(self, conn, user):
        if not has_permission(user['role'], '*'):
            raise PermissionError('admin only')
        rows = conn.execute('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id').fetchall()
        return self._send(200, {'users': [row_to_dict(r) for r in rows]})

    def _audit_log(self, conn, user):
        if not has_permission(user['role'], 'audit.read'):
            raise PermissionError('missing audit.read')
        rows = conn.execute('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').fetchall()
        return self._send(200, {'entries': [row_to_dict(r) for r in rows]})

    # ---- Phase 2: evidence ----
    def _upload_evidence(self, conn, user):
        if not has_permission(user['role'], 'evidence.write'):
            raise PermissionError('missing evidence.write')
        data = self._body_json()
        entity = (data.get('entity') or '').strip()
        if entity not in ('risks', 'controls', 'findings', 'pbc'):
            raise ValueError('entity must be one of risks|controls|findings|pbc')
        filename = (data.get('filename') or 'evidence.bin').strip()
        b64 = data.get('content_b64') or ''
        try:
            content = base64.b64decode(b64, validate=True)
        except Exception:
            raise ValueError('content_b64 must be valid base64')
        if not content:
            raise ValueError('empty content')
        if len(content) > MAX_EVIDENCE_BYTES:
            raise ValueError('evidence exceeds size limit')
        ensure_dirs()
        sha = hashlib.sha256(content).hexdigest()
        stored = 'ev_%s_%s.bin' % (datetime.datetime.utcnow().strftime('%Y%m%d%H%M%S'), secrets.token_hex(6))
        path = os.path.join(EVIDENCE_DIR, stored)
        with open(path, 'wb') as f:
            f.write(content)
        cur = conn.execute(
            'INSERT INTO evidence (engagement_id, entity, entity_id, filename, sha256, size, note, path, uploaded_by, uploaded_by_name, created_at) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            ('default', entity, str(data.get('entity_id') or ''), filename, sha, len(content),
             data.get('note') or '', path, user['id'], user['username'], now_iso()))
        conn.commit()
        row = conn.execute('SELECT * FROM evidence WHERE id=?', (cur.lastrowid,)).fetchone()
        meta = self._evidence_meta(row)
        audit(conn, user, 'evidence.upload', 'evidence', cur.lastrowid, None, meta, self._client_ip())
        return self._send(201, {'evidence': meta})

    def _evidence_meta(self, row):
        return {'id': row['id'], 'entity': row['entity'], 'entity_id': row['entity_id'],
                'filename': row['filename'], 'sha256': row['sha256'], 'size': row['size'],
                'note': row['note'], 'uploaded_by': row['uploaded_by_name'], 'created_at': row['created_at']}

    def _list_evidence(self, conn, user):
        if not has_permission(user['role'], 'evidence.read'):
            raise PermissionError('missing evidence.read')
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        entity = (q.get('entity', [None])[0])
        entity_id = (q.get('entity_id', [None])[0])
        sql, args = 'SELECT * FROM evidence', []
        conds = []
        if entity:
            conds.append('entity=?'); args.append(entity)
        if entity_id:
            conds.append('entity_id=?'); args.append(str(entity_id))
        if conds:
            sql += ' WHERE ' + ' AND '.join(conds)
        sql += ' ORDER BY id DESC'
        rows = conn.execute(sql, args).fetchall()
        return self._send(200, {'evidence': [self._evidence_meta(r) for r in rows]})

    def _download_evidence(self, conn, user, ev_id):
        if not has_permission(user['role'], 'evidence.read'):
            raise PermissionError('missing evidence.read')
        row = conn.execute('SELECT * FROM evidence WHERE id=?', (ev_id,)).fetchone()
        if not row:
            return self._send(404, {'error': 'not_found'})
        try:
            with open(row['path'], 'rb') as f:
                content = f.read()
        except Exception:
            return self._send(410, {'error': 'file_missing'})
        # Tamper check: recompute the hash and compare with the stored one.
        verified = hmac.compare_digest(hashlib.sha256(content).hexdigest(), row['sha256'])
        audit(conn, user, 'evidence.download', 'evidence', ev_id, None, {'verified': verified}, self._client_ip())
        return self._send(200, {'filename': row['filename'], 'sha256': row['sha256'], 'verified': verified,
                                'content_b64': base64.b64encode(content).decode('ascii')})

    def _delete_evidence(self, conn, user, ev_id):
        if not has_permission(user['role'], 'evidence.delete') and not has_permission(user['role'], '*'):
            raise PermissionError('deleting evidence requires an administrator')
        row = conn.execute('SELECT * FROM evidence WHERE id=?', (ev_id,)).fetchone()
        if not row:
            return self._send(404, {'error': 'not_found'})
        try:
            os.remove(row['path'])
        except Exception:
            pass
        conn.execute('DELETE FROM evidence WHERE id=?', (ev_id,))
        conn.commit()
        audit(conn, user, 'evidence.delete', 'evidence', ev_id, self._evidence_meta(row), None, self._client_ip())
        return self._send(200, {'ok': True})

    # ---- Phase 2: audit committee report ----
    def _committee_report(self, conn, user):
        if not has_permission(user['role'], 'report.read'):
            raise PermissionError('missing report.read')

        def band(score):
            return 'low' if score <= 4 else ('medium' if score <= 9 else ('high' if score <= 15 else 'critical'))

        risks = conn.execute('SELECT * FROM risks').fetchall()
        risk_bands = {'low': 0, 'medium': 0, 'high': 0, 'critical': 0}
        top = []
        for r in risks:
            inh = (r['likelihood'] or 1) * (r['impact'] or 1)
            risk_bands[band(inh)] += 1
            top.append({'title': r['title'], 'inherent': inh})
        top.sort(key=lambda x: -x['inherent'])

        controls = conn.execute('SELECT * FROM controls').fetchall()
        ctrl = {'effective': 0, 'partial': 0, 'ineffective': 0, 'untested': 0}
        for c in controls:
            if c['design'] in ('لا', 'No'):
                ctrl['ineffective'] += 1
            elif (c['sample_size'] or 0) <= 0:
                ctrl['untested'] += 1
            elif (c['exceptions'] or 0) == 0:
                ctrl['effective'] += 1
            elif (c['exceptions'] / c['sample_size']) <= 0.1:
                ctrl['partial'] += 1
            else:
                ctrl['ineffective'] += 1

        findings = conn.execute('SELECT * FROM findings').fetchall()
        f_status, f_priority = {}, {}
        overdue = 0
        prog_sum = 0
        today = datetime.date.today().isoformat()
        closed = ('مغلقة', 'Closed')
        for f in findings:
            f_status[f['status'] or 'غير محدد'] = f_status.get(f['status'] or 'غير محدد', 0) + 1
            f_priority[f['priority'] or 'غير محدد'] = f_priority.get(f['priority'] or 'غير محدد', 0) + 1
            prog_sum += (f['progress'] or 0)
            if f['due_date'] and f['due_date'] < today and f['status'] not in closed:
                overdue += 1
        avg_prog = round(prog_sum / len(findings), 1) if findings else 0

        pbc = conn.execute('SELECT status, COUNT(*) AS n FROM pbc_requests GROUP BY status').fetchall()
        pbc_status = {r['status']: r['n'] for r in pbc}

        report = {
            'generated_at': now_iso(),
            'risks': {'total': len(risks), 'by_band': risk_bands, 'top': top[:5]},
            'controls': {'total': len(controls), 'effectiveness': ctrl},
            'findings': {'total': len(findings), 'by_status': f_status, 'by_priority': f_priority,
                         'overdue': overdue, 'avg_progress': avg_prog},
            'pbc': {'by_status': pbc_status},
        }
        audit(conn, user, 'report.committee', 'report', None, None, None, self._client_ip())
        return self._send(200, {'report': report})

    # ---- Phase 3: PBC (Prepared By Client) ----
    def _pbc_meta(self, row):
        return row_to_dict(row)

    def _create_pbc(self, conn, user):
        if not has_permission(user['role'], 'pbc.request') and not has_permission(user['role'], '*'):
            raise PermissionError('creating a PBC request requires the external auditor')
        data = self._body_json()
        if not (data.get('title') or '').strip():
            raise ValueError('title is required')
        cur = conn.execute(
            'INSERT INTO pbc_requests (engagement_id, title, description, status, requested_by, requested_by_name, due_date, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            ('default', data['title'], data.get('description') or '', 'requested',
             user['id'], user['username'], data.get('due_date') or '', now_iso(), now_iso()))
        conn.commit()
        row = conn.execute('SELECT * FROM pbc_requests WHERE id=?', (cur.lastrowid,)).fetchone()
        audit(conn, user, 'pbc.create', 'pbc', cur.lastrowid, None, row_to_dict(row), self._client_ip())
        return self._send(201, {'pbc': row_to_dict(row)})

    def _list_pbc(self, conn, user):
        if not any(has_permission(user['role'], p) for p in ('pbc.request', 'pbc.fulfill', 'pbc.review')) \
           and not has_permission(user['role'], '*'):
            raise PermissionError('no PBC access')
        rows = conn.execute('SELECT * FROM pbc_requests ORDER BY id DESC').fetchall()
        return self._send(200, {'pbc': [row_to_dict(r) for r in rows]})

    def _update_pbc(self, conn, user, pbc_id):
        before = conn.execute('SELECT * FROM pbc_requests WHERE id=?', (pbc_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        data = self._body_json()
        new_status = data.get('status')
        VALID = ('requested', 'in_progress', 'submitted', 'accepted', 'rejected')
        if new_status and new_status not in VALID:
            raise ValueError('invalid status')
        # Fulfilment (client side) vs review (external auditor) require different perms.
        if new_status in ('in_progress', 'submitted') or 'assigned_to' in data:
            if not has_permission(user['role'], 'pbc.fulfill') and not has_permission(user['role'], '*'):
                raise PermissionError('fulfilling a PBC request requires pbc.fulfill')
        if new_status in ('accepted', 'rejected'):
            if not has_permission(user['role'], 'pbc.review') and not has_permission(user['role'], '*'):
                raise PermissionError('reviewing a PBC request requires pbc.review')
        sets, vals = [], []
        for f in ('status', 'assigned_to', 'due_date', 'review_note', 'description'):
            if f in data:
                sets.append('%s=?' % f); vals.append(data[f])
        if not sets:
            raise ValueError('no updatable fields provided')
        sets.append('updated_at=?'); vals.append(now_iso()); vals.append(pbc_id)
        conn.execute('UPDATE pbc_requests SET %s WHERE id=?' % ','.join(sets), vals)
        conn.commit()
        after = conn.execute('SELECT * FROM pbc_requests WHERE id=?', (pbc_id,)).fetchone()
        audit(conn, user, 'pbc.update', 'pbc', pbc_id, row_to_dict(before), row_to_dict(after), self._client_ip())
        return self._send(200, {'pbc': row_to_dict(after)})

    # ---- Phase 3: encrypted backup ----
    def _backup(self, conn, user):
        if not has_permission(user['role'], 'backup.run') and not has_permission(user['role'], '*'):
            raise PermissionError('running a backup requires an administrator')
        data = self._body_json()
        password = data.get('password') or BACKUP_KEY
        if not password:
            raise ValueError('a backup password is required (body.password or MY_AUDIT_BACKUP_KEY)')
        meta = make_encrypted_backup(password)
        audit(conn, user, 'backup.run', 'backup', meta['file'],
              None, {'sha256': meta['sha256'], 'enc_size': meta['enc_size']}, self._client_ip())
        return self._send(201, {'backup': meta})

    # ---- Workpapers with lifecycle (Prepared -> Reviewed -> Approved -> Locked) ----
    def _list_workpapers(self, conn, user):
        if not has_permission(user['role'], 'wp.read'):
            raise PermissionError('missing wp.read')
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        eng = q.get('engagement_ref', [None])[0]
        if eng:
            rows = conn.execute('SELECT * FROM workpapers WHERE engagement_ref=? ORDER BY id DESC', (eng,)).fetchall()
        else:
            rows = conn.execute('SELECT * FROM workpapers ORDER BY id DESC').fetchall()
        return self._send(200, {'workpapers': [row_to_dict(r) for r in rows]})

    def _create_workpaper(self, conn, user):
        if not has_permission(user['role'], 'wp.write'):
            raise PermissionError('missing wp.write')
        data = self._body_json()
        if not (data.get('title') or '').strip():
            raise ValueError('title is required')
        cur = conn.execute(
            'INSERT INTO workpapers (engagement_ref, title, objective, procedure, comments, status, version, '
            'prepared_by, prepared_by_name, created_by, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (data.get('engagement_ref'), data['title'], data.get('objective') or '', data.get('procedure') or '',
             data.get('comments') or '', 'prepared', int(data.get('version') or 1),
             user['id'], user['username'], user['id'], now_iso(), now_iso()))
        conn.commit()
        row = conn.execute('SELECT * FROM workpapers WHERE id=?', (cur.lastrowid,)).fetchone()
        audit(conn, user, 'wp.create', 'workpapers', cur.lastrowid, None, row_to_dict(row), self._client_ip())
        return self._send(201, {'workpaper': row_to_dict(row)})

    def _update_workpaper(self, conn, user, wp_id):
        if not has_permission(user['role'], 'wp.write'):
            raise PermissionError('missing wp.write')
        before = conn.execute('SELECT * FROM workpapers WHERE id=?', (wp_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        if before['status'] == 'locked' and not has_permission(user['role'], '*'):
            raise PermissionError('a locked workpaper is immutable — reopen it to create a new version')
        data = self._body_json()
        sets, vals = [], []
        for f in ('title', 'objective', 'procedure', 'comments', 'engagement_ref'):
            if f in data:
                sets.append('%s=?' % f); vals.append(data[f])
        if not sets:
            raise ValueError('no updatable fields provided')
        sets.append('updated_at=?'); vals.append(now_iso()); vals.append(wp_id)
        conn.execute('UPDATE workpapers SET %s WHERE id=?' % ','.join(sets), vals)
        conn.commit()
        after = conn.execute('SELECT * FROM workpapers WHERE id=?', (wp_id,)).fetchone()
        audit(conn, user, 'wp.update', 'workpapers', wp_id, row_to_dict(before), row_to_dict(after), self._client_ip())
        return self._send(200, {'workpaper': row_to_dict(after)})

    def _delete_workpaper(self, conn, user, wp_id):
        if not has_permission(user['role'], 'wp.write'):
            raise PermissionError('missing wp.write')
        before = conn.execute('SELECT * FROM workpapers WHERE id=?', (wp_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        if before['status'] == 'locked' and not has_permission(user['role'], '*'):
            raise PermissionError('a locked workpaper cannot be deleted')
        conn.execute('DELETE FROM workpapers WHERE id=?', (wp_id,))
        conn.commit()
        audit(conn, user, 'wp.delete', 'workpapers', wp_id, row_to_dict(before), None, self._client_ip())
        return self._send(200, {'ok': True})

    def _transition_workpaper(self, conn, user, wp_id):
        row = conn.execute('SELECT * FROM workpapers WHERE id=?', (wp_id,)).fetchone()
        if not row:
            return self._send(404, {'error': 'not_found'})
        action = (self._body_json().get('action') or '').strip()
        admin = has_permission(user['role'], '*')
        preparer = row['prepared_by']

        if action == 'review':
            if not has_permission(user['role'], 'wp.review') and not admin:
                raise PermissionError('reviewing requires wp.review')
            if row['status'] != 'prepared':
                raise ValueError('only a prepared workpaper can be reviewed')
            if preparer == user['id'] and not admin:
                raise PermissionError('segregation of duties: the preparer cannot review their own workpaper')
            conn.execute('UPDATE workpapers SET status=?, reviewed_by=?, reviewed_by_name=?, reviewed_at=?, updated_at=? WHERE id=?',
                         ('reviewed', user['id'], user['username'], now_iso(), now_iso(), wp_id))
        elif action == 'approve':
            if not has_permission(user['role'], 'wp.approve') and not admin:
                raise PermissionError('approving requires wp.approve')
            if row['status'] != 'reviewed':
                raise ValueError('only a reviewed workpaper can be approved')
            if preparer == user['id'] and not admin:
                raise PermissionError('segregation of duties: the preparer cannot approve their own workpaper')
            conn.execute('UPDATE workpapers SET status=?, approved_by=?, approved_by_name=?, approved_at=?, updated_at=? WHERE id=?',
                         ('approved', user['id'], user['username'], now_iso(), now_iso(), wp_id))
        elif action == 'lock':
            if not has_permission(user['role'], 'wp.approve') and not admin:
                raise PermissionError('locking requires wp.approve')
            if row['status'] != 'approved':
                raise ValueError('only an approved workpaper can be locked')
            conn.execute('UPDATE workpapers SET status=?, locked_at=?, updated_at=? WHERE id=?',
                         ('locked', now_iso(), now_iso(), wp_id))
        elif action == 'reopen':
            if not has_permission(user['role'], 'wp.write') and not admin:
                raise PermissionError('reopening requires wp.write')
            if row['status'] != 'locked':
                raise ValueError('only a locked workpaper is reopened into a new version')
            cur = conn.execute(
                'INSERT INTO workpapers (engagement_ref, title, objective, procedure, comments, status, version, '
                'prepared_by, prepared_by_name, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (row['engagement_ref'], row['title'], row['objective'], row['procedure'], row['comments'],
                 'prepared', (row['version'] or 1) + 1, user['id'], user['username'], user['id'], now_iso(), now_iso()))
            conn.commit()
            newrow = conn.execute('SELECT * FROM workpapers WHERE id=?', (cur.lastrowid,)).fetchone()
            audit(conn, user, 'wp.reopen', 'workpapers', cur.lastrowid, {'from_id': wp_id}, row_to_dict(newrow), self._client_ip())
            return self._send(201, {'workpaper': row_to_dict(newrow)})
        else:
            raise ValueError('action must be one of review|approve|lock|reopen')

        conn.commit()
        after = conn.execute('SELECT * FROM workpapers WHERE id=?', (wp_id,)).fetchone()
        audit(conn, user, 'wp.' + action, 'workpapers', wp_id, row_to_dict(row), row_to_dict(after), self._client_ip())
        return self._send(200, {'workpaper': row_to_dict(after)})

    # ---- Data-quality / validation engine ----
    def _validate_data(self, conn, user):
        if not has_permission(user['role'], 'data.validate'):
            raise PermissionError('missing data.validate')
        body = self._body_json()
        ds = body.get('dataset') or {}
        opts = body.get('options') or {}
        threshold = float(opts.get('manual_threshold', 10000))
        checks = []

        def num(x):
            try:
                return float(x)
            except Exception:
                return 0.0

        journals = ds.get('journal_entries') or []
        if journals:
            td = sum(num(j.get('debit')) for j in journals)
            tc = sum(num(j.get('credit')) for j in journals)
            diff = round(td - tc, 2)
            checks.append({'rule': 'trial_balance_unbalanced', 'severity': 'high' if abs(diff) > 0.01 else 'ok',
                           'count': 1 if abs(diff) > 0.01 else 0,
                           'detail': {'total_debit': round(td, 2), 'total_credit': round(tc, 2), 'difference': diff}})
            large = [j for j in journals if j.get('is_manual') and abs(num(j.get('amount'))) > threshold]
            checks.append({'rule': 'large_manual_entries', 'severity': 'medium' if large else 'ok',
                           'count': len(large), 'threshold': threshold, 'sample': large[:10]})

        invoices = ds.get('invoices') or []
        if invoices:
            seen, dups = {}, []
            for inv in invoices:
                key = (str(inv.get('vendor_id')), str(inv.get('invoice_number')))
                seen[key] = seen.get(key, 0) + 1
            dup_keys = [k for k, v in seen.items() if v > 1]
            for inv in invoices:
                if (str(inv.get('vendor_id')), str(inv.get('invoice_number'))) in dup_keys:
                    dups.append(inv)
            checks.append({'rule': 'duplicate_invoices', 'severity': 'high' if dup_keys else 'ok',
                           'count': len(dup_keys), 'sample': dups[:10]})
            no_po = [inv for inv in invoices if not inv.get('po_number')]
            checks.append({'rule': 'invoices_without_po', 'severity': 'medium' if no_po else 'ok',
                           'count': len(no_po), 'sample': no_po[:10]})

        accounts = ds.get('accounts') or []
        if accounts:
            neg = [a for a in accounts if num(a.get('balance')) < 0]
            checks.append({'rule': 'negative_balances', 'severity': 'medium' if neg else 'ok',
                           'count': len(neg), 'sample': neg[:10]})

        issues = sum(1 for c in checks if c['count'] > 0)
        audit(conn, user, 'data.validate', 'validation', None, None,
              {'rules_run': len(checks), 'rules_with_issues': issues}, self._client_ip())
        return self._send(200, {'checks': checks, 'summary': {'rules_run': len(checks), 'rules_with_issues': issues,
                                                              'passed': issues == 0}})

    # ---- entities ----
    def _list_entities(self, conn, user, entity):
        perm = ENTITY_PERM[entity] + '.read'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        table = ENTITY_TABLE[entity]
        rows = conn.execute('SELECT * FROM %s ORDER BY id DESC' % table).fetchall()
        return self._send(200, {entity: [row_to_dict(r) for r in rows]})

    def _create_entity(self, conn, user, entity):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        table = ENTITY_TABLE[entity]
        data = self._body_json()
        fields = ENTITY_FIELDS[entity]
        if not (data.get('title') or '').strip():
            raise ValueError('title is required')
        # Only insert fields actually supplied, so NOT NULL columns with a default
        # (e.g. progress, sample_size) fall back to their default when omitted.
        provided = [f for f in fields if f in data and data[f] is not None]
        cols = provided + ['created_by', 'created_at', 'updated_at']
        vals = [data[f] for f in provided] + [user['id'], now_iso(), now_iso()]
        placeholders = ','.join('?' for _ in cols)
        cur = conn.execute('INSERT INTO %s (%s) VALUES (%s)' % (table, ','.join(cols), placeholders), vals)
        conn.commit()
        row = conn.execute('SELECT * FROM %s WHERE id=?' % table, (cur.lastrowid,)).fetchone()
        audit(conn, user, ENTITY_PERM[entity] + '.create', entity, cur.lastrowid, None, row_to_dict(row), self._client_ip())
        return self._send(201, {'item': row_to_dict(row)})

    def _update_entity(self, conn, user, entity, ent_id):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        table = ENTITY_TABLE[entity]
        before = conn.execute('SELECT * FROM %s WHERE id=?' % table, (ent_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        data = self._body_json()

        # Segregation of Duties: closing a finding needs finding.close AND the closer
        # must not be the person who raised it (admin is exempt for recovery).
        if entity == 'findings' and (data.get('status') == 'مغلقة' or data.get('status') == 'Closed'):
            if before['status'] not in ('مغلقة', 'Closed'):
                if not has_permission(user['role'], 'finding.close') and not has_permission(user['role'], '*'):
                    raise PermissionError('closing a finding requires finding.close (manager/admin)')
                if before['created_by'] == user['id'] and not has_permission(user['role'], '*'):
                    raise PermissionError('segregation of duties: the person who raised a finding cannot close it')

        fields = ENTITY_FIELDS[entity]
        sets, vals = [], []
        for f in fields:
            if f in data:
                sets.append('%s=?' % f)
                vals.append(data[f])
        if not sets:
            raise ValueError('no updatable fields provided')
        sets.append('updated_at=?')
        vals.append(now_iso())
        vals.append(ent_id)
        conn.execute('UPDATE %s SET %s WHERE id=?' % (table, ','.join(sets)), vals)
        conn.commit()
        after = conn.execute('SELECT * FROM %s WHERE id=?' % table, (ent_id,)).fetchone()
        audit(conn, user, ENTITY_PERM[entity] + '.update', entity, ent_id, row_to_dict(before), row_to_dict(after), self._client_ip())
        return self._send(200, {'item': row_to_dict(after)})

    def _delete_entity(self, conn, user, entity, ent_id):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        table = ENTITY_TABLE[entity]
        before = conn.execute('SELECT * FROM %s WHERE id=?' % table, (ent_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        conn.execute('DELETE FROM %s WHERE id=?' % table, (ent_id,))
        conn.commit()
        audit(conn, user, ENTITY_PERM[entity] + '.delete', entity, ent_id, row_to_dict(before), None, self._client_ip())
        return self._send(200, {'ok': True})


def run_server():
    init_db()
    ensure_dirs()
    bootstrap_admin()
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('Internal Audit backend (Type 2 / Phase 1) on http://localhost:%d' % PORT)
    print('DB: %s' % DB_PATH)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == '__main__':
    run_server()
