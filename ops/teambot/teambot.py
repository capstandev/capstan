#!/usr/bin/env python3
# Capstan team Telegram bot ("teambot"). One long-polling service for the internal TEAM group, on the release alert
# bot. Python 3 stdlib only, no paid API, no AI answers. Runs as root from capstan-teambot.service.
#
# Serves only the team group (TELEGRAM_CHAT_ID) and the owner's private chat (OWNER_TELEGRAM_ID); everything else is
# ignored. The bot token is read from /etc/capstan-release/telegram.env and reaches curl in a config on stdin: never
# on a command line, never printed, never logged. Logs keep update id, chat id, command name and lengths only.
#
# /status reads the release runner's own status output (/opt/capstan-release/bin/status.sh) plus its schedule.tsv
# and state.tsv; /roadmap and /changelog point at get-capstan.com. /pause and /resume run the runner's pause.sh and
# unpause.sh after the owner taps Confirm.
#
# Usage: teambot run                          the service (getUpdates long poll, offset kept in /var/lib/capstan-teambot)
#        teambot check [--live]               PASS/FAIL lines for the setup (--live also asks Telegram who the bot is)
#        teambot requests [--approved]        the request queue as JSON lines
#        teambot requests --done <id> <note>  mark an approved request done and tell the group
import datetime as dt
import fcntl
import glob
import json
import os
import re
import secrets
import subprocess
import sys
import time

E = os.environ.get

# ------------------------------------------------------------------ fixed facts
SITE_DEFAULT = "https://get-capstan.com"
REPO = "https://github.com/capstandev/capstan"
RELEASES_TAG = REPO + "/releases/tag/"
EXPLORERS = {"4663": ("Robinhood Chain mainnet", "https://robinhoodchain.blockscout.com/address/"),
             "46630": ("Robinhood Chain testnet", "https://explorer.testnet.chain.robinhood.com/address/")}
CONTRACT_NAMES = (("address", "CPST token"), ("lock", "CPSTLock"), ("anchor", "CapstanReceiptAnchor"))
TOTAL_DEFAULT = 72
ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")


def links(site):
    return [("Site", site), ("Roadmap", site + "/roadmap"), ("Changelog", site + "/changelog"), ("Docs", site + "/docs"),
            ("API", "https://api.get-capstan.com/v1"), ("MCP", "https://api.get-capstan.com/mcp"), ("GitHub", REPO),
            ("Releases", REPO + "/releases")]


ONLY_OWNER = "Only the owner can do that."
NOT_RELEASED = "Update {n} is not released yet. Its poster goes public only at its release hour."
TOO_MANY = "Too many requests right now. Try again in a few minutes."
NOT_YET = "We don't have that yet."
CONFIRM_TTL = 120
MAX_TEXT = 2000
MAX_REASON = 200
MAX_REQUEST = 300

HELP = """Capstan team bot. Commands:
/status: released so far, the next update, paused or not
/roadmap: the roadmap link and the next 3 updates
/changelog: the changelog link and the last 3 released
/socials: all our links
/contracts: the CPST contracts with explorer links
/videos: the demo videos; /video N sends one (/video N phone for the phone one)
/poster N: the square poster of a released update
/mcp: where the MCP server stands
/request <what you want>: ask the owner for something new
/whoami: your Telegram id

Owner only: /pause <reason>, /resume"""

MENTION_REPLY = ("I answer commands only: /status, /roadmap, /changelog, /socials, /contracts, /videos, /poster N, "
                 "/mcp, /help.\nUse /request <what you want> to ask the owner.")


class Cfg:
    def __init__(self):
        self.telegram_env = E("TEAMBOT_TELEGRAM_ENV", "/etc/capstan-release/telegram.env")
        self.teambot_env = E("TEAMBOT_ENV", "/etc/capstan-teambot/teambot.env")
        self.known = E("TEAMBOT_KNOWN", "/etc/capstan-teambot/known.md")
        self.home = E("TEAMBOT_HOME", "/var/lib/capstan-teambot")
        self.release_home = E("TEAMBOT_RELEASE_HOME", "/var/lib/capstan-release")
        self.contracts = E("TEAMBOT_CONTRACTS", os.path.join(self.home, "contracts.json"))
        self.status_cmd = [E("TEAMBOT_STATUS_CMD", "/opt/capstan-release/bin/status.sh"), "3"]
        self.pause_cmd = E("TEAMBOT_PAUSE_CMD", "/opt/capstan-release/bin/pause.sh")
        self.resume_cmd = E("TEAMBOT_RESUME_CMD", "/opt/capstan-release/bin/unpause.sh")
        self.rr_conf = E("TEAMBOT_RR_CONF", "/etc/capstan-release/release.conf")
        self.site = E("TEAMBOT_SITE", SITE_DEFAULT).rstrip("/")
        self.api_base = E("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
        self.poll_timeout = int(E("TEAMBOT_POLL_TIMEOUT", "50"))


def read_env(path, key):
    try:
        with open(path) as f:
            for ln in f:
                if ln.startswith(key + "="):
                    return ln.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


def log(**kw):
    """Only ids, command names, counts and lengths ever reach this; never text, never secrets."""
    parts = [f"{k}={v}" for k, v in kw.items()]
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + " ".join(parts), flush=True)


