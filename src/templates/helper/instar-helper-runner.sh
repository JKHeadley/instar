#!/bin/bash
# The root-owned runner inside the borrowed-machine helper sandbox
# (docs/specs/local-verify-borrowed-unit-slices.md, B2.3 and E "Running").
# Installed at /usr/local/sbin/instar-helper-runner (root:root 0755). Called by the owner service on
# the host through `limactl shell instar-helper sudo -n …` or `wsl.exe -d instar-helper -u root -- …`.
#
# Walls, per process:
#   - the build and every slice run in NEW network and mount namespaces (`unshare -m -n`, then
#     `ip link set lo up`): only their own loopback, so tests listening on 127.0.0.1 work and
#     nothing else is reachable or visible;
#   - the mount namespace shows only the tree overlay, a private /tmp, /proc and a minimal /dev,
#     through a chroot: WSLg/X11/Wayland/audio sockets, /run/WSL, docker.sock are not visible;
#   - a seccomp filter refuses AF_VSOCK (systemd RestrictAddressFamilies) for builder and tester;
#   - only `npm ci` has network: as builder, in the shared network (the nft rules match it by uid),
#     with the same minimal file view; its table hash is re-checked first;
#   - every builder process is killed after every build and before every npm ci;
#   - each slice gets a fresh writable overlay on the read-only tree, discarded afterwards;
#   - results are collected by root from a pipe it opened, never from files in the overlay, and
#     printed framed on this script's stdout (everything else goes to stderr).
#
# NEVER run on a Local Verify machine.
set -euo pipefail

