# خادم إعادة البناء — النوع الثاني (المرحلة الأولى)
## Internal Audit Platform — Re-platform Backend (Type 2 / Phase 1)

هذا الخادم ينفّذ متطلبات **النوع الثاني** التي لا يقدر عليها تطبيق الصفحة الواحدة:
مستخدمون متعددون بصلاحيات مُنفَّذة على الخادم، وسجل تدقيق غير قابل للتلاعب،
والفصل الوظيفي، وحفظ البيانات على الخادم. مكتوب **بمكتبة بايثون القياسية فقط**
(بدون أي حزم خارجية) حفاظاً على خاصية «شغّله بـ Python 3 مباشرة».

> ملاحظة معمارية: الهدف عند التوسّع هو FastAPI + PostgreSQL كما في تقرير التطوير
> (القسم الخامس). عقد الـ HTTP/JSON هنا مستقل عن الإطار، فالانتقال لاحقاً لا يغيّر
> النموذج ولا الواجهة.

---

## ما الذي ينفّذه

| الميزة (النوع الثاني) | الحالة |
|---|---|
| حسابات مستخدمين + تجزئة كلمات المرور (PBKDF2‑HMAC‑SHA256، ٢٠٠٬٠٠٠ دورة) | ✅ |
| تسجيل دخول بجلسات (رمز عشوائي في كوكي httpOnly) | ✅ |
| صلاحيات الأدوار RBAC — كل نقطة تعديل مُتحقَّق منها | ✅ |
| سجل تدقيق Append‑only (لا يوجد مسار لتعديله أو حذفه) | ✅ |
| الفصل الوظيفي SoD — من يرفع الملاحظة لا يغلقها | ✅ |
| حفظ سجل المخاطر/الضوابط/الملاحظات على الخادم (SQLite) | ✅ |
| **إدارة الأدلة** برفعها وحفظ بصمتها SHA‑256 والتحقق من سلامتها عند التنزيل | ✅ (مرحلة ٢) |
| **تقرير لجنة المراجعة** (تجميع المخاطر/الضوابط/الملاحظات/PBC) | ✅ (مرحلة ٢) |
| **بوابة المراجع الخارجي + قائمة PBC** بدورة (طلب ← تجهيز ← مراجعة) | ✅ (مرحلة ٣) |
| **النسخ الاحتياطي المشفّر** (PBKDF2 + تشفير ثم مصادقة HMAC) | ✅ (مرحلة ٣) |
| **سجل الأنشطة (Audit Universe) + الخطة السنوية** المبنية على المخاطر | ✅ |
| **ملفات المراجعة (Engagements) + دورة أوراق العمل** (إعداد←مراجعة←اعتماد←قفل) مع الإصدارات والفصل الوظيفي | ✅ |
| **محرّك جودة وتحقق البيانات** (ميزان غير متوازن، فواتير مكررة/بلا PO، قيود يدوية كبيرة، أرصدة سالبة) | ✅ |

تم إنجاز أساس إعادة البناء بكامل وحداته. يبقى للتوسّع لاحقاً: الترحيل إلى
FastAPI + PostgreSQL، وربط الواجهة الحالية (SPA) بهذه الـ API تدريجياً.

---

## التشغيل

```bash
python3 audit_backend.py          # يستمع على http://localhost:8090
```

متغيّرات البيئة:

