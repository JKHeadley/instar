#!/bin/bash
# The in-sandbox half of the start-up checks (docs/specs/local-verify-borrowed-unit-slices.md, B2
# "Checks"; docs/specs/local-verify-borrowed-slices-count.md, B2 amended and "Tests", sandbox property).
# Installed at /usr/local/sbin/instar-helper-checks (root:root 0755), run as root by the owner
# service at every sandbox start through `instar-helper-runner checks …`. Prints one line per check:
#   CHECK <name> <pass|fail> [detail]
# The host side (src/localVerify/helper/runnerDriverBase.ts) adds the configuration checks, the probe
# listeners' positive controls and the no-forwarding probes, and treats any check missing from this
# output as unrunnable (refuse: helper-containment-unproven).
#
# NEVER run on a Local Verify machine.
set -uo pipefail

RUNNER=/usr/local/sbin/instar-helper-runner
BUILDER_UID=61001
TESTER_UID=61002
PROBE=/usr/local/lib/instar-helper/property-probe.cjs
HOST_LOOP_PORT=0; HOST_ANY_PORT=0; IFACE_ADDR=none; IFACE_PORT=0; TAILNET_ADDR=none; TAILNET_PORT=0
MARKER=""; OWNER_USER=none; DIGESTS=none; FWD_PORTS=""; WSL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host-loopback-port) HOST_LOOP_PORT="$2"; shift 2 ;;
    --host-any-port) HOST_ANY_PORT="$2"; shift 2 ;;
    --host-iface-addr) IFACE_ADDR="$2"; shift 2 ;;
    --host-iface-port) IFACE_PORT="$2"; shift 2 ;;
    --host-tailnet-addr) TAILNET_ADDR="$2"; shift 2 ;;
    --host-tailnet-port) TAILNET_PORT="$2"; shift 2 ;;
    --owner-marker) MARKER="$2"; shift 2 ;;
    --owner-user) OWNER_USER="$2"; shift 2 ;;
    --credential-digests) DIGESTS="$2"; shift 2 ;;
    --forward-probe-ports) FWD_PORTS="$2"; shift 2 ;;
    --wsl) WSL=1; shift ;;
    *) shift ;;
  esac
done

check() { if [ "$2" = 0 ]; then echo "CHECK $1 pass${3:+ $3}"; else echo "CHECK $1 fail${3:+ $3}"; fi; }
# Exit 0 when a TCP connection to $1:$2 succeeds within 2 s.
CONNECT='const [h,p]=process.argv.slice(1);const s=require("net").connect({host:h,port:+p,timeout:2000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));'
in_testns() { "$RUNNER" ns-exec testns "$TESTER_UID" -- "$@" >/dev/null 2>&1; }
in_builder() { "$RUNNER" ns-exec builderview "$BUILDER_UID" -- "$@" >/dev/null 2>&1; }
gateway="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"

# Mounts: no host file system inside, and the owner's marker file is not visible.
if grep -Eq ' (virtiofs|9p|fuse\.sshfs|sshfs|drvfs) ' /proc/mounts; then check proc-mounts-clean 1 "$(grep -Eo ' (virtiofs|9p|fuse\.sshfs|sshfs|drvfs) ' /proc/mounts | head -1)"; else check proc-mounts-clean 0; fi
if [ -n "$MARKER" ] && timeout 60 find / -xdev -name "$MARKER" -print -quit 2>/dev/null | grep -q .; then check owner-marker-invisible 1; else check owner-marker-invisible 0; fi

