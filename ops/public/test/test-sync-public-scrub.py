#!/usr/bin/env python3
"""Tests for the file scrub in sync-public.py. Runs the script in --dry-run against a throwaway private repo."""
import json, os, subprocess, sys, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sync-public.py")


def run(cwd, *a, env=None, check=True):
    return subprocess.run(a, cwd=cwd, capture_output=True, text=True, check=check, env=dict(os.environ, **(env or {})))


class ScrubTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="syncscrub")
        self.priv, self.pub = os.path.join(self.d, "priv"), os.path.join(self.d, "pub.git")
        run(self.d, "git", "init", "-q", "-b", "main", self.priv)
        run(self.d, "git", "init", "-q", "--bare", "-b", "main", self.pub)
        self.key = os.path.join(self.d, "k")
        run(self.d, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", self.key)
        for k, v in (("user.name", "owner"), ("user.email", "o@example.com"), ("commit.gpgsign", "false")):
            run(self.priv, "git", "config", k, v)
        run(self.priv, "git", "remote", "add", "public", self.pub)
        empty = run(self.priv, "git", "hash-object", "-t", "tree", "/dev/null").stdout.strip()
        env = {"GIT_AUTHOR_NAME": "pub", "GIT_AUTHOR_EMAIL": "p@example.com", "GIT_COMMITTER_NAME": "pub", "GIT_COMMITTER_EMAIL": "p@example.com"}
        self.pub0 = run(self.priv, "git", "-c", "gpg.format=ssh", "-c", f"user.signingkey={self.key}.pub", "commit-tree", "-S", empty, "-m", "init", env=env).stdout.strip()
        run(self.priv, "git", "push", "-q", "public", f"{self.pub0}:refs/heads/main")
        self.base = run(self.priv, "git", "commit-tree", empty, "-m", "base").stdout.strip()
        run(self.priv, "git", "update-ref", "refs/heads/main", self.base)
        run(self.priv, "git", "reset", "-q", "--hard", "main")
        self.state = os.path.join(self.d, "state.json")

    def commit(self, files, msg="chore: x"):
        for p, t in files.items():
            os.makedirs(os.path.dirname(os.path.join(self.priv, p)) or self.priv, exist_ok=True)
            open(os.path.join(self.priv, p), "w").write(t)
        run(self.priv, "git", "add", "-A")
        run(self.priv, "git", "commit", "-q", "-m", msg)

    def sync(self, **extra):
        st = {"privateSha": self.base, "publicSha": self.pub0, "name": "pub", "email": "p@example.com", "signingKey": self.key + ".pub",
              "publicRemote": "public", "branch": "main", "forbidden": "acmecorp|zorbo"}
        st.update(extra)
        json.dump(st, open(self.state, "w"))
        return run(self.priv, sys.executable, SCRIPT, self.state, "--dry-run", check=False)

    def tip(self, r):
        return [l for l in r.stdout.splitlines() if "->" in l][-1].split()[2]

    def test_scrub_rewrites_listed_blob_and_leaves_no_hit(self):
        self.commit({"cfg.json": '{"n": "the size Acmecorp used."}\n', "keep.txt": "ok\n"})
        r = self.sync(scrubFiles={"cfg.json": [["the size Acmecorp used.", "a typical size."]]})
        self.assertEqual(r.returncode, 0, r.stderr)
        t = self.tip(r)
        self.assertIn("a typical size.", run(self.priv, "git", "show", f"{t}:cfg.json").stdout)
        self.assertEqual(run(self.priv, "git", "grep", "-liE", "acmecorp", t, check=False).returncode, 1)
        self.assertEqual(run(self.priv, "git", "show", f"{t}:keep.txt").stdout, "ok\n")

    def test_unlisted_hit_fails_loudly(self):
        self.commit({"notes.md": "mentions ZORBO here\n"})
        r = self.sync(scrubFiles={"cfg.json": [["a", "b"]]})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("notes.md", r.stderr + r.stdout)

    def test_rule_that_does_not_clear_the_word_fails(self):
        self.commit({"cfg.json": "Acmecorp\n"})
        r = self.sync(scrubFiles={"cfg.json": [["nomatch", "x"]]})
        self.assertNotEqual(r.returncode, 0)

    def test_skip_path_is_by_path_only(self):
        self.commit({"web/a.svg": "xxzorboxx\n", "src/b.ts": "// clean\n"})
        r = self.sync(forbiddenSkipPaths=["web/*.svg"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.commit({"src/c.ts": "// zorbo\n"})
        r = self.sync(forbiddenSkipPaths=["web/*.svg"])
        self.assertNotEqual(r.returncode, 0)

    def test_every_commit_is_checked_not_only_the_tip(self):
        self.commit({"old.txt": "acmecorp\n"})
        self.commit({"old.txt": "clean\n"})
        r = self.sync()
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
