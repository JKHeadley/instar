if [ -f .husky/_/instar-node ]; then
  IFS= read -r instar_node < .husky/_/instar-node || return 1
  if [ ! -x "$instar_node" ]; then
    echo "The Node runtime provisioned for this worktree is unavailable: $instar_node" >&2
    return 1
  fi
  PATH="$(dirname "$instar_node"):$PATH"
  export PATH
  "$instar_node" scripts/check-worktree-sqlite.cjs || return 1
fi
