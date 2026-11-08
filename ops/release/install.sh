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
run systemctl daemon-reload
run systemctl disable capstan-release.timer
rm -f "$D/etc/capstan-release/ALLOW_REAL_DEPLOY"
echo "install: done. Timer disabled, not armed. Next: edit release.conf, build the schedule, stress test, then arm.sh."
