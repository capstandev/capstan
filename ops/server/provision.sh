#!/bin/bash
# Provision the Capstan VPS (DECISIONS #20, #21; BACKLOG D1 to D3). Idempotent: every stage checks the host first and
# prints one line, "skip: <stage>" or "done: <stage>". A second run prints only "skip" lines.
#
# Owner, from the Mac (bash 3.2): copies ops/server to the host, then runs it there with sudo (asks for your sudo
# password on the server, nothing else):
#   /bin/bash ops/server/provision.sh <ssh-host-alias> [--egress-ip <server public IP>] [--domain capstan.finance]
# On the server (what the Mac step runs):
#   sudo /bin/bash /tmp/capstan-provision/server/provision.sh --local [--egress-ip IP] [--domain D]
#
# Stages: OS check, packages, Docker repo and engine, Bun 1.4.4 (checksum verified), Unix users (one per service),
# folders and modes, database password (made here, never printed), env files, server.conf, compose file, systemd
# units, sudo wrappers, sudoers, journald and logrotate retention, unattended upgrades, Caddyfile, firewall (22, 80,
# 443 only). It never touches a keystore: service keys are made later with make-service-key.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=ops/server/lib.sh
. "$here/lib.sh"

BUN_VERSION="1.4.4"
# sha256 of the official release zips (github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt, read 2026-11-06)
BUN_SHA256_X64="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c" # not-a-key
BUN_SHA256_ARM64="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e" # not-a-key
# Docker's apt signing key fingerprint (docs.docker.com/engine/install/debian)
DOCKER_KEY_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
PACKAGES="ca-certificates curl gnupg unzip git jq age ufw unattended-upgrades logrotate sudo caddy util-linux rsync"
DOCKER_PACKAGES="docker-ce docker-ce-cli containerd.io docker-compose-plugin"

usage() { die "usage: provision.sh <ssh-host-alias> [--egress-ip IP] [--domain DOMAIN] | --local [--egress-ip IP] [--domain DOMAIN]"; }

[ "$#" -ge 1 ] || usage
mode="$1"; shift
egress=""; domain=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --egress-ip) egress="${2:-}"; shift 2 ;;
    --domain) domain="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

# ---------------------------------------------------------------- Mac side: copy and run over ssh
if [ "$mode" != "--local" ]; then
  host="$mode"
  case "$host" in -*) usage ;; esac
  extra=""
  [ -n "$egress" ] && extra="$extra --egress-ip $egress"
  [ -n "$domain" ] && extra="$extra --domain $domain"
  say "stage: copy ops/server to $host:/tmp/capstan-provision"
  /usr/bin/tar -C "$here/.." -cf - server | /usr/bin/ssh "$host" '/bin/rm -rf /tmp/capstan-provision && /bin/mkdir -p /tmp/capstan-provision && /bin/tar -C /tmp/capstan-provision -xf -'
  say "stage: run provision on $host (sudo asks for your password on the server)"
  # shellcheck disable=SC2086
  /usr/bin/ssh -t "$host" "sudo /bin/bash /tmp/capstan-provision/server/provision.sh --local$extra"
  exit 0
fi

# ---------------------------------------------------------------- server side
require_root
changed=0
mark() { changed=$((changed + 1)); stage_done "$1"; }
LOGF="/var/log/capstan-provision.log"
quiet() { "$@" >> "$LOGF" 2>&1; }

# OS
if [ "${CAPSTAN_SKIP_OS_CHECK:-0}" != "1" ]; then
  . /etc/os-release
  [ "${ID:-}" = "debian" ] && [ "${VERSION_ID:-}" = "12" ] || die "Debian 12 expected, found ${ID:-?} ${VERSION_ID:-?}"
fi
stage_skip "os check (debian 12)"

missing_pkgs() {
  out=""
  for p in "$@"; do
    /usr/bin/dpkg-query -W -f='${Status}' "$p" 2>/dev/null | /bin/grep -q "install ok installed" || out="$out $p"
  done
  printf '%s' "$out"
}

