#!/bin/sh
# PID 1 of the stand-in: moves itself out of the container's root cgroup and delegates the cgroup controllers before
# systemd starts (as moby's dind entrypoint does). A VM's systemd has them at boot; without this, a process in the
# nested root cgroup (any `docker exec`) blocks them, and the TimescaleDB image's tune script panics on first init.
set -e
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init.scope
  echo $$ > /sys/fs/cgroup/init.scope/cgroup.procs
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi
exec /sbin/init
