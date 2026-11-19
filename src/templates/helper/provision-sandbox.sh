# Provisioning of the borrowed-machine helper sandbox, run as root inside it once at create
# (docs/specs/local-verify-borrowed-unit-slices.md, B2). Appended to the bundle built by
# buildProvisionBundle(), which has already written the runner, the check script and the nft rules.
#
# NEVER run on a Local Verify machine. Idempotent.

NODE_VERSION="v24.15.0"
# Pinned by the operator on the throwaway rung from the tarball it verified; empty refuses.
NODE_SHA256_ARM64=""
NODE_SHA256_X64=""
BUILDER_UID=61001
TESTER_UID=61002

export DEBIAN_FRONTEND=noninteractive

# Users: builder runs npm ci and the build, tester runs tests. Neither can sudo; uids no account in
# any other distro uses.
getent group builder >/dev/null || groupadd --gid "$BUILDER_UID" builder
getent group tester >/dev/null || groupadd --gid "$TESTER_UID" tester
id builder >/dev/null 2>&1 || useradd --uid "$BUILDER_UID" --gid builder --home-dir /srv/home/builder --create-home --shell /usr/sbin/nologin builder
id tester >/dev/null 2>&1 || useradd --uid "$TESTER_UID" --gid tester --home-dir /srv/home/tester --create-home --shell /usr/sbin/nologin tester
for u in builder tester; do
  gpasswd -d "$u" sudo >/dev/null 2>&1 || true
  rm -f "/etc/sudoers.d/$u"
  chmod 0700 "/srv/home/$u"
done

# Minimal packages: nftables, iproute2, util-linux (unshare, setpriv), git-free.
apt-get update -qq
# python3 is the vsock-refused probe's tool (a missing tool fails that check).
apt-get install -y -qq --no-install-recommends nftables iproute2 util-linux ca-certificates curl xz-utils procps python3-minimal
apt-get purge -y -qq containerd docker.io >/dev/null 2>&1 || true

# Pinned node.
arch="$(uname -m)"
case "$arch" in
  aarch64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64" ;;
  x86_64) node_arch=x64; node_sha="$NODE_SHA256_X64" ;;
  *) echo "unsupported arch $arch" >&2; exit 1 ;;
esac
if [ -z "$node_sha" ]; then echo "node tarball digest not pinned" >&2; exit 1; fi
if [ ! -x /opt/node/bin/node ] || [ "$(/opt/node/bin/node --version)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$node_arch.tar.xz" -o "$tmp/node.tar.xz"
  echo "$node_sha  $tmp/node.tar.xz" | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx

# Work areas (root-owned; the runner hands out per-slice overlays).
install -d -m 0755 -o root -g root /srv/trees /srv/slice /srv/nm
install -d -m 0700 -o root -g root /srv/overlay /srv/results /srv/roots

# The helper's own nftables table, loaded at boot, and its hash for the pre-npm-ci re-check.
cat > /etc/systemd/system/instar-helper-nft.service <<'UNIT'
[Unit]
Description=instar helper builder egress rules
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/instar-helper/builder-egress.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
nft delete table inet instar_helper >/dev/null 2>&1 || true
nft -f /etc/instar-helper/builder-egress.nft
systemctl daemon-reload
systemctl enable instar-helper-nft.service >/dev/null
/usr/local/sbin/instar-helper-runner nft-hash > /etc/instar-helper/nft.sha256
chmod 0644 /etc/instar-helper/nft.sha256

# The slice that bounds builder and tester (WSL: CPUQuota / MemoryMax / TasksMax from scope.conf).
{
  echo "[Unit]"; echo "Description=instar helper work"; echo "[Slice]"
  if [ -f /etc/instar-helper/scope.conf ]; then cat /etc/instar-helper/scope.conf; fi
} > /etc/systemd/system/instar-helper.slice
systemctl daemon-reload
echo "provisioned"
