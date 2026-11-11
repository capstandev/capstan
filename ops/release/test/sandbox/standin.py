#!/usr/bin/env python3
"""Stand-in Telegram Bot API and GitHub Releases API for the release sandbox. Listens on 127.0.0.1 only.

Every call is one JSON line in --record. Faults: --faults names a file of lines "<method> <http code> <count>"
(method: sendPhoto, sendMessage, releases_create, releases_get, asset_upload); each matching call uses one count.
Nothing here reaches the network.
"""
import argparse, json, re, threading
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

ap = argparse.ArgumentParser()
ap.add_argument("--telegram-port", type=int, required=True)
ap.add_argument("--github-port", type=int, required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--gh-token", required=True)
ap.add_argument("--record", required=True)
ap.add_argument("--faults", required=True)
a = ap.parse_args()
lock = threading.Lock()
releases = {}  # tag -> {"id", "tag", "target", "name", "assets": {name: size}}
next_id = [100]


def record(entry):
    with lock:
        with open(a.record, "a") as f:
            f.write(json.dumps(entry) + "\n")


def fault(method):
    with lock:
        try:
            lines = open(a.faults).read().splitlines()
        except FileNotFoundError:
            return None
        out, hit = [], None
        for line in lines:
            p = line.split()
            if hit is None and len(p) == 3 and p[0] == method and int(p[2]) > 0:
                hit = int(p[1])
                if int(p[2]) > 1:
                    out.append(f"{p[0]} {p[1]} {int(p[2]) - 1}")
            elif line.strip():
                out.append(line)
        open(a.faults, "w").write("\n".join(out) + ("\n" if out else ""))
        return hit


class Base(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def reply(self, code, obj=None):
        data = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Telegram(Base):
    def do_POST(self):
        m = re.match(r"^/bot([^/]+)/(sendMessage|sendPhoto)$", urlparse(self.path).path)
        raw = self.body()
        if not m:
            return self.reply(404, {"ok": False})
        token, method = m.group(1), m.group(2)
        fields, photo = {}, None
        ctype = self.headers.get("Content-Type", "")
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_default).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if part.get_filename():
                    photo = len(part.get_payload(decode=True) or b"")
                else:
                    fields[name] = part.get_content()
        else:
            fields = {k: v[0] for k, v in parse_qs(raw.decode(), keep_blank_values=True).items()}
        text = fields.get("text", fields.get("caption", ""))
        status = 401 if token != a.token else (fault(method) or 200)
        record({"api": "telegram", "method": method, "status": status, "chat": fields.get("chat_id"), "text": text, "photo": photo})
        if status == 429:
            return self.reply(429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 1}})
        if status != 200:
            return self.reply(status, {"ok": False, "error_code": status})
        self.reply(200, {"ok": True, "result": {"message_id": 1}})


class GitHub(Base):
    def auth(self):
        return self.headers.get("Authorization", "") == "Bearer " + a.gh_token

    def handle_any(self, verb):
        u = urlparse(self.path)
        raw = self.body()
        code, obj, what = 404, {"message": "Not Found"}, "unknown"
        if not self.auth():
            code, obj, what = 401, {"message": "Bad credentials"}, "auth"
        elif verb == "GET" and (m := re.match(r"^/repos/[^/]+/[^/]+/releases/tags/(.+)$", u.path)):
            what = "releases_get"
            r = releases.get(m.group(1))
            if r:
                code, obj = 200, {"id": r["id"], "tag_name": r["tag"], "assets": [{"name": k} for k in r["assets"]]}
        elif verb == "POST" and re.match(r"^/repos/[^/]+/[^/]+/releases$", u.path):
            what = "releases_create"
            req = json.loads(raw or b"{}")
            with lock:
                next_id[0] += 1
                r = {"id": next_id[0], "tag": req.get("tag_name"), "target": req.get("target_commitish"),
                     "name": req.get("name"), "draft": bool(req.get("draft")), "assets": {}}
                releases[r["tag"]] = r
            code, obj = 201, {"id": r["id"], "tag_name": r["tag"], "assets": []}
        elif verb == "DELETE" and (m := re.match(r"^/repos/[^/]+/[^/]+/releases/(\d+)$", u.path)):
            what = "releases_delete"
            for k, r in list(releases.items()):
                if r["id"] == int(m.group(1)):
                    del releases[k]
                    code, obj = 204, None
        elif verb == "POST" and (m := re.match(r"^/repos/[^/]+/[^/]+/releases/(\d+)/assets$", u.path)):
            what = "asset_upload"
            name = parse_qs(u.query).get("name", [""])[0]
            for r in releases.values():
                if r["id"] == int(m.group(1)):
                    r["assets"][name] = len(raw)
                    code, obj = 201, {"name": name, "size": len(raw)}
        f = fault(what)
        if f:
            code, obj = f, {"message": "injected"}
        rel = None
        if what in ("releases_create", "asset_upload") and code in (201,):
            rel = {k: v for k, v in (releases.get(obj.get("tag_name")) or {}).items()} if what == "releases_create" else None
        record({"api": "github", "method": what, "status": code, "path": u.path, "query": u.query,
                "release": rel, "size": len(raw)})
        self.reply(code, obj)

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_DELETE(self):
        self.handle_any("DELETE")


servers = [ThreadingHTTPServer(("127.0.0.1", a.telegram_port), Telegram),
           ThreadingHTTPServer(("127.0.0.1", a.github_port), GitHub)]
for s in servers[1:]:
    threading.Thread(target=s.serve_forever, daemon=True).start()
print(f"listening telegram {a.telegram_port} github {a.github_port}", flush=True)
servers[0].serve_forever()
