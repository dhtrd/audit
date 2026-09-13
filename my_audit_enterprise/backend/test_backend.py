#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end tests for the re-platform backend (auth, RBAC, SoD, audit trail).
Run against a live server:  BASE=http://localhost:8091 python3 test_backend.py
Exits non-zero on the first failed assertion."""
import os
import json
import urllib.request

BASE = os.environ.get('BASE', 'http://localhost:8091')
_checks = 0


def call(method, path, body=None, cookie=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if cookie:
        req.add_header('Cookie', cookie)
    try:
        resp = urllib.request.urlopen(req)
        raw = resp.read().decode('utf-8')
        set_cookie = resp.headers.get('Set-Cookie')
        return resp.status, (json.loads(raw) if raw else {}), set_cookie
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8')
        return e.code, (json.loads(raw) if raw else {}), None


def login(username, password):
    st, body, sc = call('POST', '/api/auth/login', {'username': username, 'password': password})
    assert st == 200, 'login %s failed: %s %s' % (username, st, body)
    token = sc.split(';')[0]  # sid=...
    return token, body


def check(cond, msg):
    global _checks
    _checks += 1
    if not cond:
        print('FAIL:', msg)
        raise SystemExit(1)
    print('  ok:', msg)


def main():
    # 1) admin login
    admin_ck, admin_info = login('admin', 'admin123')
    check(admin_info['user']['role'] == 'admin', 'admin logs in with admin role')
    check('*' in admin_info['permissions'], 'admin has wildcard permissions')

    # 2) admin creates users of each role (idempotent-ish: ignore "already exists")
    for u, role in [('auditor1', 'internal_auditor'), ('mgr1', 'manager'), ('viewer1', 'viewer'), ('ext1', 'external_auditor')]:
        st, body, _ = call('POST', '/api/auth/register',
                           {'username': u, 'password': 'pass12345', 'role': role, 'full_name': u}, admin_ck)
        check(st in (201, 400), 'register %s (%s) -> %s' % (u, role, st))

    # 3) internal auditor: create a risk and a finding
    aud_ck, _ = login('auditor1', 'pass12345')
    st, r, _ = call('POST', '/api/risks',
                    {'title': 'صرف مدفوعات دون أوامر شراء', 'category': 'تشغيلي',
                     'likelihood': 4, 'impact': 5, 'control_strength': 1, 'status': 'مفتوح'}, aud_ck)
    check(st == 201, 'internal_auditor creates a risk (201)')
    st, f, _ = call('POST', '/api/findings',
                    {'title': 'مدفوعات دون اعتماد', 'priority': 'حرجة', 'status': 'مفتوحة',
                     'condition': 'صرف دون أمر شراء'}, aud_ck)
    check(st == 201, 'internal_auditor creates a finding (201)')
    finding_id = f['item']['id']

    # 4) SoD: the auditor who raised it cannot close it (also lacks finding.close)
    st, body, _ = call('PUT', '/api/findings/%d' % finding_id, {'status': 'مغلقة'}, aud_ck)
    check(st == 403, 'auditor cannot close a finding (403 — missing finding.close / SoD)')

    # 5) viewer cannot write
    view_ck, _ = login('viewer1', 'pass12345')
    st, body, _ = call('POST', '/api/risks', {'title': 'x'}, view_ck)
    check(st == 403, 'viewer cannot create a risk (403)')
    st, body, _ = call('GET', '/api/risks', None, view_ck)
    check(st == 200, 'viewer can read risks (200)')

    # 6) external auditor: read findings only, no risks
    ext_ck, _ = login('ext1', 'pass12345')
    st, body, _ = call('GET', '/api/findings', None, ext_ck)
    check(st == 200, 'external_auditor can read findings (200)')
    st, body, _ = call('GET', '/api/risks', None, ext_ck)
    check(st == 403, 'external_auditor cannot read risks (403)')

    # 7) manager closes the finding raised by the auditor (allowed: has finding.close, different person)
    mgr_ck, _ = login('mgr1', 'pass12345')
    st, body, _ = call('PUT', '/api/findings/%d' % finding_id, {'status': 'مغلقة'}, mgr_ck)
    check(st == 200, 'manager closes another user\'s finding (200)')

    # 8) SoD again: a manager who raises a finding cannot close their own
    st, mf, _ = call('POST', '/api/findings', {'title': 'ملاحظة المدير', 'status': 'مفتوحة'}, mgr_ck)
    check(st == 201, 'manager can raise a finding (201)')
    st, body, _ = call('PUT', '/api/findings/%d' % mf['item']['id'], {'status': 'مغلقة'}, mgr_ck)
    check(st == 403, 'manager cannot close own finding (403 — segregation of duties)')

    # 9) audit trail recorded and readable by admin; contains our actions
    st, body, _ = call('GET', '/api/audit-log', None, admin_ck)
    check(st == 200, 'admin reads the audit log (200)')
    actions = set(e['action'] for e in body['entries'])
    check('login.success' in actions, 'audit log records login.success')
    check('finding.create' in actions, 'audit log records finding.create')
    check('finding.update' in actions, 'audit log records finding.update (close)')
    check('risk.create' in actions, 'audit log records risk.create')

    # 10) audit log is not writable/deletable — no such route exists
    st, body, _ = call('DELETE', '/api/audit-log', None, admin_ck)
    check(st == 404, 'no route to delete the audit log (append-only)')

    # 11) unauthenticated access is rejected
    st, body, _ = call('GET', '/api/risks', None, None)
    check(st == 401, 'unauthenticated request is rejected (401)')

    print('\nALL %d CHECKS PASSED' % _checks)


if __name__ == '__main__':
    main()
