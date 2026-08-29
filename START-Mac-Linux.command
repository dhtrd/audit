#!/bin/bash
cd "$(dirname "$0")"
# Extra memory headroom so large Excel/ledger imports never crash the server.
export NODE_OPTIONS=--max-old-space-size=4096
echo "============================================"
echo "        PRE-AUDIT OS - تشغيل النظام"
echo "============================================"
if ! command -v node >/dev/null 2>&1; then
  echo "[تنبيه] لم يتم العثور على Node.js. ثبّته (اصدار 22+) من https://nodejs.org ثم اعد المحاولة."
  read -r -p "اضغط Enter للخروج..." _
  exit 1
fi
[ -d node_modules ] || { echo "[1/3] تجهيز المكونات لاول مرة..."; npm install; }
[ -f data/dev.db ] || { echo "[2/3] انشاء اول مدير..."; npm run db:seed; echo "  البريد: admin@company.local | كلمة المرور: ChangeMe123!"; }
echo "[3/3] بناء وتشغيل النظام..."
npm run build
( sleep 4; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) ) &
echo "النظام يعمل على: http://localhost:3000  (لايقافه: اغلق النافذة)"
npm start
