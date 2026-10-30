"""GitHub Pages 用のサイト一式を作る:  python build.py [--mock]
site/index.html  … 現場アプリ(スマホ)
site/admin.html  … 管理アプリ(PC)
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

R = Path(__file__).parent
MOCK = "--mock" in sys.argv
OUT = R / ("site_mock" if MOCK else "site")
OUT.mkdir(exist_ok=True)
L = lambda p: (R / p).read_text(encoding="utf-8")
NPM = R.parent / "bi_html/npm/node_modules"
safe = lambda js: js.replace("</script", "<\\/script")
code = lambda js: f"<script>{safe(js)}</script>\n"
GIS = "" if MOCK else '<script src="https://accounts.google.com/gsi/client" async></script>\n'
SW = """<script>if('serviceWorker' in navigator && location.protocol==='https:'){navigator.serviceWorker.register('sw.js').catch(()=>{})}</script>"""


def page(title, css, scripts, theme):
    return f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="{theme}"><meta name="robots" content="noindex,nofollow">
<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-192.png">
<title>{title}</title><style>{L('src/base.css')}{L(css)}</style></head>
<body><div id="app"></div>
{GIS}<script src="config.js"></script>
{scripts}{SW}
</body></html>"""


(OUT / "index.html").write_text(page("現場スキャン", "src/field.css",
    code((NPM / "jsqr/dist/jsQR.js").read_text()) + code((NPM / "qrcode-generator/qrcode.js").read_text()) + code(L("src/common.js")) + code(L("src/field.js")), "#0b1424"), encoding="utf-8")
(OUT / "admin.html").write_text(page("受入・検査 管理画面", "src/admin.css",
    code((NPM / "qrcode-generator/qrcode.js").read_text()) + code(L("src/common.js")) + code(L("src/admin.js")), "#12264a"), encoding="utf-8")

cfg = {"mock": True, "apiBase": "", "userinfoUrl": "/oauth2/v3/userinfo", "clientId": "mock-client", "sheetId": "MOCKSHEET"} if MOCK else {}
(OUT / "config.js").write_text(
    "// 何も書かなくてよい(クライアントIDとスプレッドシートは、管理画面の最初の設定で入力する)\n"
    f"window.BI_CONFIG = {json.dumps(cfg)};\n", encoding="utf-8")
(OUT / "manifest.webmanifest").write_text(json.dumps({
    "name": "受入・検査 現場スキャン", "short_name": "現場スキャン", "start_url": "index.html", "display": "standalone",
    "background_color": "#0f1a2c", "theme_color": "#0b1424", "lang": "ja",
    "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}]},
    ensure_ascii=False), encoding="utf-8")
(OUT / "sw.js").write_text("""// 一度開けば、電波がない場所でもアプリを起動できるようにする(データの送受信は対象外)
const C = 'bi-tag-v2', FILES = ['index.html', 'admin.html', 'config.js', 'manifest.webmanifest', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // Googleとの通信は素通し
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
""", encoding="utf-8")
(OUT / ".nojekyll").write_text("")
for size in (192, 512):   # ホーム画面のアイコン
    im = Image.new("RGB", (size, size), "#12264a"); d = ImageDraw.Draw(im)
    s = size / 192
    d.rounded_rectangle([40 * s, 40 * s, 152 * s, 152 * s], radius=18 * s, outline="#ffffff", width=int(8 * s))
    d.rectangle([62 * s, 62 * s, 92 * s, 92 * s], fill="#ffffff"); d.rectangle([100 * s, 100 * s, 130 * s, 130 * s], fill="#34c472")
    d.rectangle([100 * s, 62 * s, 130 * s, 92 * s], fill="#ffffff"); d.rectangle([62 * s, 100 * s, 92 * s, 130 * s], fill="#ffffff")
    im.save(OUT / f"icon-{size}.png")
for f in sorted(OUT.iterdir()):
    print(f.name, f"{f.stat().st_size / 1000:.0f} KB")
