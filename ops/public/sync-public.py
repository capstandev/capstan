#!/usr/bin/env python3
"""Copy new commits from the private dev repo to the public repo as the project's public user.

Each private commit on main (first-parent, oldest first) since the last sync becomes one public commit with the
same tree, the same author date and message, but author+committer = the public user, AI co-author lines and the
owner's name removed, signed with the public user's SSH key. Then pushes the public branch.

Usage (inside the private checkout):  python3 sync-public.py <state.json> [--dry-run]
Optional "changelog": {"entries": "<json (or a list of json files): private sha -> {n,id,title,date,notes}>", "commitUrl": ".../commit/{sha}"}:
the public tree then also carries CHANGELOG.md (newest first) and, right after the public commit of an update that has an
entry, one more signed commit adds that update's entry (number, date, plain-English notes, link to the commit before it).
Every public commit's tree is the private tree plus CHANGELOG.md. History stays linear. A line "<private> <public>" per
public commit is appended to <state.json>.map.jsonl (used by <project>-release-where).
Crash safety: before the push, the planned result is written to <state.json>.pending.json (the journal); after the push,
the map and the state are written and the journal removed. A run that finds public main ahead of the state adopts it when
it is exactly the journal's planned tip (our own push whose state write was lost), or, without a journal, when it
descends from the state's public sha, is authored by the public user and its tree (minus CHANGELOG.md) is the tree of a
private commit we would copy. Anything else stops ("someone pushed there"). `--reconcile` does only that recovery (no new
commits, no push). A commit message that still holds a forbidden word after the scrub is refused (nothing is pushed).
A commit message that cannot be published as it is (forbidden word) can be replaced, by the owner only, through
SYNC_MESSAGE_OVERRIDES: a JSON file {"<private sha>": "<public message>"}, root-owned on the server
(e.g. /etc/<project>-release/public-message-overrides.json), so one bad message never freezes the public copy for the launch.
Usage: python3 sync-public.py <state.json> [--dry-run | --reconcile]
Environment overrides (for the server, where git signs with a key file and pushes through an ssh alias):
SYNC_SIGNING_KEY (path), SYNC_PUBLIC_REMOTE.
File scrub (state "scrubFiles": {"<path>": [["<old text>", "<new text>"]]}, "forbiddenSkipPaths": ["<pathspec glob>"]): every public tree is grepped for
the "forbidden" words; blobs listed in scrubFiles are rewritten first; any remaining hit refuses the whole sync before anything is pushed.
state.json: {"privateSha": "...", "publicSha": "...", "name": "...", "email": "...", "signingKey": "~/.ssh/....pub",
             "publicRemote": "public", "branch": "main", "scrub": {"<OwnerName>": "the owner"},
             "forbidden": "<extra|words|to|refuse>", "projectName": "<Project>"}
"""
import json, os, re, subprocess, sys

state_path = sys.argv[1]
dry = "--dry-run" in sys.argv
reconcile_only = "--reconcile" in sys.argv
pending_path = state_path + ".pending.json"
st = json.load(open(state_path))
key = os.path.expanduser(os.environ.get("SYNC_SIGNING_KEY") or st["signingKey"])
if os.environ.get("SYNC_PUBLIC_REMOTE"):
    st["publicRemote"] = os.environ["SYNC_PUBLIC_REMOTE"]
cl = st.get("changelog") or {}
FORBIDDEN = re.compile(r"(?i)claude|anthropic|chatgpt|openai|codex|copilot|co-authored[-]by|generated[ ]with" + ("|" + st["forbidden"] if st.get("forbidden") else ""))  # st["forbidden"]: owner names/handles, set per project
HEADER = f"# Changelog\n\nPlain-English notes for every {st.get('projectName', 'project')} update, newest first. Each entry links to the commit that shipped it.\n"
branch = st.get("branch", "main")
OVERRIDES = {}
if os.environ.get("SYNC_MESSAGE_OVERRIDES") and os.path.exists(os.environ["SYNC_MESSAGE_OVERRIDES"]):
    OVERRIDES = {k: v for k, v in json.load(open(os.environ["SYNC_MESSAGE_OVERRIDES"])).items() if isinstance(v, str) and v.strip()}


def git(*a, inp=None, env=None):
    return subprocess.run(["git", *a], input=inp, capture_output=True, text=True, check=True, env=env).stdout


def save_state(mapping, private_sha, public_sha):
    """Map lines, then the state (atomically), then the journal goes: a crash in between is adopted by reconcile()."""
    with open(state_path + ".map.jsonl", "a") as mf:
        for pv, pb in mapping:
            mf.write(json.dumps({"private": pv, "public": pb}) + "\n")
    st["privateSha"], st["publicSha"] = private_sha, public_sha
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_path)
    if os.path.exists(pending_path):
        os.remove(pending_path)