def cq(s):
    """Quote a value for a curl config file."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'


def atomic_write(path, data):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def one_line(s, cap):
    return re.sub(r"\s+", " ", s or "").strip()[:cap]


# ------------------------------------------------------------------ Telegram
class Telegram:
    def __init__(self, cfg, token):
        self.cfg, self.token = cfg, token

    def call(self, method, payload=None, files=None, timeout=30):
        """JSON body (payload) or multipart (files = {field: path}, payload values sent as form strings)."""
        if not self.token:
            return {"ok": False, "description": "no token"}
        cfg = f"url = {cq(self.cfg.api_base + '/bot' + self.token + '/' + method)}\n"
        if files:
            for k, v in (payload or {}).items():
                v = v if isinstance(v, str) else json.dumps(v)
                cfg += f"form-string = {cq(k + '=' + v)}\n"
            for k, p in files.items():
                cfg += f"form = {cq(k + '=@' + p)}\n"
        else:
            cfg += 'header = "Content-Type: application/json"\n'
            cfg += f"data-binary = {cq(json.dumps(payload or {}))}\n"
        try:
            r = subprocess.run(["curl", "-sS", "-m", str(timeout), "-K", "-"], input=cfg, capture_output=True,
                               text=True, timeout=timeout + 15)
        except subprocess.TimeoutExpired:
            return {"ok": False, "description": "timeout"}
        try:
            out = json.loads(r.stdout or "{}")
            return out if isinstance(out, dict) else {"ok": False}
        except ValueError:
            return {"ok": False, "description": f"curl exit {r.returncode}"}


# ------------------------------------------------------------------ limits
class Limiter:
    def __init__(self, clock):
        self.clock, self.hits = clock, {}

    def allow(self, key, n, window):
        now = self.clock()
        h = [t for t in self.hits.get(key, []) if now - t < window]
        if len(h) >= n:
            self.hits[key] = h
            return False
        h.append(now)
        self.hits[key] = h
        return True


# ------------------------------------------------------------------ runner status
def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def tu_num(tid):
    m = re.match(r"^TU(\d+)$", tid or "")
    return int(m.group(1)) if m else None


def tu_id(n):
    return f"TU{int(n):02d}"


def epoch_iso(v):
    try:
        return dt.datetime.fromtimestamp(int(v), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OverflowError, OSError):
        return "-"


def parse_status(text):
    """Reads the text of the release runner's bin/status.sh (ops/release/bin/status.sh)."""
    s = {"ok": False, "armed": None, "paused": None, "pause_reason": "", "released": None, "total": None,
         "next_id": None, "next_slot": None, "held": [], "held_seen": False, "rows": [], "next_rows": []}
    in_next = False
    for ln in (text or "").splitlines():
        ln = ln.rstrip()
        if ln == "armed: yes" or ln == "armed: no":
            s["armed"] = ln.endswith("yes")
        m = re.match(r"^paused: (yes|no)(?: \((.*)\))?$", ln)
        if m:
            s["paused"] = m.group(1) == "yes"
            s["pause_reason"] = (m.group(2) or "").strip()
        m = re.match(r"^updates: (\d+); released (\d+);.*\bheld (\d+);", ln)
        if m:
            s["ok"], s["total"], s["released"], s["held_seen"] = True, int(m.group(1)), int(m.group(2)), True
        m = re.match(r"^\s+HELD Update (\d+): ", ln)
        if m:
            s["held"].append(tu_id(m.group(1)))
        if ln == "next:":
            in_next = True
            continue
        m = re.match(r"^\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) \(.*?\): Update (\d+), (.*)$", ln)
        if in_next and m:
            s["next_rows"].append({"id": tu_id(m.group(2)), "slot": m.group(1), "status": "pending",
                                   "name": one_line(m.group(3), 100)})
        m = re.match(r"^\s+slot \d+ \(not dated\): Update (\d+), (.*)$", ln)
        if in_next and m:
            s["next_rows"].append({"id": tu_id(m.group(1)), "slot": "-", "status": "pending",
                                   "name": one_line(m.group(2), 100)})
    if s["next_rows"]:
        s["next_id"], s["next_slot"] = s["next_rows"][0]["id"], s["next_rows"][0]["slot"]
    return s


def read_tsv(path):
    out = []
    try:
        with open(path) as f:
            for ln in f:
                if ln.startswith("#") or not ln.strip():
                    continue
                out.append(ln.rstrip("\n").split("\t"))
    except OSError:
        pass
    return out


