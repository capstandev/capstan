# The team bot end to end: the real program (ops/teambot/teambot.py) against the stand-in Telegram Bot API
# (ops/alerts/telegram-standin.ts, run with bun) and the real release runner commands (ops/release/bin/status.sh,
# pause.sh, unpause.sh) on a scratch runner home. No network, no real bot, no real group.
# Run: python3 -m unittest discover -s ops/teambot/tests -t .   (from backend/; TEAMBOT_STANDIN_PORT, default 25581)
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
STANDIN = os.path.join(ROOT, "ops", "alerts", "telegram-standin.ts")
RUNNER_BIN = os.path.join(ROOT, "ops", "release", "bin")
PORT = int(os.environ.get("TEAMBOT_STANDIN_PORT", "25581"))
TOKEN = "123456:standin-token-for-tests-only"
TEAM = -1009990001
OWNER = 4242001
OTHER = 5151002
BOT_ID = 7000000001

spec = importlib.util.spec_from_file_location("teambot", os.path.join(ROOT, "ops", "teambot", "teambot.py"))
teambot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teambot)


def http(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


class TeamBotTest(unittest.TestCase):
    proc = None

    @classmethod
    def setUpClass(cls):
        bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
        cls.proc = subprocess.Popen([bun, STANDIN, "--port", str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True)
        line = cls.proc.stdout.readline()
        if "listening" not in line:
            cls.proc.kill()
            raise RuntimeError("stand-in did not start: " + line)

    @classmethod
    def tearDownClass(cls):
        if cls.proc:
            cls.proc.terminate()
            cls.proc.wait(timeout=10)

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="teambot-test-")
        t = self.tmp
        self.rr = os.path.join(t, "release")
        os.makedirs(os.path.join(self.rr, "log"))
        os.makedirs(os.path.join(self.rr, "posters"))
        os.makedirs(os.path.join(self.rr, "notes"))
        now = int(time.time())
        launch = now - 3 * 3600 + 60
        rows = ["# base aaaa", "# tip bbbb", f"# launch_at {teambot.epoch_iso(launch)}", "# cadence_minutes 60"]
        titles = ["MCP landing page", "Health shows the running commit", "Contracts page", "Public USDG peg reading",
                  "Rate-limit headers", "MCP tool capstan_venues", "Security headers"]
        for i, title in enumerate(titles, 1):
            rows.append(f"{i}\t{launch + (i - 1) * 3600}\tsha{i}\t{title}")
        self.write(os.path.join(self.rr, "schedule.tsv"), "\n".join(rows) + "\n")
        self.write(os.path.join(self.rr, "state.tsv"), f"1\treleased\t1\t{launch}\t\n2\treleased\t1\t{launch}\t\n"
                                                        f"3\theld\t2\t{launch}\tcheck failed\n")
        self.write(os.path.join(self.rr, "posters", "update-01.png"), "\x89PNG fake poster 1")
        self.write(os.path.join(self.rr, "posters", "update-04.png"), "\x89PNG fake poster 4")
        self.write(os.path.join(self.rr, "notes", "update-01.txt"), "UPDATE\nMCP landing page.")
        self.conf = os.path.join(t, "release.conf")
        self.write(self.conf, f"RR_HOME={self.rr}\nFLAG_FILE={t}/no-flag\nOWNER_TZ=UTC\nRUNNER_USER={os.environ.get('USER', 'nobody')}\n")
        self.write(os.path.join(t, "telegram.env"), f"TELEGRAM_BOT_TOKEN={TOKEN}\nTELEGRAM_CHAT_ID={TEAM}\n")
        self.write(os.path.join(t, "teambot.env"), f"OWNER_TELEGRAM_ID={OWNER}\n")
        shutil.copy(os.path.join(ROOT, "ops", "teambot", "known.md"), os.path.join(t, "known.md"))
        self.home = os.path.join(t, "home")
        os.makedirs(os.path.join(self.home, "videos", "desktop"))
        os.makedirs(os.path.join(self.home, "videos", "phone"))
        shutil.copy(os.path.join(ROOT, "ops", "teambot", "captions.json"), os.path.join(self.home, "captions.json"))
        self.write(os.path.join(self.home, "videos", "desktop", "capstan-01-quote-compare.mp4"), "fake mp4 bytes")
        self.write(os.path.join(t, "contracts.json"), json.dumps({"generatedBy": "x", "cpst": {"46630": {
            "address": "0x" + "ab" * 20, "symbol": "CPST", "decimals": 18, "supply": "1000000000",
            "anchor": "0x" + "cd" * 20}}}))
        env = {"TEAMBOT_TELEGRAM_ENV": os.path.join(t, "telegram.env"), "TEAMBOT_ENV": os.path.join(t, "teambot.env"),
               "TEAMBOT_KNOWN": os.path.join(t, "known.md"), "TEAMBOT_HOME": self.home,
               "TEAMBOT_RELEASE_HOME": self.rr, "TEAMBOT_CONTRACTS": os.path.join(t, "contracts.json"),
               "TEAMBOT_STATUS_CMD": os.path.join(RUNNER_BIN, "status.sh"),
               "TEAMBOT_PAUSE_CMD": os.path.join(RUNNER_BIN, "pause.sh"),
               "TEAMBOT_RESUME_CMD": os.path.join(RUNNER_BIN, "unpause.sh"),
               "TEAMBOT_RR_CONF": self.conf, "TEAMBOT_SITE": "https://get-capstan.com",
               "TELEGRAM_API_BASE": f"http://127.0.0.1:{PORT}", "TEAMBOT_POLL_TIMEOUT": "0"}
        self.saved_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        self.clock = Clock()
        self.log = io.StringIO()
        with contextlib.redirect_stdout(self.log):
            self.bot = teambot.Bot(clock=self.clock)
            self.assertTrue(self.bot.me())
        self.seen = len(http("GET", "/__standin/calls")["calls"])
        self.msg = 100

    def tearDown(self):
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def write(path, text):
        with open(path, "w") as f:
            f.write(text)

    # ---------------- helpers
    def poll(self):
        with contextlib.redirect_stdout(self.log):
            for _ in range(3):
                self.bot.poll_once()
        calls = http("GET", "/__standin/calls")["calls"]
        new, self.seen = calls[self.seen:], len(calls)
        return new

    def say(self, text, who=OTHER, chat=TEAM, ctype="supergroup", reply_to=None):
        self.msg += 1
        m = {"message_id": self.msg, "date": int(time.time()), "text": text,
             "chat": {"id": chat, "type": ctype}, "from": {"id": who, "is_bot": False, "first_name": f"user{who}"}}
        if reply_to:
            m["reply_to_message"] = reply_to
        http("POST", "/__standin/updates", [{"message": m}])
        return self.poll()

    def tap(self, call, label, who=OWNER):
        """Tap the button with this label on the message a sendMessage call made."""
        kb = json.loads(call["replyMarkup"])["inline_keyboard"][0]
        data = next(b["callback_data"] for b in kb if b["text"] == label)
        mid = call["_message_id"]
        q = {"id": f"cq{self.msg}", "from": {"id": who, "is_bot": False, "first_name": "x"}, "data": data,
             "message": {"message_id": mid, "chat": {"id": int(call["chatId"]),
                                                  "type": "private" if int(call["chatId"]) > 0 else "supergroup"}}}
        self.msg += 1
        http("POST", "/__standin/updates", [{"callback_query": q}])
        return self.poll()

    def sends(self, calls, method="sendMessage"):
        return [c for c in calls if c["method"] == method]

    def one_reply(self, text, **kw):
        calls = self.say(text, **kw)
        msgs = self.sends(calls)
        self.assertEqual(len(msgs), 1, calls)
        return msgs[0]["text"]

    def confirm_message(self, calls):
        msgs = [c for c in self.sends(calls) if c.get("replyMarkup")]
        self.assertEqual(len(msgs), 1, calls)
        c = msgs[0]
        # The bot stored the message id the stand-in returned; read it back from its state.
        pend = list(self.bot.state["pending"].values())
        c["_message_id"] = pend[-1]["message_id"] if pend else 0
        return c

    # ---------------- everyone
    def test_help_and_whoami(self):
        self.assertIn("/status", self.one_reply("/help"))
        self.assertIn("Owner only: /pause <reason>, /resume", self.one_reply("/help"))
        self.assertEqual(self.one_reply("/whoami", who=OTHER), f"Your Telegram id is {OTHER}.")

    def test_status_reads_the_release_runner(self):
        t = self.one_reply("/status")
        self.assertIn("Released 2 of 7.", t)
        self.assertIn("Next: Update 4, Public USDG peg reading, at", t)
        self.assertIn("Updates are running.", t)
        self.assertIn("Held: Update 3, Contracts page.", t)

    def test_status_when_runner_unreadable(self):
        os.environ["TEAMBOT_STATUS_CMD"] = os.path.join(self.tmp, "missing-status")
        os.remove(os.path.join(self.rr, "schedule.tsv"))
        with contextlib.redirect_stdout(self.log):
            self.bot = teambot.Bot(clock=self.clock)
            self.bot.me()
        self.assertIn("could not be read", self.one_reply("/status"))

    def test_roadmap_and_changelog_link_the_site(self):
        t = self.one_reply("/roadmap")
        self.assertTrue(t.startswith("Roadmap: https://get-capstan.com/roadmap"), t)
        self.assertIn("Update 4, Public USDG peg reading", t)
        self.assertIn("Update 6, MCP tool capstan_venues", t)
        self.assertNotIn("Update 7", t)
        t = self.one_reply("/changelog")
        self.assertTrue(t.startswith("Changelog: https://get-capstan.com/changelog"), t)
        self.assertLess(t.index("Update 2"), t.index("Update 1"))
        self.assertIn("https://github.com/capstandev/capstan/releases/tag/update-02", t)

    def test_socials_and_contracts(self):
        t = self.one_reply("/socials")
        for u in ("https://get-capstan.com", "https://get-capstan.com/roadmap", "https://github.com/capstandev/capstan"):
            self.assertIn(u, t)
        t = self.one_reply("/contracts")
        self.assertIn("not deployed on Robinhood Chain mainnet yet", t)
        self.assertIn("Robinhood Chain testnet (chain 46630)", t)
        self.assertIn("https://explorer.testnet.chain.robinhood.com/address/0x" + "ab" * 20, t)
        self.assertIn("CapstanReceiptAnchor: 0x" + "cd" * 20, t)

    def test_videos_and_video(self):
        t = self.one_reply("/videos")
        self.assertIn("1. Quote compare", t)
        calls = self.say("/video 1")
        vids = self.sends(calls, "sendVideo")
        self.assertEqual(len(vids), 1, calls)
        self.assertEqual(vids[0]["chatId"], str(TEAM))
        self.assertIn("Demo (desktop): One quote, every venue", vids[0]["text"])
        self.assertIn("not on the server yet", self.one_reply("/video 1 phone"))
        self.assertIn("Send /video N with N from 0 to 9", self.one_reply("/video 42"))

    def test_poster_only_when_released(self):
        calls = self.say("/poster 1")
        ph = self.sends(calls, "sendPhoto")
        self.assertEqual(len(ph), 1, calls)
        self.assertIn("MCP landing page.", ph[0]["text"])
        self.assertIn("releases/tag/update-01", ph[0]["text"])
        self.assertIn("is not released yet", self.one_reply("/poster 4"))
        self.assertIn("not on the server", self.one_reply("/poster 2"))
        self.assertIn("Send /poster N", self.one_reply("/poster x"))

    # G4-02: the runner's folder belongs to another account; a link it plants must never make the bot read the target
    def plant_secret(self):
        secret = os.path.join(self.tmp, "root-only.env")
        self.write(secret, "TELEGRAM_BOT_TOKEN=planted-secret-value\n")
        return secret

    def test_poster_refuses_a_linked_notes_file(self):
        notes = os.path.join(self.rr, "notes", "update-01.txt")
        os.remove(notes)
        os.symlink(self.plant_secret(), notes)
        ph = self.sends(self.say("/poster 1"), "sendPhoto")
        self.assertEqual(len(ph), 1)
        self.assertNotIn("planted-secret-value", ph[0]["text"])
        self.assertIn("Update 1", ph[0]["text"])

    def test_poster_refuses_a_linked_poster_or_folder(self):
        poster = os.path.join(self.rr, "posters", "update-01.png")
        os.remove(poster)
        os.symlink(self.plant_secret(), poster)
        self.assertIn("not on the server", self.one_reply("/poster 1"))
        os.remove(poster)
        real = os.path.join(self.tmp, "elsewhere")
        os.makedirs(real)
        self.write(os.path.join(real, "update-01.png"), "\x89PNG from a linked folder")
        shutil.rmtree(os.path.join(self.rr, "posters"))
        os.symlink(real, os.path.join(self.rr, "posters"))
        self.assertIn("not on the server", self.one_reply("/poster 1"))

    def test_poster_refuses_a_fifo_without_hanging(self):
        notes = os.path.join(self.rr, "notes", "update-01.txt")
        os.remove(notes)
        os.mkfifo(notes)
        ph = self.sends(self.say("/poster 1"), "sendPhoto")
        self.assertEqual(len(ph), 1)
        self.assertIn("Update 1", ph[0]["text"])

    def test_poster_uploads_the_bytes_it_read(self):
        ph = self.sends(self.say("/poster 1"), "sendPhoto")
        self.assertEqual(len(ph), 1)
        self.assertEqual(str(ph[0].get("photo")), str(len("\x89PNG fake poster 1".encode())))
        self.assertEqual([f for f in os.listdir(self.home) if f.startswith("poster-")], [])  # the private copy is gone

    def test_linked_state_file_reads_as_empty(self):
        state = os.path.join(self.rr, "state.tsv")
        target = os.path.join(self.tmp, "state-elsewhere.tsv")
        shutil.move(state, target)
        os.symlink(target, state)
        self.assertEqual(self.bot.released_ids(), {})

    def test_service_is_not_root_and_sudo_is_narrow(self):
        with open(os.path.join(ROOT, "ops", "teambot", "capstan-teambot.service")) as f:
            unit = f.read()
        self.assertNotRegex(unit, r"(?m)^User=root")
        self.assertRegex(unit, r"(?m)^User=capstan-teambot$")
        self.assertRegex(unit, r"(?m)^LoadCredential=telegram.env:/etc/capstan-release/telegram.env$")
        with open(os.path.join(ROOT, "ops", "teambot", "sudoers", "capstan-teambot")) as f:
            rules = [ln for ln in f.read().splitlines() if ln.strip() and not ln.startswith("#")]
        self.assertEqual(rules, ["capstan-teambot ALL=(root) NOPASSWD: /usr/local/sbin/capstan-release-status, "
                                 "/usr/local/sbin/capstan-release-pause, /usr/local/sbin/capstan-release-resume"])
        for k in ("TEAMBOT_STATUS_CMD", "TEAMBOT_PAUSE_CMD", "TEAMBOT_RESUME_CMD"):
            os.environ.pop(k, None)
        cfg = teambot.Cfg()
        self.assertEqual(cfg.status_cmd, ["/usr/bin/sudo", "-n", "/usr/local/sbin/capstan-release-status", "3"])
        self.assertEqual(cfg.pause_cmd, ["/usr/bin/sudo", "-n", "/usr/local/sbin/capstan-release-pause"])
        self.assertEqual(cfg.resume_cmd, ["/usr/bin/sudo", "-n", "/usr/local/sbin/capstan-release-resume"])

    def test_mcp_reads_known_md(self):
        t = self.one_reply("/mcp")
        self.assertTrue(t.startswith("MCP server:"), t)
        self.assertIn("https://api.get-capstan.com/mcp", t)
        self.write(os.path.join(self.tmp, "known.md"), "# nothing\n")
        self.assertEqual(self.one_reply("/mcp"), teambot.NOT_YET)

    # ---------------- owner only
    def test_non_owner_cannot_pause_or_resume(self):
        self.assertEqual(self.one_reply("/pause gas check", who=OTHER), teambot.ONLY_OWNER)
        self.assertEqual(self.one_reply("/resume", who=OTHER), teambot.ONLY_OWNER)
        self.assertFalse(os.path.exists(os.path.join(self.rr, "PAUSE")))

    def test_non_owner_tap_on_owner_confirm_does_nothing(self):
        c = self.confirm_message(self.say("/pause gas check", who=OWNER))
        calls = self.tap(c, "Confirm", who=OTHER)
        ans = [x for x in calls if x["method"] == "answerCallbackQuery"]
        self.assertEqual(len(ans), 1)
        self.assertTrue(ans[0].get("showAlert"))
        self.assertEqual(ans[0]["text"], teambot.ONLY_OWNER)
        self.assertEqual(self.sends(calls), [])
        self.assertFalse(os.path.exists(os.path.join(self.rr, "PAUSE")))

    def test_owner_pause_confirm_then_resume(self):
        c = self.confirm_message(self.say("/pause gas check", who=OWNER))
        self.assertIn("Pause the updates?\nReason: gas check", c["text"])
        labels = [b["text"] for b in json.loads(c["replyMarkup"])["inline_keyboard"][0]]
        self.assertEqual(labels, ["Confirm", "Cancel"])
        calls = self.tap(c, "Confirm")
        with open(os.path.join(self.rr, "PAUSE")) as f:
            self.assertIn("owner via the team bot: gas check", f.read())
        team = [x["text"] for x in self.sends(calls) if x["chatId"] == str(TEAM)]
        self.assertIn("Updates paused by the owner: gas check. Nothing is broken.", team)
        edits = [x["text"] for x in calls if x["method"] == "editMessageText"]
        self.assertEqual(edits, ["Done. Updates are paused: gas check"])
        t = self.one_reply("/status")
        self.assertIn("Updates are paused since", t)
        self.assertIn(": gas check.", t)
        self.assertNotIn("team bot", t)
        c = self.confirm_message(self.say("/resume", who=OWNER))
        calls = self.tap(c, "Confirm")
        self.assertFalse(os.path.exists(os.path.join(self.rr, "PAUSE")))
        self.assertIn("Updates resumed.", [x["text"] for x in self.sends(calls)])
        self.assertIn("Updates are running.", self.one_reply("/status"))

    def test_cancel_and_expiry_change_nothing(self):
        c = self.confirm_message(self.say("/pause x", who=OWNER))
        calls = self.tap(c, "Cancel")
        self.assertEqual([x["text"] for x in calls if x["method"] == "editMessageText"], ["Cancelled. Nothing was changed."])
        c = self.confirm_message(self.say("/pause y", who=OWNER))
        self.clock.t += teambot.CONFIRM_TTL + 1
        calls = self.tap(c, "Confirm")
        self.assertIn("expired", [x["text"] for x in calls if x["method"] == "editMessageText"][0])
        self.assertFalse(os.path.exists(os.path.join(self.rr, "PAUSE")))
        self.assertEqual(self.sends(calls), [])

    # ---------------- requests
    def request(self, text):
        calls = self.say(f"/request {text}", who=OTHER)
        to_owner = [x for x in self.sends(calls) if x["chatId"] == str(OWNER)]
        self.assertEqual(len(to_owner), 1, calls)
        reply = [x for x in self.sends(calls) if x["chatId"] == str(TEAM)]
        self.assertTrue(reply[0]["text"].startswith("Saved as request #"))
        c = to_owner[0]
        labels = [b["text"] for b in json.loads(c["replyMarkup"])["inline_keyboard"][0]]
        self.assertEqual(labels, ["Approve", "Decline"])
        c["_message_id"] = 1
        return c

    def test_request_approve_decline_and_done(self):
        c = self.request("a weekly summary post")
        self.assertEqual(self.sends(self.tap(c, "Approve", who=OTHER)), [])  # not the owner: nothing happens
        calls = self.tap(c, "Approve")
        self.assertIn("Approved: a weekly summary post. It will be built, tested and announced when live.",
                      [x["text"] for x in self.sends(calls)])
        again = self.tap(c, "Decline")
        self.assertIn("already approved", [x["text"] for x in again if x["method"] == "editMessageText"][0])
        c2 = self.request("a dark mode")
        calls = self.tap(c2, "Decline")
        self.assertIn("Not planned for now: a dark mode.", [x["text"] for x in self.sends(calls)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(teambot.cli_requests(["--approved"]), 0)
        lines = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual([r["text"] for r in lines], ["a weekly summary post"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(teambot.cli_requests(["--done", str(lines[0]["id"]), "shipped"]), 0)
        calls = http("GET", "/__standin/calls")["calls"][self.seen:]
        self.assertIn("Done: a weekly summary post.", [x["text"] for x in calls])

    def test_request_too_short(self):
        self.assertIn("Write what you want", self.one_reply("/request x"))

    # ---------------- safety
    def test_other_chats_ignored_and_mentions(self):
        self.assertEqual(self.say("/status", chat=-100777, ctype="supergroup"), [])
        self.assertEqual(self.say("/status", who=OTHER, chat=OTHER, ctype="private"), [])
        t = self.one_reply("hello @capstan_team_standin_bot what is new")
        self.assertIn("Use /request", t)
        self.assertEqual(self.say("just chatting"), [])

    def test_logs_never_hold_text_or_token(self):
        self.say("/request secret plan words here")
        self.say("/pause hush reason", who=OWNER)
        log = self.log.getvalue()
        self.assertNotIn("secret plan", log)
        self.assertNotIn("hush", log)
        self.assertNotIn(TOKEN, log)
        self.assertIn("cmd=request", log)
        record = json.dumps(http("GET", "/__standin/calls"))
        self.assertNotIn(TOKEN, record)


class SetKeysTest(unittest.TestCase):
    def test_hidden_prompt_saves_owner_id(self):
        d = tempfile.mkdtemp(prefix="teambot-keys-")
        try:
            env = dict(os.environ, TEAMBOT_SET_KEYS_DRY=d)
            r = subprocess.run(["bash", os.path.join(ROOT, "ops", "teambot", "set-keys.sh")], input="4242001\n4242001\n",
                               capture_output=True, text=True, env=env, timeout=30)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertNotIn("4242001", r.stdout + r.stderr)  # hidden: the id is never echoed back
            with open(os.path.join(d, "teambot.env")) as f:
                self.assertEqual(f.read(), "OWNER_TELEGRAM_ID=4242001\n")
            self.assertEqual(os.stat(os.path.join(d, "teambot.env")).st_mode & 0o777, 0o600)
            r = subprocess.run(["bash", os.path.join(ROOT, "ops", "teambot", "set-keys.sh")], input="12345\n54321\n",
                               capture_output=True, text=True, env=env, timeout=30)
            self.assertNotEqual(r.returncode, 0)
            r = subprocess.run(["bash", os.path.join(ROOT, "ops", "teambot", "set-keys.sh")], input="abc\nabc\n",
                               capture_output=True, text=True, env=env, timeout=30)
            self.assertNotEqual(r.returncode, 0)
            with open(os.path.join(d, "teambot.env")) as f:
                self.assertEqual(f.read(), "OWNER_TELEGRAM_ID=4242001\n")
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
