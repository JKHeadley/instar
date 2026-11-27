#!/bin/bash
# The root-owned runner inside the borrowed-machine helper sandbox
# (docs/specs/local-verify-borrowed-unit-slices.md, B2.3 and E "Running"; as amended by
# docs/specs/local-verify-borrowed-slices-count.md: B2 the test network, C "Packages are installed
# only from merged code", E lanes and progress).
# Installed at /usr/local/sbin/instar-helper-runner (root:root 0755). Called by the owner service on
# the host through `limactl shell instar-helper sudo -n …` or `wsl.exe -d instar-helper -u root -- …`.
#
# Walls, per process:
#   - the build and every slice run in NEW network and mount namespaces (`unshare -m -n`, then
#     `ip link set lo up`): their own loopback, so tests listening on 127.0.0.1 work and nothing
#     else is reachable or visible. A slice's namespace also gets ONE dummy interface, `dummy0`
#     with 10.77.0.2/24 and no default route: tests that look for a non-loopback interface find
#     one, and nothing is reachable through it;
#   - the mount namespace shows only the tree overlay, a private /tmp, /proc and a minimal /dev,
#     through a chroot: WSLg/X11/Wayland/audio sockets, /run/WSL, docker.sock are not visible;
#   - a seccomp filter refuses AF_VSOCK (systemd RestrictAddressFamilies) for builder and tester;
#   - only `npm ci` has network, and it runs ONLY in the tree of a MERGED commit (`install`): as
#     builder, in the shared network (the nft rules match it by uid), with the same minimal file
#     view; its table hash is re-checked first. A waiting change's install steps never run here;
#   - the installed packages go to the package volume (/srv/nm, its own disk beside the sandbox
#     image, so it survives the daily re-creation), root-owned and read-only, with a manifest of
#     file hashes that is recomputed before each use (`pkg-verify`);
#   - a tree gets its packages BEFORE any of its files (`place`, then `copy-in … placed`): an empty
#     root-owned `node_modules`, onto which the build and every slice bind the package set
#     read-only inside their own mount namespace. builder and tester can never write to them;
#   - every builder process is killed after every build and before every npm ci;
#   - each slice gets a fresh writable overlay on the read-only tree, discarded afterwards;
#   - a slice is ONE vitest process with its lane's own configuration (unit, integration or e2e,
#     as on a run machine); integration and e2e files run one at a time;
#   - results are collected by root from a pipe it opened, never from files in the overlay, and
#     printed framed on this script's stdout (everything else goes to stderr);
#   - progress leaves the same way: a root-owned reporter outside the tree
#     (/usr/local/lib/instar-helper/progress-reporter.mjs) writes one line per finished file to the
#     slice's stderr, which is a pipe this script opened; only lines with the progress prefix are
#     passed on to this script's stdout while the slice runs. Never a file in the tree.
#
# NEVER run on a Local Verify machine.
set -euo pipefail