# packages
m=$(missing_pkgs $PACKAGES)
if [ -z "$m" ]; then stage_skip "packages"; else
  export DEBIAN_FRONTEND=noninteractive
  quiet /usr/bin/apt-get update
  # shellcheck disable=SC2086
  quiet /usr/bin/apt-get install -y --no-install-recommends $m
  mark "packages ($m )"
fi

# Docker engine from Docker's own repository, key checked by fingerprint
arch="$(/usr/bin/dpkg --print-architecture)"
src="/etc/apt/sources.list.d/docker.list"
want_src="deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable"
if [ -f /etc/apt/keyrings/docker.asc ] && [ "$(/bin/cat "$src" 2>/dev/null)" = "$want_src" ]; then stage_skip "docker repo"; else
  /bin/mkdir -p /etc/apt/keyrings
  tmpk="$(/bin/mktemp)"
  /usr/bin/curl -fsSL https://download.docker.com/linux/debian/gpg -o "$tmpk"
  fpr="$(/usr/bin/gpg --show-keys --with-colons "$tmpk" 2>/dev/null | /usr/bin/awk -F: '$1 == "fpr" { print $10; exit }')"
  [ "$fpr" = "$DOCKER_KEY_FPR" ] || { /bin/rm -f "$tmpk"; die "docker key fingerprint mismatch: $fpr"; }
  /bin/mv "$tmpk" /etc/apt/keyrings/docker.asc
  /bin/chmod 0644 /etc/apt/keyrings/docker.asc
  printf '%s\n' "$want_src" > "$src"
  quiet /usr/bin/apt-get update
  mark "docker repo"
fi
m=$(missing_pkgs $DOCKER_PACKAGES)
if [ -z "$m" ]; then stage_skip "docker engine"; else
  export DEBIAN_FRONTEND=noninteractive
  # shellcheck disable=SC2086
  quiet /usr/bin/apt-get install -y --no-install-recommends $m
  mark "docker engine"
fi

# Bun, pinned and checksum verified
if [ -x /usr/local/bin/bun ] && [ "$(/usr/local/bin/bun --version 2>/dev/null)" = "$BUN_VERSION" ]; then stage_skip "bun $BUN_VERSION"; else
  case "$arch" in
    amd64) zip="bun-linux-x64.zip"; sum="$BUN_SHA256_X64"; dir="bun-linux-x64" ;;
    arm64) zip="bun-linux-aarch64.zip"; sum="$BUN_SHA256_ARM64"; dir="bun-linux-aarch64" ;;
    *) die "no bun build for $arch" ;;
  esac
  tmpd="$(/bin/mktemp -d)"
  /usr/bin/curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$zip" -o "$tmpd/$zip"
  got="$(/usr/bin/sha256sum "$tmpd/$zip" | /usr/bin/awk '{ print $1 }')"
  [ "$got" = "$sum" ] || { /bin/rm -rf "$tmpd"; die "bun checksum mismatch"; }
  quiet /usr/bin/unzip -o "$tmpd/$zip" -d "$tmpd"
  /bin/mkdir -p "/opt/bun/$BUN_VERSION"
  /usr/bin/install -m 0755 "$tmpd/$dir/bun" "/opt/bun/$BUN_VERSION/bun"
  /bin/ln -sfn "/opt/bun/$BUN_VERSION/bun" /usr/local/bin/bun
  /bin/rm -rf "$tmpd"
  mark "bun $BUN_VERSION"
fi

# Unix users: one per service, no login shell, no home directory content
n=0
for s in $CAPSTAN_SERVICES; do
  u="capstan-$s"
  if ! /usr/bin/getent passwd "$u" >/dev/null; then
    /usr/sbin/useradd --system --user-group --no-create-home --home-dir "/var/lib/capstan/$s" --shell /usr/sbin/nologin "$u"
    n=$((n + 1))
  fi
done
/usr/bin/getent group capstan-ops >/dev/null || { /usr/sbin/groupadd --system capstan-ops; n=$((n + 1)); }
if [ "$n" -eq 0 ]; then stage_skip "unix users"; else mark "unix users ($n created)"; fi