def tree_minus_changelog(commit):
    entries_ = [l for l in git("ls-tree", commit).splitlines() if not l.endswith("\tCHANGELOG.md")]
    return git("mktree", inp="\n".join(entries_) + ("\n" if entries_ else "")).strip()


def reconcile(remote_tip):
    """public main != state: adopt it if it is our own push whose state write was lost. Returns a message or None."""
    if os.path.exists(pending_path):
        pend = json.load(open(pending_path))
        if pend.get("publicSha") == remote_tip and pend.get("basePublicSha") == st["publicSha"]:
            save_state([tuple(x) for x in pend["mapping"]], pend["privateSha"], remote_tip)
            return f"adopted the journalled push: public {branch} = {remote_tip[:12]} (private {pend['privateSha'][:12]})"
    try:
        git("merge-base", "--is-ancestor", st["publicSha"], remote_tip)
    except subprocess.CalledProcessError:
        return None
    if git("log", "-1", "--format=%an|%ae|%cn|%ce", remote_tip).strip() != f"{st['name']}|{st['email']}|{st['name']}|{st['email']}":
        return None
    want = tree_minus_changelog(remote_tip)
    for c in reversed(git("rev-list", "--first-parent", f"{st['privateSha']}..{branch}").split()):
        if tree_minus_changelog(c) == want:
            save_state([(c, remote_tip)], c, remote_tip)
            return f"adopted public {branch} {remote_tip[:12]}: same tree as private {c[:12]} (content match)"
    return None


git("fetch", "-q", st["publicRemote"], branch)
remote_tip = git("rev-parse", f"{st['publicRemote']}/{branch}").strip()
if remote_tip != st["publicSha"]:
    how = reconcile(remote_tip)
    if not how:
        sys.exit(f"public {branch} is at {remote_tip[:12]}, state says {st['publicSha'][:12]}: someone pushed there; stop")
    print(how)
elif os.path.exists(pending_path):
    os.remove(pending_path)  # the journalled push never happened
if reconcile_only:
    print(f"public {branch} = state = {st['publicSha'][:12]}")
    sys.exit(0)

def forbidden_file_hits(tree):
    """Paths in this tree whose text contains a state "forbidden" word (case-insensitive). Paths matching state
    "forbiddenSkipPaths" (git pathspec globs, e.g. base64 SVGs that match by chance) are skipped by path, never by turning the check off."""
    if not st.get("forbidden"):
        return []
    spec = ["--", "."] + [f":(exclude,glob){g}" for g in st.get("forbiddenSkipPaths", [])]
    r = subprocess.run(["git", "grep", "-lIiE", st["forbidden"], tree, *spec], capture_output=True, text=True)
    if r.returncode not in (0, 1):
        sys.exit(f"git grep failed on tree {tree[:12]}: {r.stderr.strip()}")
    return [l.split(":", 1)[1] for l in r.stdout.splitlines() if ":" in l]


def scrub_tree(tree, label):
    """Apply state "scrubFiles" ({path: [[old, new], ...]}) to the blobs of this tree, then refuse the commit if any
    forbidden word is still in any file. Returns the (possibly new) tree."""
    hits = forbidden_file_hits(tree)
    if not hits:
        return tree
    idx = os.path.join(git("rev-parse", "--git-dir").strip(), "sync-public-scrub.index")
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    if os.path.exists(idx):
        os.remove(idx)
    git("read-tree", tree, env=env)
    for path in hits:
        rules = st.get("scrubFiles", {}).get(path)
        if not rules:
            continue
        text = git("show", f"{tree}:{path}")
        for old, new in rules:
            text = text.replace(old, new)
        mode = git("ls-tree", tree, "--", path).split()[0]
        git("update-index", "--add", "--cacheinfo", f"{mode},{blob(text)},{path}", env=env)
    new_tree = git("write-tree", env=env).strip()
    os.remove(idx)
    left = forbidden_file_hits(new_tree)
    if left:
        sys.exit(f"private commit {label}: forbidden word still in file(s) after the scrub: {', '.join(left[:10])}"
                 f"{' ...' if len(left) > 10 else ''}. Refusing to publish (nothing pushed). Fix the file in private or add a scrubFiles rule.")
    return new_tree


new = git("rev-list", "--reverse", "--first-parent", f"{st['privateSha']}..{branch}").split()
if not new:
    print("nothing to sync")
    sys.exit(0)

def blob(text):
    return git("hash-object", "-w", "--stdin", inp=text).strip()