BUILDER_UID=61001
TESTER_UID=61002
SLICE_UNIT_OPTS=(--slice=instar-helper.slice --collect --quiet --wait --pipe
  -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" -p NoNewPrivileges=yes -p Nice=19)

die() { echo "instar-helper-runner: $*" >&2; exit 2; }
# The package volume is not there: its own exit code, which the host names `package-volume-missing`
# (PKG_VOLUME_MISSING_EXIT in sandboxDriver.ts).
die_no_volume() { echo "instar-helper-runner: $*" >&2; exit 44; }
PROGRESS_REPORTER=/usr/local/lib/instar-helper/progress-reporter.mjs

# A test namespace's network (B2, amended): its own loopback and one dummy interface with a
# private address and NO default route. Run inside the new network namespace, as root.
testns_net() {
  ip link set lo up || return 1
  ip link add dummy0 type dummy || return 1
  ip addr add 10.77.0.2/24 dev dummy0 || return 1
  ip link set dummy0 up || return 1
  # Nothing may be a default route: the /24 on the dummy interface is the only route besides loopback.
  ip route del default 2>/dev/null || true
  ip -6 route del default 2>/dev/null || true
}
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

PKG=/srv/nm
PKG_MARKS=/srv/trees/.pkg
valid_hash() { [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "bad hash"; }

# The package volume: its own disk beside the sandbox image. Mounted by its filesystem label; on
# first use the ONE empty whole disk of exactly the configured size is formatted. Anything else dies.
pkg_mount() {
  mountpoint -q "$PKG" && return 0
  [ -f /etc/instar-helper/pkg-volume.conf ] || die_no_volume "package volume not configured"
  local PKG_LABEL="" PKG_SIZE_BYTES="" dev
  . /etc/instar-helper/pkg-volume.conf
  [[ "$PKG_LABEL" =~ ^[a-z0-9-]{1,16}$ ]] && [[ "$PKG_SIZE_BYTES" =~ ^[0-9]+$ ]] || die "package volume settings malformed"
  dev="$(blkid -L "$PKG_LABEL" 2>/dev/null || true)"
  if [ -z "$dev" ]; then
    local cand
    mapfile -t cand < <(lsblk -bdnr -o NAME,SIZE,TYPE,FSTYPE | awk -v s="$PKG_SIZE_BYTES" '$3 == "disk" && $2 == s && $4 == "" { print $1 }')
    [ "${#cand[@]}" = 1 ] || die_no_volume "package volume not found"
    [ "$(lsblk -nr "/dev/${cand[0]}" | wc -l)" = 1 ] || die "package volume has partitions"
    dev="/dev/${cand[0]}"
    mkfs.ext4 -q -L "$PKG_LABEL" "$dev" || die "package volume format failed"
  fi
  mkdir -p "$PKG"
  mount -o nodev,nosuid "$dev" "$PKG" || die "package volume mount failed"
  chown root:root "$PKG"; chmod 0755 "$PKG"
}

# The manifest of one package set: every file's hash, every link's target, and any entry that is
# not root's or that someone may write (none, when the set is as it was locked).
pkg_manifest() { # $1 = /srv/nm/<hash>
  ( cd "$1/node_modules" && {
      find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
      find . -type l -printf 'L %p -> %l\n' | LC_ALL=C sort
      find . ! -user root -printf 'O %p\n' | LC_ALL=C sort
      find . ! -type l -perm /222 -printf 'W %p\n' | LC_ALL=C sort
    } )
}

# The package set a tree was placed with. Dies unless the set is on the volume and the tree's
# node_modules is still root's own directory (the mount point), not a link and not builder's.
pkg_of() { # $1 = tree id
  local h nm="/srv/trees/$1/node_modules"
  h="$(cat "$PKG_MARKS/$1" 2>/dev/null)" || die "tree has no packages placed"
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || die "bad package marker"
  [ -d "$PKG/$h/node_modules" ] && [ ! -L "$PKG/$h/node_modules" ] || die "packages absent"
  [ -d "$nm" ] && [ ! -L "$nm" ] && [ "$(stat -c %u "$nm")" = 0 ] || die "node_modules is not root's mount point"
  echo "$h"
}

mode="${1:-}"; shift || true
case "$mode" in
  nft-hash) nft_hash ;;

  copy-in) # copy-in <tree> fresh|placed ; stdin: a tar of the tree's files
    tree="$1"; how="${2:-fresh}"; valid_tree "$tree"; t="/srv/trees/$tree"
    spool="$(mktemp /srv/results/in.XXXXXX)"; cat > "$spool"
    names="$(tar -tf "$spool")" || { rm -f "$spool"; die "unreadable tar"; }
    # A tree never brings its own node_modules: the helper's packages go there.
    if grep -Eq '^(\./)?node_modules(/|$)' <<<"$names"; then rm -f "$spool"; die "tree carries node_modules"; fi
    case "$how" in
      fresh)
        rm -f "$PKG_MARKS/$tree"; chmod -R u+w "$t" 2>/dev/null || true
        rm -rf "$t"; install -d -m 0755 -o "$BUILDER_UID" -g "$BUILDER_UID" "$t" ;;
      placed)
        pkg_mount; pkg_of "$tree" >/dev/null
        [ -z "$(ls -A "$t" | grep -v '^node_modules$' || true)" ] || { rm -f "$spool"; die "placed tree is not empty"; } ;;
      *) rm -f "$spool"; die "bad copy-in mode" ;;
    esac
    set +e
    setpriv --reuid="$BUILDER_UID" --regid="$BUILDER_UID" --clear-groups --no-new-privs tar -x --no-same-owner --no-same-permissions -C "$t" -f - < "$spool"
    rc=$?
    set -e
    rm -f "$spool"
    exit $rc
    ;;

  pkg-volume) # whether the package volume is there (mounting it, and formatting it on first use)
    pkg_mount
    echo "volume=ok"
    ;;

  pkg-verify) # pkg-verify <hash> <manifest digest>: recompute the manifest before each use
    hash="$1"; want="$2"; valid_hash "$hash"; valid_hash "$want"; pkg_mount; d="$PKG/$hash"
    if [ ! -d "$d/node_modules" ] || [ -L "$d/node_modules" ] || [ ! -f "$d/manifest.sha256" ]; then echo "packages=absent"; exit 3; fi
    got="$(pkg_manifest "$d" | sha256sum | cut -d' ' -f1)"
    stored="$(sha256sum "$d/manifest.sha256" | cut -d' ' -f1)"
    if [ "$got" != "$want" ] || [ "$stored" != "$want" ]; then echo "packages=mismatch"; exit 3; fi
    echo "packages=ok"
    ;;

  pkg-discard)
    hash="$1"; valid_hash "$hash"; pkg_mount
    chmod -R u+w "$PKG/$hash" 2>/dev/null || true
    rm -rf "${PKG:?}/$hash"
    ;;

  install) # install <hash> <tree>: npm ci in the tree of a MERGED commit (the host checked that), nowhere else
    hash="$1"; tree="$2"; valid_hash "$hash"; valid_tree "$tree"; t="/srv/trees/$tree"; pkg_mount
    [ -e "$PKG_MARKS/$tree" ] && die "install in a placed tree"
    if [ -e "$t/node_modules" ] || [ -L "$t/node_modules" ]; then die "tree already has node_modules"; fi
    [ "$(nft_hash)" = "$(cat /etc/instar-helper/nft.sha256)" ] || die "nft table hash mismatch"
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived"
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
    [ $rc -eq 0 ] || exit $rc
    [ -d "$t/node_modules" ] && [ ! -L "$t/node_modules" ] || die "npm ci left no node_modules"
    d="$PKG/$hash"
    chmod -R u+w "$d" 2>/dev/null || true; rm -rf "$d"; mkdir -p "$d"
    cp -a "$t/node_modules" "$d/node_modules"
    # Locked before anything is placed beside them: root's, and nobody may write, never through a symlink.
    chown -R -P root:root "$d"; find -P "$d" ! -type l -exec chmod a-w {} +
    pkg_manifest "$d" > "$d/manifest.sha256"; chmod 0444 "$d/manifest.sha256"
    echo "manifest=$(sha256sum "$d/manifest.sha256" | cut -d' ' -f1)"
    ;;

  place) # place <tree> <hash> <manifest digest>: the tree starts empty with root's packages mount point in it
    tree="$1"; hash="$2"; want="$3"; valid_tree "$tree"; valid_hash "$hash"; valid_hash "$want"; pkg_mount
    d="$PKG/$hash"; t="/srv/trees/$tree"
    [ -d "$d/node_modules" ] && [ ! -L "$d/node_modules" ] || die "packages absent"
    [ "$(sha256sum "$d/manifest.sha256" | cut -d' ' -f1)" = "$want" ] || die "package manifest mismatch"
    umount -l "/srv/slice/$tree" 2>/dev/null || true
    chmod -R u+w "$t" 2>/dev/null || true
    rm -rf "$t"; install -d -m 0755 -o "$BUILDER_UID" -g "$BUILDER_UID" "$t"
    install -d -m 0555 -o root -g root "$t/node_modules"
    install -d -m 0700 -o root -g root "$PKG_MARKS"
    printf '%s\n' "$hash" > "$PKG_MARKS/$tree"
    ;;

  build)
    tree="$1"; valid_tree "$tree"; t="/srv/trees/$tree"; pkg_mount
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived"
    h="$(pkg_of "$tree")"
    root="$(mktemp -d /srv/roots/b.XXXXXX)"
    # The packages are bound read-only inside the build's own mount namespace, for the whole build:
    # builder cannot write to them, move them or unmount them.
    set +e
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare -m -n --propagation private bash -c "
      ip link set lo up
      $(declare -f make_root); make_root '$root' '$t' rw
      mount --bind '$PKG/$h/node_modules' '$root/work/node_modules' && mount -o remount,bind,ro,nosuid,nodev '$root/work/node_modules' || exit 97
      mkdir -p '$root/work/.helper-home'; chown $BUILDER_UID:$BUILDER_UID '$root/work/.helper-home'
      exec chroot '$root' setpriv --reuid=$BUILDER_UID --regid=$BUILDER_UID --clear-groups --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp \
        bash -c 'cd /work && npm run build'" >&2
    rc=$?
    set -e
    rmdir "$root" 2>/dev/null || true
    [ "$(kill_user builder)" = 0 ] || die "builder processes survived the build"
    pkg_of "$tree" >/dev/null
    exit $rc
    ;;

  seal) # the whole tree read-only: code run later cannot change a tree another slice uses
    tree="$1"; valid_tree "$tree"; t="/srv/trees/$tree"
    chown -R -P root:root "$t"; find -P "$t" ! -type l -exec chmod a-w {} +
    ;;

  test) # test <tree> <lane> <workers> -- <files…>: ONE vitest process, the lane's own configuration
    tree="$1"; lane="$2"; workers="$3"; shift 3; [ "${1:-}" = "--" ] && shift
    valid_tree "$tree"; [[ "$workers" =~ ^[1-9][0-9]?$ ]] || die "bad workers"
    # The lane's own vitest configuration, as the run machines use it. Integration and end-to-end
    # run their files one at a time (their configurations say so); only unit takes several workers.
    case "$lane" in
      unit) config="vitest.config.ts" ;;
      integration) config="vitest.integration.config.ts"; [ "$workers" = 1 ] || die "integration files run one at a time" ;;
      e2e) config="vitest.e2e.config.ts"; [ "$workers" = 1 ] || die "e2e files run one at a time" ;;
      *) die "bad lane" ;;
    esac
    [ $# -ge 1 ] || die "no files"
    for f in "$@"; do valid_file "$f"; done
    t="/srv/trees/$tree"; n="$(date +%s%N)"; pkg_mount; h="$(pkg_of "$tree")"
    ov="/srv/overlay/$n"; mkdir -p "$ov/upper" "$ov/work"; chown "$TESTER_UID:$TESTER_UID" "$ov/upper"
    merged="/srv/slice/$tree"; mkdir -p "$merged"
    # The check slice (fixture files only) has its own configuration, whatever lane it rides.
    all_canary=1; for f in "$@"; do [[ "$f" == tests/fixtures/borrowed-canary/* ]] || all_canary=0; done
    [ $all_canary = 1 ] && config="tests/fixtures/borrowed-canary/vitest.canary.config.ts"
    [ -r "$PROGRESS_REPORTER" ] && [ "$(stat -c %u "$PROGRESS_REPORTER")" = 0 ] || die "progress reporter missing or not root's"
    out="/srv/results/$n.json"; : > "$out"; chmod 0600 "$out"
    t0="$(date +%s%3N)"
    # Progress: tester's stderr is a pipe this script opens here. Only lines with the progress
    # prefix pass, straight to this script's own stdout (fd 4), while the slice runs.
    exec 4>&1
    set +e
    # tester's stdout is a pipe root opened; it lands in a root-only file outside the overlay.
    # The environment is the run machines' (no CI, a UTF-8 locale), with its own TMPDIR.
    systemd-run "${SLICE_UNIT_OPTS[@]}" -- unshare -m -n --propagation private bash -c "
      $(declare -f testns_net); testns_net || exit 96
      mount -t overlay overlay -o lowerdir='$t',upperdir='$ov/upper',workdir='$ov/work' '$merged'
      root=\$(mktemp -d /srv/roots/t.XXXXXX)
      $(declare -f make_root); make_root \"\$root\" '$merged' rw
      mount --bind '$PKG/$h/node_modules' \"\$root/work/node_modules\" && mount -o remount,bind,ro,nosuid,nodev \"\$root/work/node_modules\" || exit 97
      mkdir -p \"\$root/work/.helper-home\"; chown $TESTER_UID:$TESTER_UID \"\$root/work/.helper-home\"
      exec chroot \"\$root\" setpriv --reuid=$TESTER_UID --regid=$TESTER_UID --clear-groups --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp TMUX_TMPDIR=/tmp LANG=C.UTF-8 INSTAR_TEST_WORKERS=$workers \
        bash -c 'cd /work && exec node node_modules/vitest/vitest.mjs run --config $config --allowOnly=false --silent --reporter=json --reporter=$PROGRESS_REPORTER $(printf '%q ' "$@")'
    " > "$out" 2> >(LC_ALL=C grep -a --line-buffered '^INSTAR-HELPER-PROGRESS ' >&4)
    rc=$?; filter_pid="${!:-}"
    set -e
    # Every tester process is killed first: one left behind would hold the progress pipe open.
    survivors="$(kill_user tester)"
    # The progress filter ends when the pipe's last writer is gone; wait for its last lines.
    [ -n "$filter_pid" ] && { wait "$filter_pid" 2>/dev/null || true; }
    exec 4>&-
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
    rm -f "$PKG_MARKS/$tree"
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
      $(declare -f testns_net)
      if [ '$kind' = testns ]; then testns_net || exit 96; fi
      $(declare -f make_root); make_root '$root' '$scratch' rw
      exec chroot '$root' setpriv --reuid=$uid --regid=$uid --clear-groups --no-new-privs env -i PATH=/usr/local/bin:/usr/bin:/bin $(printf '%q ' "$@")"
    rc=$?
    set -e
    rm -rf "$scratch"; rmdir "$root" 2>/dev/null || true
    exit $rc
    ;;

  *) die "unknown mode: $mode" ;;
esac