# Network, inside a test namespace: no route to the host, the LAN, the tailnet or IPv6; own loopback works.
in_testns node -e "$CONNECT" 127.0.0.1 "$HOST_LOOP_PORT"; a=$?
if [ -n "$gateway" ]; then in_testns node -e "$CONNECT" "$gateway" "$HOST_LOOP_PORT"; b=$?; else b=1; fi
[ $a -ne 0 ] && [ $b -ne 0 ]; check testns-no-route-host-loopback $? "loop=$a gw=$b"
# The host's interface toward the sandbox: a one-shot host listener on every interface, reached via the gateway.
if [ -n "$gateway" ]; then in_testns node -e "$CONNECT" "$gateway" "$HOST_ANY_PORT"; r=$?; else r=1; fi
[ $r -ne 0 ]; check testns-no-route-host-iface $?
if [ "$IFACE_ADDR" != none ]; then in_testns node -e "$CONNECT" "$IFACE_ADDR" "$IFACE_PORT"; r=$?; else r=0; fi
[ $r -ne 0 ] && [ "$IFACE_ADDR" != none ]; check testns-no-route-lan $?
[ "$WSL" = 1 ] && { [ $r -ne 0 ] && [ "$IFACE_ADDR" != none ]; check testns-no-route-echo-distro $?; }
# The paired test's sandbox half (B2, amended): a listener the helper service just opened on the
# host's TAILNET address must not answer from inside a test namespace. The host reports this check
# only beside that listener answering from the host side; with no tailnet address it is not reported.
if [ "$TAILNET_ADDR" != none ]; then in_testns node -e "$CONNECT" "$TAILNET_ADDR" "$TAILNET_PORT"; r=$?; [ $r -ne 0 ]; check testns-no-route-tailnet-listener $?; fi
# The dummy interface: present with its private address, as tests see it; and nothing is a default route.
in_testns node -e 'const a=(require("os").networkInterfaces().dummy0||[]).find(x=>x.family==="IPv4");process.exit(a&&a.address==="10.77.0.2"&&a.netmask==="255.255.255.0"&&!a.internal?0:1)'
check testns-dummy-iface-present $?
# `ip` prints a line for each default route and nothing when there is none; its own error text
# (a missing tool, a refused netlink read) is output too, so anything but silence fails the check.
in_testns bash -c 'IP="$(PATH=/usr/sbin:/usr/bin:/sbin:/bin command -v ip)" && [ -n "$IP" ] && [ -z "$("$IP" -4 route show default 2>&1)" ] && [ -z "$("$IP" -6 route show default 2>&1)" ]'
check testns-no-default-route $?
in_testns node -e "$CONNECT" 2606:4700:4700::1111 443; r=$?; [ $r -ne 0 ]; check testns-no-route-ipv6 $?
in_testns node -e 'const n=require("net");const s=n.createServer(c=>c.end("ok")).listen(0,"127.0.0.1",()=>{n.connect(s.address().port,"127.0.0.1").on("data",()=>process.exit(0)).on("error",()=>process.exit(1))});setTimeout(()=>process.exit(1),3000)'
check testns-own-loopback-works $?

# Network, as builder in the shared namespace: blocked except DNS and 443; the drop counter rises.
drops() { nft list counter inet instar_helper builder_drop 2>/dev/null | grep -Eo 'packets [0-9]+' | grep -Eo '[0-9]+' || echo 0; }
before="$(drops)"
blocked=0
in_builder node -e "$CONNECT" 127.0.0.1 "$HOST_LOOP_PORT" && blocked=1
[ -n "$gateway" ] && in_builder node -e "$CONNECT" "$gateway" "$HOST_LOOP_PORT" && blocked=1
[ -n "$gateway" ] && in_builder node -e "$CONNECT" "$gateway" "$HOST_ANY_PORT" && blocked=1
[ "$IFACE_ADDR" != none ] && in_builder node -e "$CONNECT" "$IFACE_ADDR" "$IFACE_PORT" && blocked=1
in_builder node -e "$CONNECT" 100.100.100.100 53 && blocked=1
[ "$TAILNET_ADDR" != none ] && in_builder node -e "$CONNECT" "$TAILNET_ADDR" "$TAILNET_PORT" && blocked=1
in_builder node -e "$CONNECT" 2606:4700:4700::1111 443 && blocked=1
check builder-blocked-host $blocked
after="$(drops)"
[ "$after" -gt "$before" ]; check builder-drop-counter-rises $? "before=$before after=$after"
in_builder node -e 'fetch("https://registry.npmjs.org/-/ping",{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
check builder-registry-reachable $?
[ "$("$RUNNER" nft-hash)" = "$(cat /etc/instar-helper/nft.sha256 2>/dev/null)" ]; check nft-table-hash $?

# Sockets and vsock: nothing outside the overlay is visible; AF_VSOCK refused.
SOCKS='s=$(find / -xdev -type s 2>/dev/null | grep -v "^/work/" | head -1); [ -z "$s" ] && [ ! -e /mnt/wslg ] && [ ! -e /tmp/.X11-unix ] && [ ! -e /run/WSL ]'
in_testns bash -c "$SOCKS"; check testns-no-foreign-sockets $?
in_builder bash -c "$SOCKS"; check builder-view-no-foreign-sockets $?
# Passes ONLY on the specific refusal (EAFNOSUPPORT / EPERM / EACCES): a missing python3 (127), a
# created socket (1) or any other error (2) fails the check.
VSOCK='import socket,errno,sys
try:
    socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
except OSError as e:
    sys.exit(0 if e.errno in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES) else 2)
sys.exit(1)'
in_testns python3 -c "$VSOCK"; r=$?
[ $r -eq 0 ]; check vsock-refused $? "rc=$r"

