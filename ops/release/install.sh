#!/bin/bash
# Install the release runner on the server, idempotent, with the timers (runner and watchdog) DISABLED and no
# real-deploy flag (arm.sh does both on launch day). Run as root. DESTDIR=<dir> installs into a scratch root for tests and dry runs (no users, no
# systemctl, no visudo).
# Usage: [DESTDIR=/tmp/x] bash install.sh
set -u
src="$(cd "$(dirname "$0")" && pwd -P)"
D="${DESTDIR:-}"
run() { if [ -n "$D" ]; then echo "would run: $*" >> "$D/install-actions.log"; else "$@"; fi; }
if [ -z "$D" ] && [ "$(id -u)" != "0" ]; then echo "install: run as root (or set DESTDIR for a dry run)" >&2; exit 1; fi
umask 022
mkdir -p "$D/opt/capstan-release" "$D/etc/capstan-release" "$D/var/lib/capstan-release/log" "$D/etc/systemd/system" "$D/etc/sudoers.d"
rm -rf "$D/opt/capstan-release/bin" "$D/opt/capstan-release/lib"
cp -R "$src/bin" "$src/lib" "$D/opt/capstan-release/"
chmod 0755 "$D/opt/capstan-release/bin/"*.sh
# The public copy tool (PUBLIC_SYNC_CMD = bin/public-sync.sh runs it): a root-owned copy, so an update in the queue
# never changes the tool that publishes it. Its state (with the forbidden words) and the keys are set up by hand.
[ -f "$src/../public/sync-public.py" ] || { echo "install: ops/public/sync-public.py not found next to ops/release" >&2; exit 1; }
install -m 0644 "$src/../public/sync-public.py" "$D/opt/capstan-release/lib/sync-public.py"
mkdir -p "$D/etc/capstan-release/public"
[ -f "$D/etc/capstan-release/release.conf" ] || cp "$src/etc/release.conf.example" "$D/etc/capstan-release/release.conf"
cp "$src/systemd/capstan-release.service" "$src/systemd/capstan-release.timer" \
  "$src/systemd/capstan-release-watchdog.service" "$src/systemd/capstan-release-watchdog.timer" "$D/etc/systemd/system/"
if id capstan-release >/dev/null 2>&1 || [ -n "$D" ]; then :; else run useradd --system --home-dir /var/lib/capstan-release --shell /usr/sbin/nologin capstan-release; fi
run chown -R capstan-release:capstan-release /var/lib/capstan-release
# The deploy source (LOCAL_DEPLOY_REMOTE, the bare repo capstan-deploy fetches): the runner pushes each released sha
# there. It stays root-owned; the capstan-release group may write objects/ and refs/ only (setgid, sharedRepository
# group, so the Mac's pushes as root stay group-writable). The top folder, config and hooks/ stay root-only: a hook or
# config the runner could write would run as root on the next push from the Mac. "Other" bits are left as they are.
share_deploy_source() { # share_deploy_source /srv/capstan-src.git
  local r="$1" p="$D$1" d
  case "$r" in /*) ;; *) echo "install: LOCAL_DEPLOY_REMOTE must be an absolute path ($r)" >&2; exit 1 ;; esac
  if [ ! -d "$p" ]; then
    if [ -n "$D" ]; then echo "would run: git init --bare $r" >> "$D/install-actions.log"; return 0; fi
    git init -q --bare "$r" || { echo "install: could not create $r" >&2; exit 1; }
  fi
  [ "$(git --git-dir="$p" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] || { echo "install: $r is not a bare git repo" >&2; exit 1; }
  git --git-dir="$p" config core.sharedRepository group
  git --git-dir="$p" config receive.denyNonFastForwards true
  git --git-dir="$p" config receive.denyDeletes true
  git --git-dir="$p" config receive.autogc false
  run chgrp -R capstan-release "$r"
  for d in objects refs; do
    mkdir -p "$p/$d"; chmod -R g+rwX "$p/$d"; find "$p/$d" -type d -exec chmod g+s {} +
  done
  chmod g-w "$p" "$p/config"; [ -d "$p/hooks" ] && chmod -R g-w "$p/hooks"
  return 0
}
dsrc=$(grep -E '^LOCAL_DEPLOY_REMOTE=' "$D/etc/capstan-release/release.conf" | tail -n 1 | cut -d= -f2-)
if [ -n "$dsrc" ]; then share_deploy_source "$dsrc"
else echo "install: LOCAL_DEPLOY_REMOTE is not set in release.conf; the runner will refuse to deploy until it is" >&2; fi
# /etc/capstan-release/public: the public sync state and keys, root-owned, readable by the runner group only
run chown root:capstan-release /etc/capstan-release/public
run chmod 0750 /etc/capstan-release/public
if [ -n "$D" ]; then cp "$src/sudoers/capstan-release" "$D/etc/sudoers.d/capstan-release"
else
  visudo -cf "$src/sudoers/capstan-release" || { echo "install: sudoers file refused by visudo; nothing installed there" >&2; exit 1; }
  install -m 0440 "$src/sudoers/capstan-release" /etc/sudoers.d/capstan-release
  visudo -c || { rm -f /etc/sudoers.d/capstan-release; echo "install: visudo -c failed; sudoers file removed" >&2; exit 1; }
fi
# Root wrappers named in sudoers and release.conf: sudo drops the environment, so each one names the config itself.
# Owner commands that touch the work checkout (preflight, retry) run as the runner user: git refuses a repository
# another user owns, and root-owned files there would break the next pass.
mkdir -p "$D/usr/local/sbin"
wrap() { # wrap <name> <script> <as: root|runner>
  local f="$D/usr/local/sbin/$1" ex="exec /opt/capstan-release/bin/$2"
  [ "$3" = runner ] && ex="exec /usr/sbin/runuser -u capstan-release -- /usr/bin/env RR_CONF=/etc/capstan-release/release.conf /opt/capstan-release/bin/$2"
  printf '#!/bin/bash\n# Installed by ops/release/install.sh; edits are overwritten.\nexport RR_CONF=/etc/capstan-release/release.conf\n%s "$@"\n' "$ex" > "$f"
  chmod 0755 "$f"
}
wrap capstan-release-notify notify-telegram.sh root
wrap capstan-release-announce announce-telegram.sh root
wrap capstan-release-ghrelease ghrelease.sh root
wrap capstan-release-status status.sh root
wrap capstan-release-pause pause.sh root
wrap capstan-release-resume unpause.sh root
wrap capstan-release-retry retry.sh runner
wrap capstan-release-preflight preflight.sh runner
run systemctl daemon-reload
run systemctl disable capstan-release.timer capstan-release-watchdog.timer
rm -f "$D/etc/capstan-release/ALLOW_REAL_DEPLOY"
echo "install: done. Timer disabled, not armed. Next: edit release.conf, build the schedule, stress test, then arm.sh."
