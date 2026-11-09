#!/bin/bash
# xdrive-provision.sh: install what the Linux Chrome driver needs (ACT-138). Started by the agent's server,
# detached, never by xdrive.sh, which installs nothing. Usage: xdrive-provision.sh <agent home> [--upgrade]
# Installed by instar into .instar/scripts/browser/, overwritten on every update. The body is one function
# so an update rewriting this file cannot disturb a copy that is already running.
# Spec: docs/specs/normal-chrome-linux.md, "Installing on a fresh agent".

main() {
  local home="$1" mode="${2:-install}"
  local state="$home/.instar/state/xdrive" out key_dir
  local fingerprint="EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
  local key_url="https://dl.google.com/linux/linux_signing_key.pub"
  local keyring="/etc/apt/keyrings/google-chrome.gpg"
  local source_file="/etc/apt/sources.list.d/google-chrome.list"
  local apt_lock=(-o DPkg::Lock::Timeout=300)
  [ -d "$home/.instar" ] || exit 64
  mkdir -p "$state" && chmod 700 "$state"
  out="$state/provision.json"

  # One runner at a time. This lock, held for the runner's life, is what "a live runner" means.
  exec 7>>"$state/provision.lock"
  flock -n 7 || exit 0

  record() { # record <status> [attempt-json-extra]
    local tmp
    tmp="$(mktemp "$state/.provision.XXXXXX")" || return
    printf '{"status":"%s","at":"%s","boot":"%s"%s}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "${2:-}" >"$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$out"
  }
  bounded() { timeout --kill-after=10 600 "$@"; }

  # The apt source, key and defaults are host-wide, so two agents on one machine take turns. Per-uid,
  # because the file is in /tmp; each runs under its own sudo, and apt's own locks cover the rest.
  exec 5>>"/tmp/instar-xdrive-provision-$(id -u).lock"
  flock -w 900 5 || { record "failed: host busy"; exit 1; }

  if [ "$mode" = "--upgrade" ]; then
    # Holds the driver's own lock, so a launch cannot start while Chrome is being replaced.
    exec 6>>"$state/agent.lock"
    flock -n 6 || exit 0
    [ -z "$(ls -A "$state/targets" 2>/dev/null)" ] || exit 0
    # The package is host-wide: any Chrome running here, another agent's included, waits for the next check.
    pgrep -f /opt/google/chrome/chrome >/dev/null 2>&1 && exit 0
    if bounded sudo -n apt-get "${apt_lock[@]}" update -qq && \
       bounded sudo -n env DEBIAN_FRONTEND=noninteractive apt-get "${apt_lock[@]}" install -y -qq --only-upgrade google-chrome-stable; then
      record ready ',"upgradedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"'
    else
      record ready ',"upgradeFailed":true,"upgradedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"'
    fi
    exit 0
  fi

  record installing
  local tries=0
  until bounded sudo -n dpkg --configure -a; do
    tries=$((tries + 1))
    [ "$tries" -lt 10 ] || { record "failed: dpkg"; exit 1; }
    sleep 30
  done

  printf 'repo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n' | bounded sudo -n tee /etc/default/google-chrome >/dev/null || { record "failed: defaults"; exit 1; }

  key_dir="$(mktemp -d "$state/.key.XXXXXX")" || { record "failed: key"; exit 1; }
  chmod 700 "$key_dir"
  if ! bounded curl -fsSL --proto '=https' "$key_url" -o "$key_dir/key.pub"; then rm -rf "$key_dir"; record "failed: key"; exit 1; fi
  local actual
  actual="$(gpg --show-keys --with-colons "$key_dir/key.pub" 2>/dev/null | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;exit}')"
  if [ "$actual" != "$fingerprint" ]; then rm -rf "$key_dir"; record "failed: key"; exit 1; fi
  # Export only the pinned key: the file served may hold others.
  if ! GNUPGHOME="$key_dir" gpg --batch --quiet --import "$key_dir/key.pub" 2>/dev/null || \
     ! GNUPGHOME="$key_dir" gpg --batch --export "$fingerprint" >"$key_dir/key.gpg" 2>/dev/null; then
    rm -rf "$key_dir"; record "failed: key"; exit 1
  fi
  bounded sudo -n install -d -m 0755 /etc/apt/keyrings && \
    bounded sudo -n install -m 0644 "$key_dir/key.gpg" "$keyring" || { rm -rf "$key_dir"; record "failed: key"; exit 1; }
  rm -rf "$key_dir"

  printf 'deb [arch=amd64 signed-by=%s] https://dl.google.com/linux/chrome/deb/ stable main\n' "$keyring" | \
    bounded sudo -n tee "$source_file" >/dev/null || { record "failed: source"; exit 1; }

  bounded sudo -n apt-get "${apt_lock[@]}" update -qq || { record "failed: update"; exit 1; }
  bounded sudo -n env DEBIAN_FRONTEND=noninteractive apt-get "${apt_lock[@]}" install -y -qq \
    python3-gi gir1.2-atspi-2.0 libxtst6 tigervnc-standalone-server at-spi2-core dbus google-chrome-stable || { record "failed: install"; exit 1; }
  record ready
}
main "$@"; exit
