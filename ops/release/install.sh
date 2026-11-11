#!/bin/bash
# Install the release runner on the server, idempotent, with the timer DISABLED and no real-deploy flag (arm.sh does
# both on launch day). Run as root. DESTDIR=<dir> installs into a scratch root for tests and dry runs (no users, no
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
[ -f "$D/etc/capstan-release/release.conf" ] || cp "$src/etc/release.conf.example" "$D/etc/capstan-release/release.conf"
cp "$src/systemd/capstan-release.service" "$src/systemd/capstan-release.timer" "$D/etc/systemd/system/"
if id capstan-release >/dev/null 2>&1 || [ -n "$D" ]; then :; else run useradd --system --home-dir /var/lib/capstan-release --shell /usr/sbin/nologin capstan-release; fi
run chown -R capstan-release:capstan-release /var/lib/capstan-release
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
run systemctl disable capstan-release.timer
rm -f "$D/etc/capstan-release/ALLOW_REAL_DEPLOY"
echo "install: done. Timer disabled, not armed. Next: edit release.conf, build the schedule, stress test, then arm.sh."
