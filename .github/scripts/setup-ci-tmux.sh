#!/usr/bin/env bash
# Ubuntu's tmux 3.4 can lose a child notification through libutempter, leaving
# pane_dead=1 with no exit status forever (tmux/tmux#4559). Use the fixed upstream
# release for ALL real-process lanes. Keep the real lifecycle assertions intact.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]]
: "${RUNNER_TEMP:?GitHub runner temp directory is required}"
: "${GITHUB_PATH:?GitHub step PATH file is required}"

version=3.6a
checksum=b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759
prefix="$RUNNER_TEMP/instar-ci-tmux-$version"

if [[ ! -x "$prefix/bin/tmux" ]]; then
  if ! command -v cc >/dev/null || ! command -v make >/dev/null || \
     ! command -v bison >/dev/null || ! command -v pkg-config >/dev/null || ! pkg-config --exists libevent ncurses || \
     [[ ! -f /usr/include/utempter.h ]]; then
    timeout --kill-after=10s 180s sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 update
    timeout --kill-after=10s 180s sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential pkg-config bison libevent-dev libncurses-dev libutempter-dev
  fi
  build_root=$(mktemp -d "$RUNNER_TEMP/instar-tmux-build.XXXXXX")
  tarball="$build_root/tmux.tar.gz"
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 180 \
    "https://github.com/tmux/tmux/releases/download/$version/tmux-$version.tar.gz" -o "$tarball"
  printf '%s  %s\n' "$checksum" "$tarball" | sha256sum --check --status
  tar -xzf "$tarball" -C "$build_root"
  cd "$build_root/tmux-$version"
  timeout --kill-after=10s 180s ./configure --prefix="$prefix" --enable-utempter
  timeout --kill-after=10s 240s make -j2
  timeout --kill-after=10s 60s make install
fi

[[ "$("$prefix/bin/tmux" -V)" == "tmux $version" ]]
# Config.detectTmuxPath checks /usr/local/bin before consulting PATH.
# The runner is disposable; ensure that absolute-path probe uses this build too.
sudo ln -sf "$prefix/bin/tmux" /usr/local/bin/tmux
printf '%s\n' "$prefix/bin" >> "$GITHUB_PATH"
"$prefix/bin/tmux" -V