# folders and modes
n=0
fix_dir() { # path mode owner:group
  if [ -d "$1" ] && [ "$(stat_mode "$1")" = "$2" ] && [ "$(stat_owner "$1")" = "$3" ]; then return 0; fi
  /bin/mkdir -p "$1"; /bin/chmod "$2" "$1"; /bin/chown "$3" "$1"; n=$((n + 1))
}
fix_dir "$CAPSTAN_ETC" 755 root:root
fix_dir "$CAPSTAN_ETC/db" 700 root:root
fix_dir "$CAPSTAN_LOG" 755 root:root
fix_dir "$CAPSTAN_LOG/ops" 750 root:root
fix_dir "$CAPSTAN_OPT" 755 root:root
fix_dir "$CAPSTAN_OPT/releases" 755 root:root
fix_dir "$CAPSTAN_OPT/compose" 755 root:root
fix_dir "$CAPSTAN_BACKUPS" 700 root:root
fix_dir /var/lib/capstan 755 root:root
for s in $CAPSTAN_SERVICES; do
  fix_dir "$CAPSTAN_ETC/$s" 750 "root:capstan-$s"
  fix_dir "$CAPSTAN_LOG/$s" 750 "capstan-$s:capstan-$s"
done
if /usr/bin/getent passwd caddy >/dev/null; then fix_dir "$CAPSTAN_LOG/caddy" 750 caddy:caddy; fi
if [ "$n" -eq 0 ]; then stage_skip "folders"; else mark "folders ($n fixed)"; fi

# database password: made here, 0600 root, never printed
if [ -s "$CAPSTAN_ETC/db/password" ]; then stage_skip "database password"; else
  (umask 077 && /usr/bin/head -c 48 /dev/urandom | /usr/bin/base64 | /usr/bin/tr -dc 'A-Za-z0-9' | /usr/bin/head -c 40 > "$CAPSTAN_ETC/db/password")
  /bin/chmod 600 "$CAPSTAN_ETC/db/password"
  mark "database password"
fi
[ -f "$CAPSTAN_ETC/db/env" ] || { (umask 077 && : > "$CAPSTAN_ETC/db/env"); }

# server.conf (owner-edited; RELAY_EGRESS_IP changes only through capstan-config with the re-approval flag)
if [ -f "$CAPSTAN_SERVER_CONF" ]; then stage_skip "server.conf"; else
  (umask 077 && printf '%s\n' "# Capstan server settings. Edit with: sudo /usr/local/sbin/capstan-config set KEY VALUE" \
    "DOMAIN=" "ACME_EMAIL=" "RELAY_EGRESS_IP=" "REPO_URL=" "AGE_RECIPIENT=" "BACKUP_OFFBOX=" > "$CAPSTAN_SERVER_CONF")
  mark "server.conf"
fi
if [ -n "$egress" ]; then
  cur="$(conf_get RELAY_EGRESS_IP)"
  if [ "$cur" = "$egress" ]; then stage_skip "relay egress ip"; else
    CAPSTAN_QUIET=1 /bin/bash "$here/config.sh" set RELAY_EGRESS_IP "$egress"
    mark "relay egress ip"
  fi
fi
if [ -n "$domain" ]; then
  if [ "$(conf_get DOMAIN)" = "$domain" ]; then stage_skip "domain"; else conf_set DOMAIN "$domain" "$CAPSTAN_SERVER_CONF"; mark "domain"; fi
fi

# env files: written once, then the owner's edits are kept
n=0
dbpw="$(/bin/cat "$CAPSTAN_ETC/db/password")"
dom="$(conf_get DOMAIN)"
apihost="localhost:8710"; [ -n "$dom" ] && apihost="api.$dom"
eip="$(conf_get RELAY_EGRESS_IP)"
for s in $CAPSTAN_SERVICES; do
  f="$CAPSTAN_ETC/$s/env"
  if [ -f "$f" ]; then continue; fi
  (umask 027 && /bin/sed -e "s|@DB_PASSWORD@|$dbpw|" -e "s|@API_HOST@|$apihost|" -e "s|@RELAY_EGRESS_IP@|$eip|" "$here/etc/$s.env" > "$f")
  /bin/chmod 640 "$f"; /bin/chown "root:capstan-$s" "$f"
  n=$((n + 1))