def tree_with(base_tree, text):
    """base_tree plus CHANGELOG.md = text (a temporary index; the repo's own index is never touched)."""
    idx = os.path.join(git("rev-parse", "--git-dir").strip(), "sync-public.index")
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    if os.path.exists(idx):
        os.remove(idx)
    git("read-tree", base_tree, env=env)
    git("update-index", "--add", "--cacheinfo", f"100644,{blob(text)},CHANGELOG.md", env=env)
    t = git("write-tree", env=env).strip()
    os.remove(idx)
    return t


def render_entry(e, sha):
    text = scrub_text(e["notes"])
    url = cl.get("commitUrl", "").format(sha=sha)
    body = f"## {e.get('label', 'Update')}{(' ' + str(e['n'])) if e.get('label') is None else ''}: {scrub_text(e['title'])}\n\n{e['date']} (UTC)" + (f" - [commit {sha[:10]}]({url})" if url else "") + f"\n\n{text}\n"
    if FORBIDDEN.search(body):
        sys.exit(f"changelog entry for update {e['n']} contains a forbidden word: refusing to publish it")
    return body


def scrub_text(t):
    for old, rep_ in st.get("scrub", {}).items():
        t = re.sub(rf"\b{re.escape(old)}\b", rep_, t)
    return t


def add_entry(existing, entry):
    head, sep, rest = (existing or HEADER).partition("\n## ")
    head = head.rstrip("\n") + "\n"
    return head + "\n" + entry + ("\n## " + rest if sep else "")


entries = {}
for ep in ([cl["entries"]] if isinstance(cl.get("entries"), str) else cl.get("entries", [])):
    ep = os.path.expanduser(ep)
    if os.path.exists(ep):
        entries.update(json.load(open(ep)))
changelog = None
if cl:
    try:
        changelog = git("show", f"{st['publicSha']}:CHANGELOG.md")
    except subprocess.CalledProcessError:
        changelog = None
mapping = []
parent = st["publicSha"]
for c in new:
    tree, ad, msg = git("log", "-1", "--format=%T%x00%aD%x00%B", c).split("\x00", 2)
    if c in OVERRIDES:
        msg = OVERRIDES[c]
    msg = "\n".join(l for l in msg.splitlines() if not re.match(r"(?i)^co-authored[-]by:.*(claude|anthropic)", l))
    for old, rep in st.get("scrub", {}).items():
        msg = re.sub(rf"\b{re.escape(old)}\b", rep, msg)
    msg = msg.rstrip() + "\n"
    if FORBIDDEN.search(msg):
        sys.exit(f"the message of private commit {c[:12]} still contains a forbidden word after the scrub: refusing to publish (nothing pushed). "
                 f"The owner can set a public message for it in SYNC_MESSAGE_OVERRIDES")
    env = dict(os.environ, GIT_AUTHOR_NAME=st["name"], GIT_AUTHOR_EMAIL=st["email"], GIT_AUTHOR_DATE=ad,
               GIT_COMMITTER_NAME=st["name"], GIT_COMMITTER_EMAIL=st["email"])
    tree = scrub_tree(tree, c[:12])
    if cl and changelog:
        tree = tree_with(tree, changelog)
    parent = git("-c", "gpg.format=ssh", "-c", f"user.signingkey={key}", "commit-tree", "-S", tree, "-p", parent,
                 inp=msg, env=env).strip()
    print(f"{c[:8]} -> {parent[:8]}  {msg.splitlines()[0][:70]}")
    mapping.append((c, parent))
    if cl and c in entries:
        # the update's own commit first (tree = private tree + the CHANGELOG so far), then one commit with its entry
        changelog = add_entry(changelog, render_entry(entries[c], parent))
        e = entries[c]
        cmsg = f"docs(changelog): {('update ' + str(e['n'])) if e.get('label') is None else 'fix'}, {scrub_text(e['title'])}\n"
        parent = git("-c", "gpg.format=ssh", "-c", f"user.signingkey={key}", "commit-tree", "-S", tree_with(tree, changelog), "-p", parent,
                     inp=cmsg, env=env).strip()
        print(f"{c[:8]} -> {parent[:8]}  {cmsg.strip()}")
        mapping.append((c, parent))

if dry:
    print("dry run: not pushed")
    sys.exit(0)
with open(pending_path, "w") as f:  # the journal: what this push will make public main
    json.dump({"basePublicSha": st["publicSha"], "privateSha": new[-1], "publicSha": parent, "mapping": mapping}, f, indent=1)
    f.flush()
    os.fsync(f.fileno())
git("push", "-q", st["publicRemote"], f"{parent}:refs/heads/{branch}")
if os.environ.get("SYNC_CRASH_AFTER_PUSH") == "1" and os.environ.get("SANDBOX") == "1":
    os._exit(137)  # sandbox proof only: die between the push and the state write
save_state(mapping, new[-1], parent)
print(f"pushed {len(new)} commit(s); public {branch} = {parent[:12]}")
