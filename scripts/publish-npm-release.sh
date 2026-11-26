#!/usr/bin/env bash
set -euo pipefail

if [[ ${INSTAR_NPM_PUBLISH_HOLD_HINT:-} != true ]]; then
  exec npm publish --provenance --access public
fi

if ! log=$(mktemp); then
  exec npm publish --provenance --access public
fi
trap 'rm -f -- "$log"' EXIT

# Keep the original output visible and preserve npm's exit status.
set +e
npm publish --provenance --access public 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

if (( status != 0 )) &&
  grep -Eq '^npm (error|ERR!) code E403$' "$log" &&
  grep -Eq '^npm (error|ERR!) 403 403 Forbidden - PUT https://registry\.npmjs\.org/instar - Your account has been temporarily suspended due to a recent security-sensitive action\.$' "$log"; then
  echo 'npm publishing is temporarily suspended. For an opt-in development build, see https://github.com/JKHeadley/instar/blob/main/docs/development-releases.md#npm-account-suspension' >&2
fi

exit "$status"