done
dbpw=""
if [ "$n" -eq 0 ]; then stage_skip "env files"; else mark "env files ($n written)"; fi

# compose file
if same_content "$here/capstan-compose.yaml" "$CAPSTAN_OPT/compose/capstan-compose.yaml"; then stage_skip "compose file"; else
  /usr/bin/install -m 0644 -o root -g root "$here/capstan-compose.yaml" "$CAPSTAN_OPT/compose/capstan-compose.yaml"
  mark "compose file"
fi

# systemd units
n=0
for u in "$here"/systemd/*; do
  d="/etc/systemd/system/$(basename "$u")"
  if same_content "$u" "$d"; then continue; fi
  /usr/bin/install -m 0644 -o root -g root "$u" "$d"; n=$((n + 1))
done
if [ "$n" -eq 0 ]; then stage_skip "systemd units"; else mark "systemd units ($n installed)"; fi
if [ -d /run/systemd/system ]; then
  if [ "$n" -gt 0 ]; then /bin/systemctl daemon-reload; fi
  en=0
  for u in capstan-db.service capstan-api.service capstan-ws.service capstan-relay.service capstan-mcp.service capstan-facilitator.service capstan-workers.target capstan-workers.service capstan-anchor.service capstan-receipts.service capstan-backup.timer; do
    /bin/systemctl is-enabled --quiet "$u" 2>/dev/null || { /bin/systemctl enable --quiet "$u"; en=$((en + 1)); }
  done
  if [ "$en" -eq 0 ]; then stage_skip "enable units"; else mark "enable units ($en)"; fi
else
  stage_skip "enable units (systemd not running here)"
fi

# narrow sudo wrappers and their shared library
n=0
put() { # src dst mode
  if same_content "$1" "$2" && [ "$(stat_mode "$2")" = "$3" ]; then return 0; fi
  /bin/mkdir -p "$(dirname "$2")"
  /usr/bin/install -m "0$3" -o root -g root "$1" "$2"; n=$((n + 1))
}
put "$here/lib.sh" /usr/local/lib/capstan/lib.sh 644
put "$here/deploy.sh" /usr/local/sbin/capstan-deploy 755
put "$here/relay-flag.sh" /usr/local/sbin/capstan-relay-flag 755
put "$here/status.sh" /usr/local/sbin/capstan-status 755
put "$here/backup.sh" /usr/local/sbin/capstan-backup 755
put "$here/config.sh" /usr/local/sbin/capstan-config 755
put "$here/restore-test.sh" /usr/local/sbin/capstan-restore-test 755
for e in "$here"/etc/*.env; do put "$e" "/usr/local/lib/capstan/env/$(basename "$e")" 644; done
if [ "$n" -eq 0 ]; then stage_skip "sudo wrappers"; else mark "sudo wrappers ($n installed)"; fi

# sudoers: members of capstan-ops may run only the wrappers, without a password
sud="$(/bin/mktemp)"
printf '%s\n' "# Capstan narrow sudo wrappers (ops/server/provision.sh). Nothing else." \
  "%capstan-ops ALL=(root) NOPASSWD: /usr/local/sbin/capstan-deploy, /usr/local/sbin/capstan-relay-flag, /usr/local/sbin/capstan-status" > "$sud"
if same_content "$sud" /etc/sudoers.d/capstan; then stage_skip "sudoers"; /bin/rm -f "$sud"; else
  /usr/sbin/visudo -cqf "$sud" || { /bin/rm -f "$sud"; die "sudoers file invalid"; }
  /usr/bin/install -m 0440 -o root -g root "$sud" /etc/sudoers.d/capstan; /bin/rm -f "$sud"
  mark "sudoers"
fi

# log retention outside the app: journald 7 days, logrotate daily for 14 days (the log-retention job strips IPs after 7)
tmpj="$(/bin/mktemp)"
printf '%s\n' "# Capstan: no journal entry older than 7 days (IP retention, spec 14)" "[Journal]" "MaxRetentionSec=7day" > "$tmpj"
tmpl="$(/bin/mktemp)"
printf '%s\n' "/var/log/capstan/*/*.jsonl {" "  daily" "  rotate 14" "  dateext" "  dateformat -%Y%m%d" "  missingok" "  notifempty" "  copytruncate" "  compress" "  delaycompress" "}" > "$tmpl"
n=0
if ! same_content "$tmpj" /etc/systemd/journald.conf.d/capstan.conf; then /bin/mkdir -p /etc/systemd/journald.conf.d; /usr/bin/install -m 0644 "$tmpj" /etc/systemd/journald.conf.d/capstan.conf; n=$((n + 1)); fi
if ! same_content "$tmpl" /etc/logrotate.d/capstan; then /usr/bin/install -m 0644 "$tmpl" /etc/logrotate.d/capstan; n=$((n + 1)); fi
/bin/rm -f "$tmpj" "$tmpl"
if [ "$n" -eq 0 ]; then stage_skip "log retention"; else mark "log retention"; fi

