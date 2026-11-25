# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Release maintainers can opt into a troubleshooting link when npm rejects an Instar publish because of a temporary account suspension. The publish step preserves npm's exit status. The link points to the existing GitHub development release instructions.

## Evidence

Three November 8 publish logs record the matching npm error. Focused tests execute the workflow's shell wrapper with a stand-in npm command and check the exact invocation, matching and unrelated failures, successful publishing, and the default-off setting.
