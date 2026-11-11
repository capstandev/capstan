# Public copy (capstandev/capstan)

The public repo only receives copies of this repo's main: each first-parent commit becomes one commit with the same
tree and message, authored and signed by capstandev. Nothing is ever committed on the public repo directly.

- `sync-public.py <state.json> [--dry-run | --reconcile]`: the copy itself. It refuses (and pushes nothing) when a
  message or any file in any copied tree still holds a forbidden word after the scrub rules.
- `publish-public.sh`: run once by the owner. Creates the repo private with the About text, bootstraps it with one
  signed empty commit, copies the whole history, checks it, then flips it to public and applies the settings.
- `publish-public-update.sh`: copies new commits. Safe to rerun; prints "nothing to sync" when current.
- `lib.sh`: shared stages. Works on macOS bash 3.2.
- `state.example.json`: the shape of the state file. The real one (with the forbidden words and scrub rules) lives
  outside this repo, because those words must never be in it.

Tests:

    python3 ops/public/test/test-sync-public-scrub.py
    ABOUT_FILE=<about md> bash ops/public/test/prove-local.sh <state template> <private repo> [work dir]

`prove-local.sh` touches no network: a local bare repo stands in for the public remote, a stub stands in for gh and a
throwaway key signs.