BUILDER_UID=61001
TESTER_UID=61002
SLICE_UNIT_OPTS=(--slice=instar-helper.slice --collect --quiet --wait --pipe
  -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" -p NoNewPrivileges=yes -p Nice=19)

die() { echo "instar-helper-runner: $*" >&2; exit 2; }
valid_tree() { [[ "$1" =~ ^[0-9a-f]{12,40}$ ]] || die "bad tree id"; }
valid_file() { [[ "$1" =~ ^[A-Za-z0-9._@+/-]+\.test\.ts$ ]] && [[ "$1" != *..* ]] && [[ "$1" != /* ]] || die "bad file: $1"; }

# A minimal root for a namespace: read-only system dirs, the work dir, private /tmp, /proc, minimal /dev.
make_root() { # $1 root dir, $2 work dir to mount at /work, $3 rw|ro
  local r="$1" w="$2" mode="$3"
  mkdir -p "$r"/{usr,etc,opt,work,tmp,proc,dev,run}
  for d in usr etc opt; do mount --bind "/$d" "$r/$d"; mount -o remount,bind,ro "$r/$d"; done
  for l in bin sbin lib lib64; do [ -e "/$l" ] && ln -sfn "usr/$l" "$r/$l"; done
  mount --bind "$w" "$r/work"
  [ "$mode" = ro ] && mount -o remount,bind,ro "$r/work"
  mount -t tmpfs -o mode=1777,size=2g tmpfs "$r/tmp"
  mount -t proc proc "$r/proc"
  mount -t tmpfs -o mode=0755,size=1m tmpfs "$r/dev"
  for n in null zero random urandom; do touch "$r/dev/$n"; mount --bind "/dev/$n" "$r/dev/$n"; done
  ln -sf /proc/self/fd "$r/dev/fd"
  mount -t tmpfs -o mode=0755,size=1m tmpfs "$r/run"
}

kill_user() { # kill every process of a user, at most 3 times 1 s apart; prints survivors
  local u="$1" i
  for i in 1 2 3; do
    pkill -KILL -u "$u" 2>/dev/null || true
    pgrep -u "$u" >/dev/null 2>&1 || { echo 0; return; }
    sleep 1
  done
  pgrep -u "$u" 2>/dev/null | wc -l
}

# The table's hash with counter VALUES stripped token by token (NFT_COUNTER_SED in runnerDriverBase.ts):
# a rule carrying an anonymous counter stays in the hashed text, so inserting one changes the hash.
nft_hash() { nft list table inet instar_helper 2>/dev/null | sed -E 's/packets [0-9]+ bytes [0-9]+//g' | sha256sum | cut -d' ' -f1; }

mode="${1:-}"; shift || true
case "$mode" in
  nft-hash) nft_hash ;;

  copy-in) # stdin: a tar of the merged commit's files
    tree="$1"; valid_tree "$tree"
    rm -rf "/srv/trees/$tree"; install -d -m 0755 -o "$BUILDER_UID" -g "$BUILDER_UID" "/srv/trees/$tree"
    setpriv --reuid="$BUILDER_UID" --regid="$BUILDER_UID" --clear-groups --no-new-privs tar -x --no-same-owner --no-same-permissions -C "/srv/trees/$tree" -f -
    ;;

  npm-ci)
    tree="$1"; valid_tree "$tree"; t="/srv/trees/$tree"
    [ "$(nft_hash)" = "$(cat /etc/instar-helper/nft.sha256)" ] || die "nft table hash mismatch"
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived"
    lock="$(sha256sum "$t/package-lock.json" | cut -d' ' -f1)"
    if [ -d "/srv/nm/$lock/node_modules" ]; then
      cp -a "/srv/nm/$lock/node_modules" "$t/node_modules"; chown -R "$BUILDER_UID:$BUILDER_UID" "$t/node_modules"
      echo "node_modules reused ($lock)" >&2; exit 0
    fi
    rm -rf /srv/home/builder/.npm /srv/home/builder/.cache; install -d -m 0700 -o "$BUILDER_UID" -g "$BUILDER_UID" /srv/home/builder
    root="$(mktemp -d /srv/roots/b.XXXXXX)"
    # Mount namespace only: the shared network, where the uid-matched nft rules apply.
    set +e
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare -m --propagation private bash -c "
      $(declare -f make_root); make_root '$root' '$t' rw
      mkdir -p '$root/work/.helper-home'; chown $BUILDER_UID:$BUILDER_UID '$root/work/.helper-home'
      exec chroot '$root' setpriv --reuid=$BUILDER_UID --regid=$BUILDER_UID --clear-groups --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp npm_config_cache=/tmp/npm HUSKY=0 \
        bash -c 'cd /work && npm ci --no-audit --no-fund'" >&2
    rc=$?
    set -e
    rmdir "$root" 2>/dev/null || true
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived npm ci"
    if [ $rc -eq 0 ]; then mkdir -p "/srv/nm/$lock"; cp -a "$t/node_modules" "/srv/nm/$lock/node_modules"; fi
    exit $rc
    ;;

  build)
    tree="$1"; valid_tree "$tree"; t="/srv/trees/$tree"
    [ -L "$t/node_modules" ] && die "node_modules is a symlink"
    chown -R -P root:root "$t/node_modules"; find -P "$t/node_modules" ! -type l -exec chmod a-w {} +  # node_modules locked read-only, never through a symlink
    root="$(mktemp -d /srv/roots/b.XXXXXX)"
    set +e
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare -m -n --propagation private bash -c "
      ip link set lo up
      $(declare -f make_root); make_root '$root' '$t' rw
      exec chroot '$root' setpriv --reuid=$BUILDER_UID --regid=$BUILDER_UID --clear-groups --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp \
        bash -c 'cd /work && npm run build'" >&2
    rc=$?
    set -e
    rmdir "$root" 2>/dev/null || true
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived the build"
    exit $rc
    ;;

  seal) # the whole tree read-only: code run later cannot change a tree another slice uses
    tree="$1"; valid_tree "$tree"; t="/srv/trees/$tree"
    chown -R -P root:root "$t"; find -P "$t" ! -type l -exec chmod a-w {} +
    ;;

  test) # test <tree> <workers> -- <files…>
    tree="$1"; workers="$2"; shift 2; [ "${1:-}" = "--" ] && shift
    valid_tree "$tree"; [[ "$workers" =~ ^[1-9][0-9]?$ ]] || die "bad workers"
    for f in "$@"; do valid_file "$f"; done
    t="/srv/trees/$tree"; n="$(date +%s%N)"
    ov="/srv/overlay/$n"; mkdir -p "$ov/upper" "$ov/work"; chown "$TESTER_UID:$TESTER_UID" "$ov/upper"
    merged="/srv/slice/$tree"; mkdir -p "$merged"
    config="vitest.config.ts"
    all_canary=1; for f in "$@"; do [[ "$f" == tests/fixtures/borrowed-canary/* ]] || all_canary=0; done
    [ $all_canary = 1 ] && config="tests/fixtures/borrowed-canary/vitest.canary.config.ts"
    out="/srv/results/$n.json"; : > "$out"; chmod 0600 "$out"
    t0="$(date +%s%3N)"
    set +e
    # tester's stdout is a pipe root opened; it lands in a root-only file outside the overlay.
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare -m -n --propagation private bash -c "
      ip link set lo up
      mount -t overlay overlay -o lowerdir='$t',upperdir='$ov/upper',workdir='$ov/work' '$merged'
      root=\$(mktemp -d /srv/roots/t.XXXXXX)
      $(declare -f make_root); make_root \"\$root\" '$merged' rw
      mkdir -p \"\$root/work/.helper-home\"; chown $TESTER_UID:$TESTER_UID \"\$root/work/.helper-home\"
      exec chroot \"\$root\" setpriv --reuid=$TESTER_UID --regid=$TESTER_UID --clear-groups --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp INSTAR_TEST_WORKERS=$workers CI=1 \
        bash -c 'cd /work && exec node node_modules/vitest/vitest.mjs run --config $config --allowOnly=false --silent --reporter=json $(printf '%q ' "$@")' 2>/dev/null
    " > "$out"
    rc=$?
    set -e
    survivors="$(kill_user tester)"
    umount -l "$merged" 2>/dev/null || true
    rm -rf "$ov"
    summary="$(node -e '
      const fs=require("fs"); let j=null; try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
      const t0=Number(process.argv[2]);
      if(!j){console.log("unhandled=0 start_ms=null");process.exit(0)}
      const unh=(j.success===false&&!j.numFailedTests&&!j.numFailedTestSuites)?1:0;
      console.log("unhandled="+unh+" start_ms="+(typeof j.startTime==="number"?Math.max(0,j.startTime-t0):"null"));
    ' "$out" "$t0")"
    echo "INSTAR-HELPER-RESULT-BEGIN exit=$rc $summary"
    cat "$out"
    echo
    echo "INSTAR-HELPER-RESULT-END"
    rm -f "$out"
    [ "$survivors" = 0 ] || echo "tester survivors: $survivors" >&2
    ;;

  reap)
    b="$(kill_user builder)"; s="$(kill_user tester)"
    echo "survivors=$((b + s))"
    ;;

  remove)
    tree="$1"; valid_tree "$tree"
    umount -l "/srv/slice/$tree" 2>/dev/null || true
    chmod -R u+w "/srv/trees/$tree" 2>/dev/null || true
    rm -rf "/srv/trees/$tree" "/srv/slice/$tree"
    ;;

  free)
    echo "free_bytes=$(df --output=avail -B1 /srv | tail -1 | tr -d ' ')"
    ;;

  cpu-stat)
    cat /sys/fs/cgroup/instar-helper.slice/cpu.stat
    ;;

  checks)
    exec /usr/local/sbin/instar-helper-checks "$@"
    ;;

  ns-exec) # internal, used by the check script: ns-exec <testns|builderview> <uid> -- <cmd…>
    kind="$1"; uid="$2"; shift 2; [ "${1:-}" = "--" ] && shift
    root="$(mktemp -d /srv/roots/c.XXXXXX)"; scratch="$(mktemp -d /srv/overlay/c.XXXXXX)"
    nsflags="-m -n"; [ "$kind" = builderview ] && nsflags="-m"
    set +e
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare $nsflags --propagation private bash -c "
      [ '$kind' = testns ] && ip link set lo up
      $(declare -f make_root); make_root '$root' '$scratch' rw
      exec chroot '$root' setpriv --reuid=$uid --regid=$uid --clear-groups --no-new-privs env -i PATH=/usr/local/bin:/usr/bin:/bin $(printf '%q ' "$@")"
    rc=$?
    set -e
    rm -rf "$scratch"; rmdir "$root" 2>/dev/null || true
    exit $rc
    ;;

  *) die "unknown mode: $mode" ;;
esac