# Forward probes: listeners the host must NOT reach on its 127.0.0.1 (the host checks after this script).
if [ -n "$FWD_PORTS" ]; then
  p1="${FWD_PORTS%%,*}"; p2="${FWD_PORTS##*,}"
  # Each listener confirms from its own side that it is up (the positive control) before the host
  # asserts it cannot reach it: a listener that never started must not pass as "not forwarded".
  LISTEN='const n=require("net");const p=+process.argv[1];n.createServer(c=>c.end("x")).listen(p,"0.0.0.0",()=>{const c=n.connect(p,"127.0.0.1",()=>{console.log("LISTENER-UP");c.destroy()});c.on("error",()=>{})});setTimeout(()=>process.exit(0),20000)'
  f1="$(mktemp /srv/results/fwd.XXXXXX)"; f2="$(mktemp /srv/results/fwd.XXXXXX)"
  ( "$RUNNER" ns-exec testns "$TESTER_UID" -- node -e "$LISTEN" "$p1" > "$f1" 2>/dev/null & )
  guest_uid="$(id -u "$(getent passwd 1000 | cut -d: -f1)" 2>/dev/null || echo 0)"
  ( setpriv --reuid="$guest_uid" --regid="$guest_uid" --clear-groups node -e "$LISTEN" "$p2" > "$f2" 2>/dev/null & )
  for i in $(seq 1 20); do grep -q LISTENER-UP "$f1" && grep -q LISTENER-UP "$f2" && break; sleep 0.5; done
  grep -q LISTENER-UP "$f1"; check forward-listener-testns-up $?
  grep -q LISTENER-UP "$f2"; check forward-listener-guest-up $?
  rm -f "$f1" "$f2"
else
  check forward-listener-testns-up 1 "no probe ports"
  check forward-listener-guest-up 1 "no probe ports"
fi

# The sandbox property test (a condition of the design's approval): as tester and as builder, each
# in the view its own code runs in, no host path is readable and no host credential is reachable.
# The probe (root's own file, outside every tree) prints one PROBE line per facet and one for its
# positive control: it plants a marker file, a credential variable, a secret-store folder and a
# socket in its own scratch space and must FIND each. A facet passes only when the control passed
# and the facet found nothing; a probe that could not run reports nothing, which the host reads as
# unrunnable (refuse).
probe_as() { # $1 = user label, $2 = ns-exec view, $3 = uid
  local out
  out="$("$RUNNER" ns-exec "$2" "$3" -- node "$PROBE" --marker "${MARKER:-none}" --owner-user "$OWNER_USER" --digests "$DIGESTS" 2>/dev/null)"
  if ! grep -q '^PROBE control ok$' <<<"$out"; then
    for f in no-host-path-readable no-github-token no-secret-store no-agent-socket; do
      check "$1-$f" 1 "no positive control: $(grep '^PROBE control' <<<"$out" | head -1 | cut -c1-200)"
    done
    return
  fi
  local f line
  for f in no-host-path-readable no-github-token no-secret-store no-agent-socket; do
    line="$(grep "^PROBE $f " <<<"$out" | head -1)"
    if [ "$line" = "PROBE $f ok" ]; then check "$1-$f" 0; else check "$1-$f" 1 "$(cut -c1-200 <<<"${line:-not reported}")"; fi
  done
}
probe_as tester testns "$TESTER_UID"
probe_as builder builderview "$BUILDER_UID"
# The same credential test on what the host's control channel handed THIS script (root's own
# environment and command line): nothing credential-like may ride it.
ctl="$(node "$PROBE" --env-only --digests "$DIGESTS" 2>/dev/null)"
if grep -q '^PROBE control ok$' <<<"$ctl" && grep -q '^PROBE no-github-token ok$' <<<"$ctl" && grep -q '^PROBE no-agent-socket ok$' <<<"$ctl"; then
  check control-channel-env-clean 0
else
  check control-channel-env-clean 1 "$(grep -v ' ok$' <<<"$ctl" | head -1 | cut -c1-200)"
fi

# Users and limits.
for u in tester builder; do
  uid=$TESTER_UID; [ $u = builder ] && uid=$BUILDER_UID
  setpriv --reuid=$uid --regid=$uid --clear-groups sudo -n true >/dev/null 2>&1; r=$?; [ $r -ne 0 ]; check "$u-no-sudo" $?
  probe=/srv/trees/.probe-sealed; mkdir -p "$probe"; chown root:root "$probe"; chmod 0555 "$probe"
  setpriv --reuid=$uid --regid=$uid --clear-groups touch "$probe/x" >/dev/null 2>&1; r=$?; [ $r -ne 0 ]; check "$u-tree-readonly" $?
  setpriv --reuid=$uid --regid=$uid --clear-groups nft add table inet instar_probe >/dev/null 2>&1; r=$?; [ $r -ne 0 ]; check "$u-nft-denied" $?
done

if [ "$WSL" = 1 ]; then
  props="$(systemctl show instar-helper.slice -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax 2>/dev/null)"
  echo "$props" | grep -q '^MemoryMax=[0-9]' && echo "$props" | grep -q '^CPUQuotaPerSecUSec=[0-9]' && echo "$props" | grep -q '^TasksMax=[0-9]'
  check scope-limits $? "$(echo "$props" | tr '\n' ' ')"
  [ ! -e /mnt/c ] && in_testns test ! -e /mnt/c && in_builder test ! -e /mnt/c; check no-mnt-c $?
  [ ! -e /mnt/wsl ] && in_testns test ! -e /mnt/wsl && in_builder test ! -e /mnt/wsl; check no-mnt-wsl $?
  if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && grep -q '^enabled' /proc/sys/fs/binfmt_misc/WSLInterop; then check no-windows-interop 1; else check no-windows-interop 0; fi
fi
exit 0