| المتغيّر | الوصف | الافتراضي |
|---|---|---|
| `MY_AUDIT_BACKEND_DB` | مسار قاعدة SQLite | `./audit_backend.db` |
| `MY_AUDIT_BACKEND_PORT` | المنفذ | `8090` |
| `MY_AUDIT_BOOTSTRAP_ADMIN` | `user:pass` لإنشاء/تصفير أول مدير | — |
| `MY_AUDIT_EVIDENCE_DIR` | مجلد حفظ ملفات الأدلة | `./evidence` |
| `MY_AUDIT_BACKUP_DIR` | مجلد النسخ الاحتياطية المشفّرة | `./backups` |
| `MY_AUDIT_BACKUP_KEY` | كلمة سر النسخ الاحتياطي (أو تُمرَّر في الطلب) | — |
| `MY_AUDIT_MAX_REQUEST` | الحد الأقصى لحجم جسم الطلب (بايت) | `40MB` |
| `MY_AUDIT_LOGIN_MAX_FAILS` | عدد محاولات الدخول الفاشلة قبل الحظر المؤقت | `5` |
| `MY_AUDIT_LOGIN_WINDOW` | نافذة احتساب المحاولات (ثوانٍ) | `300` |

عند أول تشغيل بلا مستخدمين ودون `MY_AUDIT_BOOTSTRAP_ADMIN` يُنشأ حساب `admin`
**بكلمة سر عشوائية تُطبع مرة واحدة** في الطرفية (لا كلمة سر افتراضية ثابتة) — غيّرها فوراً.
للتحكم بالبيانات مسبقاً مرّر `MY_AUDIT_BOOTSTRAP_ADMIN=admin:كلمة_سر`.

الاختبارات الشاملة (٦٥ تحققاً: مصادقة، منع صلاحيات، فصل وظيفي، سجل تدقيق، أدلة وبصماتها، تقرير اللجنة، دورة PBC، النسخ المشفّر، سجل الأنشطة والخطة، دورة أوراق العمل، محرّك التحقق، والتحصين الأمني):

```bash
MY_AUDIT_BACKEND_DB=/tmp/t.db MY_AUDIT_BACKEND_PORT=8091 \
  MY_AUDIT_BOOTSTRAP_ADMIN=admin:admin123 MY_AUDIT_MAX_REQUEST=5000 \
  python3 audit_backend.py &
BASE=http://localhost:8091 python3 test_backend.py
```

---

## مصفوفة الصلاحيات (RBAC)

| الدور | مخاطر | ضوابط | ملاحظات | إغلاق ملاحظة | سجل التدقيق | إدارة المستخدمين |
|---|---|---|---|---|---|---|
| `admin` | كل الصلاحيات (`*`) |||||✅|
| `internal_auditor` | قراءة/كتابة | قراءة/كتابة | قراءة/كتابة | ✗ (فصل وظيفي) | قراءة | ✗ |
| `manager` | قراءة | قراءة | قراءة/كتابة | ✅ (لغير ما رفعه) | قراءة | ✗ |
| `external_auditor` | ✗ | قراءة | قراءة | ✗ | ✗ | ✗ |
| `viewer` | قراءة | قراءة | قراءة | ✗ | ✗ | ✗ |

**الفصل الوظيفي (SoD):** إغلاق الملاحظة يتطلب صلاحية `finding.close` **و** أن يكون
المُغلِق شخصاً غير الذي رفعها (المدير `admin` مُستثنى للاسترجاع فقط).

**صلاحيات المراحل ٢–٣ لكل دور:**
- `internal_auditor`: `evidence.read/write` · `pbc.fulfill` · `report.read`
- `manager`: `evidence.read` · `pbc.fulfill` · `report.read`
- `external_auditor`: `evidence.read` · `pbc.request` · `pbc.review` · `report.read`
- `viewer`: `report.read` · `universe.read` · `plan.read` · `engagement.read` · `wp.read`
- `admin`: كل ما سبق + `evidence.delete` و`backup.run`

**صلاحيات المراجعة الداخلية الموسّعة:**
- `internal_auditor`: `universe.read/write` · `plan.read/write` · `engagement.read/write` · `wp.read/write` · `wp.review` · `data.validate`
- `manager`: `universe.read` · `plan.read/write` · `engagement.read` · `wp.read` · `wp.review` · `wp.approve` · `data.validate`

---

