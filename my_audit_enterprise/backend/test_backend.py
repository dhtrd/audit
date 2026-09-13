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

    # ================= Phase 2: evidence =================
    import base64 as _b64, hashlib as _hl
    payload = 'دليل مراجعة: صورة أمر الشراء\n'.encode('utf-8')
    b64 = _b64.b64encode(payload).decode('ascii')
    sha_expected = _hl.sha256(payload).hexdigest()
    st, ev, _ = call('POST', '/api/evidence',
                     {'entity': 'findings', 'entity_id': finding_id, 'filename': 'po.txt',
                      'content_b64': b64, 'note': 'أمر الشراء'}, aud_ck)
    check(st == 201, 'internal_auditor uploads evidence (201)')
    check(ev['evidence']['sha256'] == sha_expected, 'evidence SHA-256 computed correctly')
    ev_id = ev['evidence']['id']
    st, dl, _ = call('GET', '/api/evidence/%d/download' % ev_id, None, aud_ck)
    check(st == 200 and dl['verified'] is True, 'evidence downloads and integrity is verified')
    check(_b64.b64decode(dl['content_b64']) == payload, 'downloaded bytes match original')
    # viewer cannot upload (no evidence.write) but external auditor can read
    st, body, _ = call('POST', '/api/evidence', {'entity': 'findings', 'filename': 'x', 'content_b64': b64}, view_ck)
    check(st == 403, 'viewer cannot upload evidence (403)')
    st, body, _ = call('GET', '/api/evidence', None, ext_ck)
    check(st == 200, 'external_auditor can read evidence (200)')
    # only admin may delete evidence
    st, body, _ = call('DELETE', '/api/evidence/%d' % ev_id, None, aud_ck)
    check(st == 403, 'non-admin cannot delete evidence (403)')

    # ================= Phase 2: committee report =================
    st, rep, _ = call('GET', '/api/reports/committee', None, mgr_ck)
    check(st == 200, 'manager reads the audit committee report (200)')
    check('risks' in rep['report'] and 'controls' in rep['report'] and 'findings' in rep['report'],
          'committee report aggregates risks/controls/findings')

    # ================= Phase 3: PBC workflow =================
    # external auditor requests a document
    st, pr, _ = call('POST', '/api/pbc', {'title': 'أعمار الذمم المدينة (AR Aging)', 'description': 'مطلوب للربع الرابع'}, ext_ck)
    check(st == 201, 'external_auditor creates a PBC request (201)')
    pbc_id = pr['pbc']['id']
    # internal auditor cannot review (accept), only fulfil
    st, body, _ = call('PUT', '/api/pbc/%d' % pbc_id, {'status': 'accepted'}, aud_ck)
    check(st == 403, 'internal_auditor cannot accept a PBC request (403 — review is the external auditor)')
    # internal auditor fulfils (submits)
    st, body, _ = call('PUT', '/api/pbc/%d' % pbc_id, {'status': 'submitted', 'assigned_to': 'قسم المالية'}, aud_ck)
    check(st == 200, 'internal_auditor submits the PBC request (200)')
    # external auditor accepts
    st, body, _ = call('PUT', '/api/pbc/%d' % pbc_id, {'status': 'accepted', 'review_note': 'مستلم ومطابق'}, ext_ck)
    check(st == 200, 'external_auditor accepts the PBC request (200)')
    # external auditor cannot fulfil someone else's request role-wise
    st, body, _ = call('PUT', '/api/pbc/%d' % pbc_id, {'status': 'in_progress'}, ext_ck)
    check(st == 403, 'external_auditor cannot fulfil (403 — that is the client side)')

    # ================= Phase 3: encrypted backup =================
    st, bk, _ = call('POST', '/api/backup', {'password': 'S3cretBackupKey!'}, admin_ck)
    check(st == 201, 'admin runs an encrypted backup (201)')
    check(bk['backup']['enc_size'] > bk['backup']['plain_size'] and len(bk['backup']['sha256']) == 64,
          'backup is encrypted (header/mac added) with a sha256 digest')
    # non-admin cannot back up
    st, body, _ = call('POST', '/api/backup', {'password': 'x'}, mgr_ck)
    check(st == 403, 'non-admin cannot run a backup (403)')

    # backup encryption round-trip + authentication (uses the module directly)
    try:
        import audit_backend as be
        blob = be.encrypt_blob(b'hello audit', 'pw-correct')
        check(be.decrypt_blob(blob, 'pw-correct') == b'hello audit', 'backup decrypts with the right password')
        failed = False
        try:
            be.decrypt_blob(blob, 'pw-wrong')
        except ValueError:
            failed = True
        check(failed, 'backup decryption fails (auth) with a wrong password')
    except ImportError:
        print('  (skip crypto round-trip: run from the backend directory to import the module)')

    # ================= Audit Universe + Annual Plan =================
    st, u, _ = call('POST', '/api/universe', {'title': 'دورة المشتريات', 'department': 'المالية', 'risk_score': 20}, aud_ck)
    check(st == 201, 'internal_auditor creates an audit-universe activity (201)')
    act_id = u['item']['id']
    st, body, _ = call('GET', '/api/universe', None, view_ck)
    check(st == 200 and any(x['id'] == act_id for x in body['universe']), 'viewer can read the audit universe')
    st, pl, _ = call('POST', '/api/plans', {'title': 'مراجعة المشتريات', 'fiscal_year': '2026', 'activity_id': act_id,
                                           'quarter': 'Q1', 'priority': 'عالية', 'planned_hours': 80, 'status': 'مخطط'}, aud_ck)
    check(st == 201, 'internal_auditor adds an item to the annual audit plan (201)')
    st, body, _ = call('POST', '/api/plans', {'title': 'x'}, ext_ck)
    check(st == 403, 'external_auditor cannot write to the audit plan (403)')

    # ================= Engagements + Workpaper lifecycle =================
    st, eng, _ = call('POST', '/api/engagements', {'title': 'IA-2026-003 مراجعة المشتريات', 'objective': 'فحص ضوابط الشراء',
                                                   'period_from': '2026-01-01', 'period_to': '2026-03-31', 'status': 'تخطيط',
                                                   'lead_auditor': 'auditor1'}, aud_ck)
    check(st == 201, 'internal_auditor opens an engagement (201)')
    eng_id = eng['item']['id']
    st, wp, _ = call('POST', '/api/workpapers', {'engagement_ref': eng_id, 'title': 'WP-PUR-005 اختبار 3-way match',
                                                'objective': 'التحقق من مطابقة الفاتورة/الأمر/الاستلام', 'procedure': 'عينة 25'}, aud_ck)
    check(st == 201 and wp['workpaper']['status'] == 'prepared', 'auditor prepares a workpaper (status=prepared)')
    wp_id = wp['workpaper']['id']
    # SoD: preparer cannot review own workpaper
    st, body, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'review'}, aud_ck)
    check(st == 403, 'preparer cannot review own workpaper (403 — SoD)')
    # manager reviews
    st, body, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'review'}, mgr_ck)
    check(st == 200 and body['workpaper']['status'] == 'reviewed', 'manager reviews the workpaper (status=reviewed)')
    # auditor cannot approve (no wp.approve)
    st, body, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'approve'}, aud_ck)
    check(st == 403, 'auditor cannot approve (403 — missing wp.approve)')
    # manager approves and locks
    st, body, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'approve'}, mgr_ck)
    check(st == 200 and body['workpaper']['status'] == 'approved', 'manager approves the workpaper (status=approved)')
    st, body, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'lock'}, mgr_ck)
    check(st == 200 and body['workpaper']['status'] == 'locked', 'manager locks the workpaper (status=locked)')
    # locked workpaper is immutable
    st, body, _ = call('PUT', '/api/workpapers/%d' % wp_id, {'comments': 'edit'}, aud_ck)
    check(st == 403, 'a locked workpaper cannot be edited (403)')
    # reopen creates a new version
    st, nv, _ = call('POST', '/api/workpapers/%d/transition' % wp_id, {'action': 'reopen'}, aud_ck)
    check(st == 201 and nv['workpaper']['version'] == 2 and nv['workpaper']['status'] == 'prepared',
          'reopen creates version 2 in prepared status')

    # ================= Data-quality / validation engine =================
    dataset = {
        'journal_entries': [
            {'debit': 1000, 'credit': 0}, {'debit': 0, 'credit': 900},
            {'is_manual': True, 'amount': 50000, 'debit': 50000, 'credit': 0}
        ],
        'invoices': [
            {'vendor_id': 'V1', 'invoice_number': 'INV-1', 'amount': 100, 'po_number': 'PO-1'},
            {'vendor_id': 'V1', 'invoice_number': 'INV-1', 'amount': 100, 'po_number': 'PO-1'},
            {'vendor_id': 'V2', 'invoice_number': 'INV-9', 'amount': 200, 'po_number': None}
        ],
        'accounts': [{'account_id': 'A1', 'balance': -50}, {'account_id': 'A2', 'balance': 500}]
    }
    st, v, _ = call('POST', '/api/validate', {'dataset': dataset, 'options': {'manual_threshold': 10000}}, aud_ck)
    check(st == 200, 'internal_auditor runs the validation engine (200)')
    rules = {c['rule']: c for c in v['checks']}
    check(rules['trial_balance_unbalanced']['count'] == 1, 'validation flags the unbalanced trial balance')
    check(rules['duplicate_invoices']['count'] == 1, 'validation flags the duplicate invoice')
    check(rules['invoices_without_po']['count'] == 1, 'validation flags the invoice without a PO')
    check(rules['large_manual_entries']['count'] == 1, 'validation flags the large manual entry')
    check(rules['negative_balances']['count'] == 1, 'validation flags the negative balance')
    st, body, _ = call('POST', '/api/validate', {'dataset': {}}, ext_ck)
    check(st == 403, 'external_auditor cannot run data validation (403)')

    print('\nALL %d CHECKS PASSED' % _checks)


if __name__ == '__main__':
    main()
