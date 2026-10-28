"""動作確認用の「模擬Google」: Sheets API の必要な部分とログイン情報を真似る。site_mock を配信する。
python mock_google.py [port]
- トークン "mock:<メール>" を受け付ける。ALLOWED にないメールは 403(権限なし)
"""
import json
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).parent / "site_mock"
ALLOWED = {"taiyo@example.com", "genba@example.com"}
SHEETS = {}   # title -> list of rows
LOCK = threading.Lock()
DELAY = 0.15   # 通信の遅れ(秒)


def parse_range(r):
    m = re.match(r"'?(.+?)'?!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$", unquote(r))
    t, c1, r1, c2, r2 = m.groups()
    return t, int(r1 or 1), (int(r2) if r2 else None)


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
    def log_message(self, *a): pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def auth(self):
        a = self.headers.get("Authorization", "")
        if not a.startswith("Bearer mock:"): self.send_json({"error": "unauthenticated"}, 401); return None
        em = a[len("Bearer mock:"):]
        return em

    def api(self, method):
        time.sleep(DELAY)
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/oauth2/v3/userinfo":
            em = self.auth()
            if em: self.send_json({"email": em, "name": em.split("@")[0]})
            return
        em = self.auth()
        if not em: return
        if em not in ALLOWED: return self.send_json({"error": {"code": 403, "message": "permission denied"}}, 403)
        if getattr(self.server, "offline", False): return self.send_json({"error": "offline"}, 503)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}") if method == "POST" else {}
        rest = u.path.split("/v4/spreadsheets/MOCKSHEET", 1)[1]
        with LOCK:
            if rest == "" and method == "GET":
                return self.send_json({"sheets": [{"properties": {"title": t}} for t in SHEETS]})
            if rest == ":batchUpdate":
                for r in body.get("requests", []):
                    SHEETS.setdefault(r["addSheet"]["properties"]["title"], [])
                return self.send_json({})
            if rest == "/values:batchUpdate":
                for d in body["data"]:
                    t, r1, _ = parse_range(d["range"]); rows = SHEETS.setdefault(t, [])
                    for i, v in enumerate(d["values"]):
                        while len(rows) < r1 + i: rows.append([])
                        rows[r1 - 1 + i] = [str(x) for x in v]
                return self.send_json({})
            if rest == "/values:batchGet":
                out = []
                for r in q.get("ranges", []):
                    t, r1, r2 = parse_range(r); rows = SHEETS.get(t, [])
                    out.append({"range": r, "values": rows[r1 - 1:r2]})
                return self.send_json({"valueRanges": out})
            m = re.match(r"/values/(.+?)(:append|:clear)?$", rest)
            if m:
                t, r1, r2 = parse_range(m.group(1)); rows = SHEETS.setdefault(t, [])
                if m.group(2) == ":append":
                    start = len(rows) + 1
                    for v in body["values"]: rows.append([str(x) for x in v])
                    return self.send_json({"updates": {"updatedRange": f"'{t}'!A{start}:J{len(rows)}"}})
                return self.send_json({"range": m.group(1), "values": rows[r1 - 1:r2]})
        self.send_json({"error": "unknown " + rest}, 400)

    def do_GET(self):
        if self.path.startswith("/v4/") or self.path.startswith("/oauth2/"): return self.api("GET")
        if self.path.startswith("/__dump"): return self.send_json(SHEETS)
        if self.path.startswith("/__offline"):
            self.server.offline = "on" in self.path; return self.send_json({"offline": self.server.offline})
        return super().do_GET()

    def do_POST(self):
        return self.api("POST")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    s = ThreadingHTTPServer(("0.0.0.0", port), H); s.offline = False
    print("mock google on", port); s.serve_forever()
