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
import json
import hmac
import hashlib
import secrets
import sqlite3
import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.cookies import SimpleCookie
import urllib.parse

DB_PATH = os.environ.get('MY_AUDIT_BACKEND_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audit_backend.db'))
PORT = int(os.environ.get('MY_AUDIT_BACKEND_PORT', '8090'))
SESSION_TTL_HOURS = 12
PBKDF2_ROUNDS = 200_000

# ----------------------------------------------------------------------------
# RBAC: role -> set of permissions. '*' means every permission.
# ----------------------------------------------------------------------------
ROLE_PERMISSIONS = {
    'admin':            {'*'},
    'internal_auditor': {'risk.read', 'risk.write', 'control.read', 'control.write',
                         'finding.read', 'finding.write', 'audit.read'},
    'manager':          {'risk.read', 'control.read', 'finding.read', 'finding.write',
                         'finding.close', 'audit.read'},
    'external_auditor': {'finding.read', 'control.read'},
    'viewer':           {'risk.read', 'control.read', 'finding.read'},
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
    """Create/reset the first admin from MY_AUDIT_BOOTSTRAP_ADMIN=user:pass, or a
    default admin/admin123 if there are no users yet (developer convenience)."""
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
        create_user(conn, 'admin', 'admin123', 'System Administrator', 'admin')
        print('[bootstrap] created default admin/admin123 — change it immediately.')
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
}
ENTITY_PERM = {'risks': 'risk', 'controls': 'control', 'findings': 'finding'}


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
        if set_cookie is not None:
            self.send_header('Set-Cookie', set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length <= 0:
            return {}
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

            # entity collections:  /api/<entity>  and  /api/<entity>/<id>
            m = re.match(r'^/api/(risks|controls|findings)(?:/(\d+))?$', path)
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
        except Exception as exc:
            return self._send(500, {'error': 'server_error', 'detail': str(exc)})
        finally:
            conn.close()

    # ---- auth ----
    def _public_user(self, u):
        return {'id': u['id'], 'username': u['username'], 'full_name': u['full_name'], 'role': u['role']}

    def _login(self, conn):
        data = self._body_json()
        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        row = conn.execute('SELECT * FROM users WHERE username=? AND active=1', (username,)).fetchone()
        if not row or not verify_password(password, row['salt'], row['pw_hash']):
            audit(conn, None, 'login.failed', 'auth', username, None, None, self._client_ip())
            return self._send(401, {'error': 'invalid_credentials'})
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

    # ---- entities ----
    def _list_entities(self, conn, user, entity):
        perm = ENTITY_PERM[entity] + '.read'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        rows = conn.execute('SELECT * FROM %s ORDER BY id DESC' % entity).fetchall()
        return self._send(200, {entity: [row_to_dict(r) for r in rows]})

    def _create_entity(self, conn, user, entity):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
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
        cur = conn.execute('INSERT INTO %s (%s) VALUES (%s)' % (entity, ','.join(cols), placeholders), vals)
        conn.commit()
        row = conn.execute('SELECT * FROM %s WHERE id=?' % entity, (cur.lastrowid,)).fetchone()
        audit(conn, user, entity[:-1] + '.create', entity, cur.lastrowid, None, row_to_dict(row), self._client_ip())
        return self._send(201, {'item': row_to_dict(row)})

    def _update_entity(self, conn, user, entity, ent_id):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        before = conn.execute('SELECT * FROM %s WHERE id=?' % entity, (ent_id,)).fetchone()
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
        conn.execute('UPDATE %s SET %s WHERE id=?' % (entity, ','.join(sets)), vals)
        conn.commit()
        after = conn.execute('SELECT * FROM %s WHERE id=?' % entity, (ent_id,)).fetchone()
        audit(conn, user, entity[:-1] + '.update', entity, ent_id, row_to_dict(before), row_to_dict(after), self._client_ip())
        return self._send(200, {'item': row_to_dict(after)})

    def _delete_entity(self, conn, user, entity, ent_id):
        perm = ENTITY_PERM[entity] + '.write'
        if not has_permission(user['role'], perm):
            raise PermissionError('missing ' + perm)
        before = conn.execute('SELECT * FROM %s WHERE id=?' % entity, (ent_id,)).fetchone()
        if not before:
            return self._send(404, {'error': 'not_found'})
        conn.execute('DELETE FROM %s WHERE id=?' % entity, (ent_id,))
        conn.commit()
        audit(conn, user, entity[:-1] + '.delete', entity, ent_id, row_to_dict(before), None, self._client_ip())
        return self._send(200, {'ok': True})


def run_server():
    init_db()
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