# unattended upgrades
tmpu="$(/bin/mktemp)"
printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > "$tmpu"
if same_content "$tmpu" /etc/apt/apt.conf.d/20auto-upgrades; then stage_skip "unattended upgrades"; else
  /usr/bin/install -m 0644 "$tmpu" /etc/apt/apt.conf.d/20auto-upgrades; mark "unattended upgrades"
fi
/bin/rm -f "$tmpu"

# Caddyfile (needs DOMAIN and ACME_EMAIL in server.conf)
dom="$(conf_get DOMAIN)"; mail="$(conf_get ACME_EMAIL)"
if [ -z "$dom" ] || [ -z "$mail" ]; then stage_skip "caddyfile (DOMAIN or ACME_EMAIL not set)"; else
  tmpc="$(/bin/mktemp)"
  /bin/sed -e "s|@DOMAIN@|$dom|g" -e "s|@ACME_EMAIL@|$mail|g" "$here/Caddyfile.tmpl" > "$tmpc"
  if same_content "$tmpc" /etc/caddy/Caddyfile; then stage_skip "caddyfile"; else
    /usr/bin/install -m 0644 "$tmpc" /etc/caddy/Caddyfile
    if [ -d /run/systemd/system ]; then /bin/systemctl reload-or-restart caddy; fi
    mark "caddyfile"
  fi
  /bin/rm -f "$tmpc"
fi

# firewall: deny incoming except 22, 80, 443 (Postgres and Redis bind 127.0.0.1 only, see capstan-compose.yaml)
fw_ok() {
  st="$(/usr/sbin/ufw status verbose 2>/dev/null || true)"
  printf '%s\n' "$st" | /bin/grep -q "^Status: active" || return 1
  printf '%s\n' "$st" | /bin/grep -q "Default: deny (incoming)" || return 1
  for p in 22 80 443; do printf '%s\n' "$st" | /bin/grep -qE "^$p/tcp +ALLOW IN +Anywhere" || return 1; done
  extra="$(printf '%s\n' "$st" | /bin/grep -E "ALLOW IN" | /bin/grep -vE "^(22|80|443)/tcp( \(v6\))? +ALLOW IN" || true)"
  [ -z "$extra" ]
}
if fw_ok; then stage_skip "firewall (22, 80, 443)"; else
  quiet /usr/sbin/ufw default deny incoming
  quiet /usr/sbin/ufw default allow outgoing
  for p in 22 80 443; do quiet /usr/sbin/ufw allow "$p/tcp"; done
  quiet /usr/sbin/ufw --force enable
  fw_ok || die "firewall is not in the expected state (see /usr/sbin/ufw status verbose)"
  mark "firewall (22, 80, 443)"
fi

if [ "$changed" -eq 0 ]; then stage_skip "provision (nothing changed)"; else say "done: provision ($changed stages changed)"; fi
