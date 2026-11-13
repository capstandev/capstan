#!/bin/bash
# The installer leaves the runner unarmed: timer disabled, no flag, config kept on a re-run.
. "$(dirname "$0")/lib.sh"

t_installs_unarmed_and_idempotent() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/root/etc/capstan-release"; : > "$T/root/etc/capstan-release/ALLOW_REAL_DEPLOY"
  DESTDIR="$T/root" /bin/bash "$T_ROOT/install.sh" > /dev/null
  assert_file "$T/root/opt/capstan-release/bin/release-pass.sh"; assert_file "$T/root/etc/systemd/system/capstan-release.timer"
  assert_file "$T/root/opt/capstan-release/bin/public-sync.sh"; assert_file "$T/root/opt/capstan-release/lib/sync-public.py"
  assert_contains "$(cat "$T/root/install-actions.log")" "chown root:capstan-release /etc/capstan-release/public"
  assert_contains "$(cat "$T/root/etc/capstan-release/release.conf")" "PUBLIC_SYNC_CMD=/opt/capstan-release/bin/public-sync.sh"
  assert_no_file "$T/root/etc/capstan-release/ALLOW_REAL_DEPLOY"
  assert_contains "$(cat "$T/root/install-actions.log")" "systemctl disable capstan-release.timer"
  assert_not_contains "$(cat "$T/root/install-actions.log")" "enable" "never enables the timer"
  echo "OWNER_TZ=Asia/Dubai" >> "$T/root/etc/capstan-release/release.conf"
  DESTDIR="$T/root" /bin/bash "$T_ROOT/install.sh" > /dev/null
  assert_contains "$(cat "$T/root/etc/capstan-release/release.conf")" "OWNER_TZ=Asia/Dubai" "config kept"
}

t_units_carry_the_guards() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
  u=$(cat "$T_ROOT/systemd/capstan-release.service")
  assert_contains "$u" "Environment=CAPSTAN_RELEASE_RUNNER=1"; assert_contains "$u" "UMask=0022"; assert_contains "$u" "User=capstan-release"
  assert_contains "$(cat "$T_ROOT/systemd/capstan-release.timer")" "OnUnitInactiveSec=1min"
  assert_not_contains "$(cat "$T_ROOT/sudoers/capstan-release")" "ALL=(ALL)" "no broad sudo"
}

# Every root wrapper named in sudoers and release.conf is installed, names the config (sudo drops the environment),
# and the ones that touch the work checkout run as the runner user (found by the container sandbox: a fresh install
# had none, so every alert, team post and Release failed with "command not found").
t_installs_the_sudo_wrappers() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
  DESTDIR="$T/root" /bin/bash "$T_ROOT/install.sh" > /dev/null
  for w in $(grep -oE '/usr/local/sbin/capstan-release-[a-z]+' "$T_ROOT/sudoers/capstan-release" "$T_ROOT/etc/release.conf.example" | cut -d: -f2 | sort -u); do
    [ -x "$T/root$w" ] || fail "wrapper $w not installed"
    assert_contains "$(cat "$T/root$w")" "RR_CONF=/etc/capstan-release/release.conf" "$w names the config"
  done
  assert_contains "$(cat "$T/root/usr/local/sbin/capstan-release-preflight")" "runuser -u capstan-release" "preflight runs as the runner"
  assert_contains "$(cat "$T/root/usr/local/sbin/capstan-release-retry")" "runuser -u capstan-release" "retry runs as the runner"
}

run_tests "$0"
