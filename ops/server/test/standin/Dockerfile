# Stand-in for the Capstan VPS: Debian 12 (the OS provision.sh checks for) booting real systemd as PID 1.
# Only what a fresh cloud image already has, plus the stand-in's own test tools (expect, Foundry's cast for the
# service keys). provision.sh installs everything else itself. Built and removed by run.sh.
FROM debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8

ENV container=docker
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv dbus sudo openssh-client ca-certificates curl gnupg iproute2 procps expect cron \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-firewalld.service >/dev/null 2>&1 || true
# Foundry 1.8.4 cast (release tarball, sha256 pinned on 2026-11-11), used only by make-service-key.sh
RUN set -e; arch="$(dpkg --print-architecture)"; case "$arch" in \
      arm64) sum=d998f88314c057dc37c1de9a2044f49b273505965ff94bea5c3c5aefa9d1debd ;; \
      amd64) sum=699e2207a6a9b27ca17c48c81e56f1677ed9c58b623b59128b4e15ec9da0625e ;; \
      *) echo "no foundry build for $arch"; exit 1 ;; esac; \
    curl -fsSL -o /tmp/f.tgz "https://github.com/foundry-rs/foundry/releases/download/v1.8.4/foundry_v1.8.4_linux_$arch.tar.gz"; \
    echo "$sum  /tmp/f.tgz" | sha256sum -c -; \
    mkdir -p /root/.foundry/bin; tar -xzf /tmp/f.tgz -C /root/.foundry/bin cast; rm -f /tmp/f.tgz
COPY init.sh /usr/local/sbin/standin-init
RUN chmod 0755 /usr/local/sbin/standin-init
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/local/sbin/standin-init"]