## واجهة الـ API

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/api/auth/login` | عام | تسجيل الدخول (يضبط كوكي `sid`) |
| POST | `/api/auth/logout` | جلسة | إنهاء الجلسة |
| GET | `/api/me` | جلسة | المستخدم الحالي وصلاحياته |
| POST | `/api/auth/register` | admin | إنشاء مستخدم |
| GET | `/api/users` | admin | قائمة المستخدمين |
| GET/POST | `/api/risks` | `risk.read`/`risk.write` | قائمة/إنشاء مخاطر |
| PUT/DELETE | `/api/risks/{id}` | `risk.write` | تعديل/حذف خطر |
| GET/POST | `/api/controls` | `control.*` | الضوابط |
| PUT/DELETE | `/api/controls/{id}` | `control.write` | تعديل/حذف ضابط |
| GET/POST | `/api/findings` | `finding.*` | الملاحظات |
| PUT/DELETE | `/api/findings/{id}` | `finding.write` (+`finding.close`+SoD للإغلاق) | تعديل/حذف ملاحظة |
| GET | `/api/audit-log` | `audit.read` | آخر ٥٠٠ حدث تدقيق |
| POST | `/api/evidence` | `evidence.write` | رفع دليل (base64) + حفظ بصمته SHA‑256 |
| GET | `/api/evidence` | `evidence.read` | قائمة الأدلة (فلترة `?entity=&entity_id=`) |
| GET | `/api/evidence/{id}/download` | `evidence.read` | تنزيل الدليل مع التحقق من سلامته |
| DELETE | `/api/evidence/{id}` | admin | حذف دليل (مُقيَّد بالمدير ومُسجَّل) |
| GET | `/api/reports/committee` | `report.read` | تقرير لجنة المراجعة (تجميعي) |
| POST | `/api/pbc` | `pbc.request` | إنشاء طلب PBC (المراجع الخارجي) |
| GET | `/api/pbc` | `pbc.*` | قائمة طلبات PBC |
| PUT | `/api/pbc/{id}` | `pbc.fulfill` (تجهيز) / `pbc.review` (قبول/رفض) | تحديث حالة الطلب |
| POST | `/api/backup` | admin | نسخة احتياطية مشفّرة من القاعدة |
| GET/POST | `/api/universe` | `universe.read`/`universe.write` | سجل الأنشطة القابلة للمراجعة |
| PUT/DELETE | `/api/universe/{id}` | `universe.write` | تعديل/حذف نشاط |
| GET/POST | `/api/plans` | `plan.read`/`plan.write` | الخطة السنوية للمراجعة |
| PUT/DELETE | `/api/plans/{id}` | `plan.write` | تعديل/حذف بند خطة |
| GET/POST | `/api/engagements` | `engagement.read`/`engagement.write` | ملفات المراجعة |
| PUT/DELETE | `/api/engagements/{id}` | `engagement.write` | تعديل/حذف ملف مراجعة |
| GET/POST | `/api/workpapers` | `wp.read`/`wp.write` | أوراق العمل (فلترة `?engagement_ref=`) |
| PUT/DELETE | `/api/workpapers/{id}` | `wp.write` (يُمنع تعديل المقفلة) | تعديل/حذف ورقة عمل |
| POST | `/api/workpapers/{id}/transition` | `wp.review`/`wp.approve`/`wp.write` | نقل الحالة (review/approve/lock/reopen) |
| POST | `/api/validate` | `data.validate` | محرّك جودة وتحقق البيانات |
| GET | `/health` | عام | فحص الجاهزية |

**دورة أوراق العمل:** `prepared → reviewed → approved → locked`. المراجعة والاعتماد يشترطان **الفصل الوظيفي** (المُراجِع/المُعتمِد ≠ المُعِدّ). الورقة المقفلة غير قابلة للتعديل؛ و`reopen` يُنشئ **نسخة جديدة** (version+1) في حالة `prepared` مع بقاء المقفلة كما هي.

**محرّك التحقق:** يُرسَل `POST /api/validate` بجسم `{dataset:{journal_entries, invoices, accounts}, options:{manual_threshold}}` فيُعيد قائمة نتائج لكل قاعدة (عدد الحالات وعيّنة منها): توازن الميزان، الفواتير المكررة، الفواتير دون أمر شراء، القيود اليدوية الكبيرة، والأرصدة السالبة.

**دورة PBC:** المراجع الخارجي يُنشئ الطلب (`requested`) ← المراجع الداخلي/المالك يُجهّزه ويرفع الأدلة (`in_progress`/`submitted`) ← المراجع الخارجي يقبله أو يرفضه (`accepted`/`rejected`). كل انتقال محكوم بصلاحية مختلفة (فصل بين طرفي الطلب).

**الأدلة:** تُحفظ بايتاتها على القرص وتُحسب بصمة SHA‑256 وتُخزَّن في القاعدة؛ وعند التنزيل تُعاد البصمة وتُقارن (كشف أي تلاعب). الحذف مقصور على المدير ومُسجَّل في سجل التدقيق.

**النسخ الاحتياطي:** لقطة متسقة من قاعدة SQLite عبر واجهة النسخ الرسمية، ثم تشفير بكلمة سر عبر PBKDF2 مع «تشفير ثم مصادقة» (HMAC‑SHA256). *ملاحظة:* البناء بالمكتبة القياسية فقط؛ للإنتاج يُفضَّل AEAD معتمد (AES‑GCM عبر مكتبة `cryptography`) أو أداة خارجية (`age`/`gpg`) — والتنسيق مُرقَّم إصداراً ليسمح بتبديل الشِفرة لاحقاً.

كل عمليات الإنشاء/التعديل/الحذف تُسجَّل في `audit_log` مع (الفاعل، الوقت، الحدث،
الكيان، القيمة قبل وبعد، IP).

---

## التحصين الأمني المُطبَّق (بعد مراجعة الثغرات)
- **سقف حجم الطلب** (`MAX_REQUEST_BYTES`): يُرفض أي جسم قبل قراءته لمنع استنزاف الذاكرة (DoS) — يعيد `413`.
- **كبح محاولات الدخول**: بعد ٥ محاولات فاشلة لنفس المستخدم/الـIP خلال ٥ دقائق يُعاد `429` (منع التخمين).
- **مقاومة تعداد المستخدمين**: تُنفَّذ PBKDF2 حتى عند عدم وجود المستخدم لتساوي التوقيت.
- **عدم تسريب الأخطاء**: أخطاء الخادم تُعيد `{"error":"server_error"}` فقط وتُسجَّل داخلياً (لا تفاصيل للعميل).
- **ترويسات تحصين**: `X-Content-Type-Options`، `X-Frame-Options`، `Referrer-Policy`، `Cache-Control: no-store`.
- **لا كلمة سر افتراضية ثابتة**: المدير الأولي بكلمة سر عشوائية تُطبع مرة واحدة.
- **كوكي الجلسة**: `HttpOnly` + `SameSite=Strict` (يخفّف CSRF) + انتهاء صلاحية.

## ملاحظات أمنية للنشر
- لا تُعرِّض الخادم للعموم دون **HTTPS** (عبر بروكسي عكسي مثل Nginx/Caddy).
- غيّر مدير النظام الافتراضي، واستخدم كلمات مرور قوية.
- للنشر الحكومي/المالي: استضافة داخل المملكة (إقامة البيانات) ونسخ احتياطي مشفّر
  وامتثال PDPL — كما في القسم السابع من تقرير التطوير.

## العلاقة بالواجهة الحالية (SPA)
الواجهة الحالية تحفظ في متصفح المستخدم (IndexedDB). الانتقال يكون **تدريجياً**:
استبدال نداءات الحفظ المحلية لوحدات المخاطر/الضوابط/الملاحظات بنداءات هذه الـ API،
دون تغيير شكل الواجهة. يبقى `standalone.py` عاملاً أثناء البناء.