def pause_words(raw):
    """'paused at 2026-11-20T05:00:00Z: gas check' -> ' since 05:00 UTC Fri 20 Nov: gas check'"""
    raw = one_line(raw, 300)
    m = re.match(r"^paused at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ):\s*(.*)$", raw)
    if m:
        why = re.sub(r"^owner via the team bot:\s*", "", m.group(2))
        return f" since {fmt_time(m.group(1))}" + (f": {why[:150].rstrip('.')}" if why else "")
    return f": {raw[:150].rstrip('.')}" if raw else ""


def fmt_time(iso, now=None):
    try:
        t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return str(iso)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    t = t.astimezone(dt.timezone.utc)
    out = f"{t:%H:%M} UTC {t:%a} {t.day} {t:%b}"
    if now is not None:
        mins = int((t.timestamp() - now) // 60)
        if mins > 0:
            out += f" (in {mins // 60} h {mins % 60} min)" if mins >= 60 else f" (in {mins} min)"
    return out


# ------------------------------------------------------------------ the bot
class Bot:
    def __init__(self, cfg=None, clock=time.time):
        self.cfg = cfg or Cfg()
        self.clock = clock
        self.token = read_env(self.cfg.telegram_env, "TELEGRAM_BOT_TOKEN")
        chat = read_env(self.cfg.telegram_env, "TELEGRAM_CHAT_ID")
        owner = read_env(self.cfg.teambot_env, "OWNER_TELEGRAM_ID")
        self.team = int(chat) if re.match(r"^-?\d+$", chat) else None
        self.owner = int(owner) if re.match(r"^\d+$", owner) else None
        self.tg = Telegram(self.cfg, self.token)
        self.limits = Limiter(clock)
        self.bot_id, self.bot_name = None, ""
        os.makedirs(self.cfg.home, exist_ok=True)
        self.offset_f = os.path.join(self.cfg.home, "offset")
        self.state_f = os.path.join(self.cfg.home, "state.json")
        self.req_f = os.path.join(self.cfg.home, "requests.jsonl")
        self.state = load_json(self.state_f, {})
        self.state.setdefault("pending", {})
        self.state.setdefault("file_ids", {})
        self._status_cache = (0, None)

    # ---------------- persistence
    def save_state(self):
        atomic_write(self.state_f, json.dumps(self.state, indent=1, sort_keys=True))

    def load_offset(self):
        try:
            with open(self.offset_f) as f:
                return int(f.read().strip())
        except (OSError, ValueError):
            return 0

    def save_offset(self, off):
        atomic_write(self.offset_f, f"{off}\n")

    # ---------------- sending
    def send(self, chat, text, reply_to=None, markup=None, entities=None):
        p = {"chat_id": chat, "text": text[:4000], "disable_web_page_preview": True}
        if reply_to:
            p["reply_to_message_id"] = reply_to
            p["allow_sending_without_reply"] = True
        if markup:
            p["reply_markup"] = markup
        if entities:
            p["entities"] = entities
        r = self.tg.call("sendMessage", p)
        if not r.get("ok"):
            log(event="send_failed", method="sendMessage", chat=chat)
        return r

    def edit(self, chat, msg_id, text):
        return self.tg.call("editMessageText", {"chat_id": chat, "message_id": msg_id, "text": text[:4000],
                                                 "disable_web_page_preview": True})

    def send_media(self, method, field, chat, path, caption, reply_to=None):
        try:
            st = os.stat(path)
        except OSError:
            return {"ok": False}
        key = f"{path}:{st.st_size}:{int(st.st_mtime)}"
        base = {"chat_id": str(chat), "caption": caption[:1024]}
        if reply_to:
            base["reply_to_message_id"] = str(reply_to)
            base["allow_sending_without_reply"] = "true"
        if method == "sendVideo":
            base["supports_streaming"] = "true"
        fid = self.state["file_ids"].get(key)
        if fid:
            r = self.tg.call(method, dict(base, **{field: fid}))
            if r.get("ok"):
                return r
        r = self.tg.call(method, base, files={field: path}, timeout=300)
        if r.get("ok"):
            res = r.get("result") or {}
            obj = res.get(field)
            if isinstance(obj, list) and obj:
                obj = obj[-1]
            if isinstance(obj, dict) and obj.get("file_id"):
                self.state["file_ids"][key] = obj["file_id"]
                self.save_state()
        else:
            log(event="send_failed", method=method, chat=chat)
        return r

    def me(self):
        r = self.tg.call("getMe", {})
        if r.get("ok"):
            self.bot_id = r["result"].get("id")
            self.bot_name = r["result"].get("username") or ""
        return bool(r.get("ok"))

    # ---------------- data
    def runner_env(self):
        """The runner's commands get a fixed PATH and its config file; never this process's environment."""
        return {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "RR_CONF": self.cfg.rr_conf}

    def status(self):
        t, cached = self._status_cache
        if cached and self.clock() - t < 30:
            return cached
        text = ""
        try:
            r = subprocess.run(self.cfg.status_cmd, capture_output=True, text=True, timeout=30,
                               env=self.runner_env())
            text = r.stdout
        except (OSError, subprocess.TimeoutExpired):
            pass
        s = parse_status(text)
        # The runner's own files give every row (names, slots, statuses) and are the fallback if the command fails.
        sched = read_tsv(os.path.join(self.cfg.release_home, "schedule.tsv"))
        state = {row[0]: row for row in read_tsv(os.path.join(self.cfg.release_home, "state.tsv")) if row}
        rows = []
        for row in sched:
            if len(row) < 2 or not row[0].isdigit():
                continue
            st = state.get(row[0], [])
            status = st[1] if len(st) > 1 and st[1] else "pending"
            rows.append({"id": tu_id(row[0]), "slot": epoch_iso(row[1]), "status": status,
                         "name": one_line(row[3] if len(row) > 3 else "", 100),
                         "tag": f"update-{int(row[0]):02d}" if status == "released" else ""})
        if rows:
            s["rows"] = rows
            if not s["ok"] and s["paused"] is None:
                s["paused"] = os.path.exists(os.path.join(self.cfg.release_home, "PAUSE"))
        else:
            s["rows"] = s["next_rows"]
        names = {r["id"]: r["name"] for r in s["next_rows"]}
        for row in s["rows"]:
            row["name"] = row.get("name") or names.get(row["id"], "")
            row.setdefault("tag", "")
        if s["released"] is None:
            s["released"] = sum(1 for r in s["rows"] if r["status"] == "released")
        if s["total"] is None:
            s["total"] = len(s["rows"]) or TOTAL_DEFAULT
        if s["paused"] is None:
            s["paused"] = os.path.exists(os.path.join(self.cfg.release_home, "PAUSE"))
        if not s["held_seen"]:
            s["held"] = [r["id"] for r in s["rows"] if r["status"] == "held"]
        if not s["next_id"]:
            nxt = [r for r in s["rows"] if r["status"] == "pending"]
            if nxt:
                s["next_id"], s["next_slot"] = nxt[0]["id"], nxt[0]["slot"]
        self._status_cache = (self.clock(), s)
        return s

    def label(self, row_or_id, s=None):
        row = row_or_id
        if isinstance(row_or_id, str):
            row = next((r for r in (s or {}).get("rows", []) if r["id"] == row_or_id), {"id": row_or_id, "name": ""})
        n = tu_num(row["id"])
        out = f"Update {n}" if n is not None else row["id"]
        return out + (f", {row['name']}" if row.get("name") else "")

    def released_ids(self):
        rows = read_tsv(os.path.join(self.cfg.release_home, "state.tsv"))
        return {tu_id(r[0]): {"releaseTag": f"update-{int(r[0]):02d}"} for r in rows
                if len(r) > 1 and r[0].isdigit() and r[1] == "released"}

    # ---------------- Level 1
    def c_help(self, ctx, arg):
        return HELP

    def c_whoami(self, ctx, arg):
        return f"Your Telegram id is {ctx['from_id']}."

    def c_socials(self, ctx, arg):
        out = ["Capstan links:"] + [f"{n}: {u}" for n, u in links(self.cfg.site)]
        extra = self.known_section("Socials", fallback=False)
        if extra:
            out.append(extra)
        return "\n".join(out)

    def c_contracts(self, ctx, arg):
        data = (load_json(self.cfg.contracts, {}) or {}).get("cpst") or {}
        out = []
        for chain in ("4663", "46630"):
            entry = data.get(chain)
            if not isinstance(entry, dict):
                continue
            name, explorer = EXPLORERS[chain]
            lines = [f"{name} (chain {chain}):"]
            for key, label in CONTRACT_NAMES:
                a = entry.get(key)
                if isinstance(a, str) and ADDR.match(a):
                    lines.append(f"{label}: {a}\n{explorer}{a}")
            if len(lines) > 1:
                out.append("\n".join(lines))
        if "4663" not in data:
            out.insert(0, "CPST is not deployed on Robinhood Chain mainnet yet. The addresses go here the hour it is.")
        out.append(f"Every address with its verified source: {self.cfg.site}/contracts")
        return "\n\n".join(out)

    def c_status(self, ctx, arg):
        s = self.status()
        if not s["ok"] and not s["rows"]:
            return "The release runner status could not be read right now. Try again in a few minutes."
        out = [f"Released {s['released']} of {s['total']}."]
        if s["next_id"]:
            out.append(f"Next: {self.label(s['next_id'], s)}, at {fmt_time(s['next_slot'], self.clock())}.")
        else:
            out.append("Next: nothing scheduled.")
        if s["paused"]:
            out.append("Updates are paused" + pause_words(s["pause_reason"]) + ".")
        else:
            out.append("Updates are running.")
        if s["held"]:
            out.append("Held: " + ", ".join(self.label(h, s) for h in s["held"]) +
                       ". A held update is not released; the others continue.")
        else:
            out.append("Held: none.")
        return "\n".join(out)

    def c_roadmap(self, ctx, arg):
        s = self.status()
        nxt = [r for r in s["rows"] if r["status"] == "pending"][:3]
        out = [f"Roadmap: {self.cfg.site}/roadmap"]
        if nxt:
            out.append("Next updates:")
            out += [f"{self.label(r)}: {fmt_time(r['slot'])}" for r in nxt]
        else:
            out.append("No more updates are scheduled right now.")
        if s["paused"]:
            out.append("Updates are paused right now, so these times can move.")
        return "\n".join(out)

    def c_changelog(self, ctx, arg):
        s = self.status()
        rel = [r for r in s["rows"] if r["status"] == "released"][-3:][::-1]
        out = [f"Changelog: {self.cfg.site}/changelog"]
        if rel:
            out.append("Last released:")
            for r in rel:
                line = self.label(r)
                if re.match(r"^[A-Za-z0-9._-]{1,64}$", r.get("tag") or ""):
                    line += f"\n{RELEASES_TAG}{r['tag']}"
                out.append(line)
        else:
            out.append("Nothing released yet.")
        return "\n".join(out)

    def captions(self):
        return load_json(os.path.join(self.cfg.home, "captions.json"), {}) or {}

    def c_videos(self, ctx, arg):
        caps = self.captions()
        if not caps:
            return "The demo videos are not on the server yet."
        out = ["Demo videos (recorded on a copy of mainnet, demo data labelled):"]
        for k in sorted(caps):
            out.append(f"{int(k)}. {caps[k].get('title', '')}")
        out.append("Send /video N for the desktop one, /video N phone for the phone one.")
        return "\n".join(out)

    def media_ok(self, ctx):
        return (self.limits.allow(("media", ctx["from_id"]), 5, 600) and self.limits.allow(("media", "all"), 20, 3600))

    def c_video(self, ctx, arg):
        m = re.match(r"^\s*(\d{1,2})(?:\s+(phone|desktop))?\s*$", arg or "", re.I)
        caps = self.captions()
        nums = sorted(int(k) for k in caps if k.isdigit())
        if not m or f"{int(m.group(1)):02d}" not in caps:
            if not nums:
                return "The demo videos are not on the server yet."
            return f"Send /video N with N from {nums[0]} to {nums[-1]}, for example /video {nums[0]} or /video {nums[0]} phone."
        n = f"{int(m.group(1)):02d}"
        kind = (m.group(2) or "desktop").lower()
        files = sorted(glob.glob(os.path.join(self.cfg.home, "videos", kind, f"capstan-{n}-*.mp4")))
        if not files:
            return "That video is not on the server yet."
        if not self.media_ok(ctx):
            return TOO_MANY
        cap = f"Demo ({kind}): {caps[n].get('caption', '')}"
        r = self.send_media("sendVideo", "video", ctx["chat_id"], files[0], cap, ctx["msg_id"])
        return None if r.get("ok") else "Sending the video did not work. Try again in a minute."

    def c_poster(self, ctx, arg):
        m = re.match(r"^\s*(\d{1,3})\s*$", arg or "")
        if not m or not 1 <= int(m.group(1)) <= TOTAL_DEFAULT:
            return f"Send /poster N with N from 1 to {TOTAL_DEFAULT}, for example /poster 3."
        n = int(m.group(1))
        tid = f"TU{n:02d}"
        rel = self.released_ids()
        if tid not in rel:
            return NOT_RELEASED.format(n=n)
        path = os.path.join(self.cfg.release_home, "posters", f"update-{n:02d}.png")
        if not os.path.isfile(path):
            return f"The poster for update {n} is not on the server."
        if not self.media_ok(ctx):
            return TOO_MANY
        try:
            with open(os.path.join(self.cfg.release_home, "notes", f"update-{n:02d}.txt")) as f:
                cap = f.read().strip()
        except OSError:
            cap = f"Update {n}"
        tag = rel[tid].get("releaseTag") or ""
        if re.match(r"^[A-Za-z0-9._-]{1,64}$", tag):
            cap = cap[:900] + f"\n\nGitHub: {RELEASES_TAG}{tag}"
        r = self.send_media("sendPhoto", "photo", ctx["chat_id"], path, cap, ctx["msg_id"])
        return None if r.get("ok") else "Sending the poster did not work. Try again in a minute."

    def known_section(self, word, fallback=True):
        try:
            with open(self.cfg.known) as f:
                text = f.read()
        except OSError:
            return ""
        lines, out, on = text.splitlines(), [], False
        for ln in lines:
            if ln.startswith("#"):
                if on:
                    break
                on = word.lower() in ln.lower()
                continue
            if on:
                out.append(ln)
        body = "\n".join(out).strip()
        if not body and fallback:  # no heading for it: the lines that name it
            body = "\n".join(ln.strip("-* ").strip() for ln in lines if word.lower() in ln.lower() and not ln.startswith("#"))
        return body[:1500]

    def c_mcp(self, ctx, arg):
        body = self.known_section("MCP")
        return f"MCP server:\n{body}" if body else NOT_YET

    # ---------------- Level 2
    def c_pause(self, ctx, arg):
        if not self.is_owner(ctx["from_id"]):
            return ONLY_OWNER
        reason = one_line(arg, MAX_REASON) or "planned pause"
        return self.ask_confirm(ctx, "pause", reason, f"Pause the updates?\nReason: {reason}")

    def c_resume(self, ctx, arg):
        if not self.is_owner(ctx["from_id"]):
            return ONLY_OWNER
        return self.ask_confirm(ctx, "resume", "", "Resume the updates?")

    def is_owner(self, uid):
        return self.owner is not None and uid == self.owner

    def ask_confirm(self, ctx, action, reason, text):
        tok = secrets.token_hex(6)
        kb = {"inline_keyboard": [[{"text": "Confirm", "callback_data": f"p:{tok}:y"},
                                   {"text": "Cancel", "callback_data": f"p:{tok}:n"}]]}
        r = self.send(ctx["chat_id"], text + "\nThis expires in 2 minutes.", ctx["msg_id"], kb)
        if not r.get("ok"):
            return None
        now = self.clock()
        self.state["pending"] = {k: v for k, v in self.state["pending"].items() if now - v["created"] < CONFIRM_TTL}
        self.state["pending"][tok] = {"action": action, "reason": reason, "created": now, "chat_id": ctx["chat_id"],
                                      "message_id": (r.get("result") or {}).get("message_id")}
        self.save_state()
        return None

    def run_action(self, p):
        argv = [self.cfg.pause_cmd, "owner via the team bot: " + p["reason"]] if p["action"] == "pause" else [self.cfg.resume_cmd]
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=120,
                               env=self.runner_env())
            return r.returncode
        except (OSError, subprocess.TimeoutExpired):
            return -1

    # ---------------- Level 4
    def read_requests(self):
        out = []
        try:
            with open(self.req_f) as f:
                for ln in f:
                    try:
                        out.append(json.loads(ln))
                    except ValueError:
                        pass
        except OSError:
            pass
        return out

    def write_requests(self, reqs):
        atomic_write(self.req_f, "".join(json.dumps(r, sort_keys=True) + "\n" for r in reqs))

    def req_lock(self):
        f = open(os.path.join(self.cfg.home, "requests.lock"), "a+")
        fcntl.flock(f, fcntl.LOCK_EX)
        return f

    def c_request(self, ctx, arg):
        text = one_line(arg, MAX_REQUEST)
        if len(text) < 3:
            return "Write what you want after /request, for example: /request a weekly summary post."
        if self.owner is None:
            return "Requests are not switched on yet."
        if not (self.limits.allow(("req", ctx["from_id"]), 3, 600) and self.limits.allow(("req", "all"), 20, 3600)):
            return TOO_MANY
        lk = self.req_lock()
        try:
            reqs = self.read_requests()
            rid = max([r.get("id", 0) for r in reqs] + [0]) + 1
            rec = {"id": rid, "from_id": ctx["from_id"], "from_name": ctx["from_name"], "chat_id": ctx["chat_id"],
                   "text": text, "time": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "status": "pending"}
            reqs.append(rec)
            self.write_requests(reqs)
        finally:
            lk.close()
        kb = {"inline_keyboard": [[{"text": "Approve", "callback_data": f"r:{rid}:a"},
                                   {"text": "Decline", "callback_data": f"r:{rid}:d"}]]}
        body = f"New request #{rid} from {ctx['from_name']}:\n{text}"
        r = self.send(self.owner, body, markup=kb)
        if not r.get("ok") and self.team is not None:
            tag = "Owner"
            r = self.send(self.team, f"{tag}, {body[0].lower()}{body[1:]}", markup=kb,
                          entities=[{"type": "text_mention", "offset": 0, "length": len(tag), "user": {"id": self.owner}}])
        log(event="request", id=rid, len=len(text), notified=int(bool(r.get("ok"))))
        return f"Saved as request #{rid}. The owner will look at it."

    def decide(self, rid, approve):
        lk = self.req_lock()
        try:
            reqs = self.read_requests()
            rec = next((r for r in reqs if r.get("id") == rid), None)
            if rec is None or rec.get("status") != "pending":
                return rec, False
            rec["status"] = "approved" if approve else "declined"
            rec["decided_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.write_requests(reqs)
            return rec, True
        finally:
            lk.close()

    # ---------------- dispatch
    COMMANDS = {"help": "c_help", "start": "c_help", "status": "c_status", "roadmap": "c_roadmap",
                "changelog": "c_changelog", "socials": "c_socials", "contracts": "c_contracts", "videos": "c_videos",
                "video": "c_video", "poster": "c_poster", "mcp": "c_mcp", "pause": "c_pause", "resume": "c_resume",
                "request": "c_request", "whoami": "c_whoami"}

    def allowed_chat(self, chat):
        cid, ctype = chat.get("id"), chat.get("type")
        if self.team is not None and cid == self.team:
            return True
        return ctype == "private" and self.owner is not None and cid == self.owner

    def handle_update(self, u):
        uid = u.get("update_id")
        try:
            if isinstance(u.get("callback_query"), dict):
                self.handle_callback(uid, u["callback_query"])
            elif isinstance(u.get("message"), dict):
                self.handle_message(uid, u["message"])
        except Exception as e:  # noqa: BLE001  one bad update never stops the bot
            log(update=uid, error=type(e).__name__)

    def handle_message(self, uid, m):
        chat = m.get("chat") or {}
        if not self.allowed_chat(chat):
            log(update=uid, chat=chat.get("id"), event="ignored_chat")
            return
        frm = m.get("from") or {}
        if frm.get("is_bot"):
            return
        text = m.get("text") if isinstance(m.get("text"), str) else ""
        text = text[:MAX_TEXT]
        name = one_line(" ".join(x for x in (frm.get("first_name"), frm.get("last_name")) if isinstance(x, str))
                        or frm.get("username") or "someone", 64)
        ctx = {"chat_id": chat.get("id"), "from_id": frm.get("id"), "from_name": name, "msg_id": m.get("message_id")}
        cm = re.match(r"^/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+(.*))?$", text, re.S)
        if cm:
            cmd, at, arg = cm.group(1).lower(), cm.group(2), cm.group(3) or ""
            if at and self.bot_name and at.lower() != self.bot_name.lower():
                return
            log(update=uid, chat=ctx["chat_id"], cmd=cmd if cmd in self.COMMANDS else "unknown", len=len(text))
            fn = self.COMMANDS.get(cmd)
            if fn is None:
                if at or chat.get("type") == "private":
                    self.send(ctx["chat_id"], "I don't know that command. Try /help.", ctx["msg_id"])
                return
            reply = getattr(self, fn)(ctx, arg)
            if reply:
                self.send(ctx["chat_id"], reply, ctx["msg_id"])
            return
        if not text:
            return
        mentioned = bool(self.bot_name) and f"@{self.bot_name.lower()}" in text.lower()
        rt = m.get("reply_to_message") or {}
        to_bot = self.bot_id is not None and (rt.get("from") or {}).get("id") == self.bot_id
        if (mentioned or to_bot or chat.get("type") == "private"):
            log(update=uid, chat=ctx["chat_id"], cmd="mention", len=len(text))
            if self.limits.allow(("mention", ctx["from_id"]), 2, 600) and self.limits.allow(("mention", "all"), 20, 3600):
                self.send(ctx["chat_id"], MENTION_REPLY, ctx["msg_id"])

    def handle_callback(self, uid, q):
        frm = q.get("from") or {}
        data = q.get("data") if isinstance(q.get("data"), str) else ""
        msg = q.get("message") or {}
        chat = msg.get("chat") or {}
        log(update=uid, chat=chat.get("id"), cmd="callback", len=len(data))
        qid = q.get("id")
        if not self.allowed_chat(chat):
            self.tg.call("answerCallbackQuery", {"callback_query_id": qid})
            return
        if not self.is_owner(frm.get("id")):
            self.tg.call("answerCallbackQuery", {"callback_query_id": qid, "text": ONLY_OWNER, "show_alert": True})
            return
        m = re.match(r"^(p):([0-9a-f]{12}):([yn])$|^(r):(\d{1,9}):([ad])$", data[:64])
        if not m:
            self.tg.call("answerCallbackQuery", {"callback_query_id": qid})
            return
        self.tg.call("answerCallbackQuery", {"callback_query_id": qid})
        if m.group(1):
            self.confirm(m.group(2), m.group(3) == "y", chat.get("id"), msg.get("message_id"))
        else:
            self.request_decision(int(m.group(5)), m.group(6) == "a", chat.get("id"), msg.get("message_id"))

    def confirm(self, tok, yes, chat_id, msg_id):
        p = self.state["pending"].pop(tok, None)
        self.save_state()
        if p is None or p.get("chat_id") != chat_id or p.get("message_id") != msg_id:
            self.edit(chat_id, msg_id, "This confirmation is no longer open. Send the command again.")
            return
        if self.clock() - p["created"] >= CONFIRM_TTL:
            self.edit(chat_id, msg_id, "This confirmation expired after 2 minutes. Nothing was changed. Send the command again.")
            return
        if not yes:
            self.edit(chat_id, msg_id, "Cancelled. Nothing was changed.")
            return
        rc = self.run_action(p)
        log(event=p["action"], rc=rc)
        self._status_cache = (0, None)
        if rc != 0:
            self.edit(chat_id, msg_id, f"That did not work (exit {rc}). Nothing was posted to the group.")
            return
        if p["action"] == "pause":
            self.edit(chat_id, msg_id, f"Done. Updates are paused: {p['reason']}")
            line = f"Updates paused by the owner: {p['reason'].rstrip('.')}. Nothing is broken."
        else:
            self.edit(chat_id, msg_id, "Done. Updates are resumed.")
            line = "Updates resumed."
        if self.team is not None:
            self.send(self.team, line)

    def request_decision(self, rid, approve, chat_id, msg_id):
        rec, changed = self.decide(rid, approve)
        if rec is None:
            self.edit(chat_id, msg_id, f"Request #{rid} was not found.")
            return
        if not changed:
            self.edit(chat_id, msg_id, f"Request #{rid} is already {rec.get('status')}.")
            return
        word = "approved" if approve else "declined"
        self.edit(chat_id, msg_id, f"Request #{rid} {word}: {rec['text']}")
        log(event="request_" + word, id=rid)
        if self.team is not None:
            txt = rec["text"].rstrip(".")
            if approve:
                self.send(self.team, f"Approved: {txt}. It will be built, tested and announced when live.")
            else:
                self.send(self.team, f"Not planned for now: {txt}.")

    # ---------------- loop
    def poll_once(self):
        off = self.load_offset()
        r = self.tg.call("getUpdates", {"offset": off, "timeout": self.cfg.poll_timeout,
                                        "allowed_updates": ["message", "callback_query"]},
                         timeout=self.cfg.poll_timeout + 20)
        if not r.get("ok"):
            return None
        ups = r.get("result") or []
        for u in ups:
            if not isinstance(u, dict) or not isinstance(u.get("update_id"), int):
                continue
            if u["update_id"] < off:
                continue
            self.handle_update(u)
            self.save_offset(u["update_id"] + 1)
        return len(ups)

    def run(self):
        if not self.token or self.team is None:
            log(event="not_configured", token=int(bool(self.token)), chat=int(self.team is not None))
            time.sleep(60)
            return 1
        while not self.me():
            log(event="getMe_failed")
            time.sleep(10)
        log(event="started", owner=int(self.owner is not None))
        fails = 0
        while True:
            n = self.poll_once()
            if n is None:
                fails += 1
                log(event="poll_failed", count=fails)
                time.sleep(min(60, 5 * fails))
            else:
                fails = 0


# ------------------------------------------------------------------ CLI
def cli_requests(argv):
    bot = Bot()
    if "--done" in argv:
        i = argv.index("--done")
        if len(argv) < i + 2 or not argv[i + 1].isdigit():
            print("usage: teambot requests --done <id> <note>", file=sys.stderr)
            return 2
        rid, note = int(argv[i + 1]), one_line(" ".join(argv[i + 2:]), 500)
        lk = bot.req_lock()
        try:
            reqs = bot.read_requests()
            rec = next((r for r in reqs if r.get("id") == rid), None)
            if rec is None:
                print(f"FAIL request {rid} not found", file=sys.stderr)
                return 1
            if rec.get("status") != "approved":
                print(f"FAIL request {rid} is {rec.get('status')}, only approved requests can be marked done",
                      file=sys.stderr)
                return 1
            rec["status"], rec["note"] = "done", note
            rec["done_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            bot.write_requests(reqs)
        finally:
            lk.close()
        ok = bot.team is not None and bot.send(bot.team, f"Done: {rec['text'].rstrip('.')}.").get("ok")
        print(f"PASS request {rid} marked done")
        print(f"PASS posted to the team group" if ok else "WARN could not post to the team group")
        return 0
    want = "approved" if "--approved" in argv else None
    for r in bot.read_requests():
        if want is None or r.get("status") == want:
            print(json.dumps(r, sort_keys=True))
    return 0


def cli_check(argv):
    cfg, bad = Cfg(), 0

    def line(ok, msg):
        nonlocal bad
        bad += 0 if ok else 1
        print(("PASS " if ok else "FAIL ") + msg)

    bot = Bot(cfg)
    line(bool(bot.token), "bot token present in " + cfg.telegram_env)
    line(bot.team is not None, "team chat id present in " + cfg.telegram_env)
    line(bot.owner is not None, "OWNER_TELEGRAM_ID set in " + cfg.teambot_env + " (needed for /pause, /resume, /request)")
    line(os.path.isfile(cfg.known), "known.md present at " + cfg.known)
    caps = bot.captions()
    for kind in ("desktop", "phone"):
        n = len(glob.glob(os.path.join(cfg.home, "videos", kind, "capstan-*.mp4")))
        print(f"INFO {n} {kind} videos in {cfg.home}/videos/{kind} ({len(caps)} captions)")
    line(os.path.isfile(cfg.contracts), "contracts.json present at " + cfg.contracts)
    s = bot.status()
    line(s["ok"], f"runner status readable (released {s['released']} of {s['total']})")
    if "--live" in argv:
        line(bot.me(), "Telegram answers getMe" + (f" as @{bot.bot_name}" if bot.bot_name else ""))
        w = bot.tg.call("getWebhookInfo", {})
        line(w.get("ok") and not (w.get("result") or {}).get("url"), "no webhook set (getUpdates can run)")
    return 1 if bad else 0


def main(argv):
    if len(argv) >= 1 and argv[0] == "run":
        return Bot().run()
    if len(argv) >= 1 and argv[0] == "requests":
        return cli_requests(argv[1:])
    if len(argv) >= 1 and argv[0] == "check":
        return cli_check(argv[1:])
    print("usage: teambot run | check [--live] | requests [--approved] | requests --done <id> <note>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
