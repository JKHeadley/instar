## What Changed

Project items could not be recorded as merged on installs where the server starts at boot.

Marking a project item merged is deliberately evidence-based: the tracker verifies the pull
request itself rather than trusting the caller. That verification shells out to the GitHub CLI —
and a server started by launchd inherits a minimal PATH that omits `/opt/homebrew/bin`, so the
call died with a raw `spawnSync gh ENOENT`. The transition could never succeed, so work could be
started but never closed out.

The GitHub CLI is now resolved by absolute path (explicit override, then the common install
locations, then PATH), mirroring the pattern this repo already uses for the Bitwarden CLI. When it
genuinely cannot be found, the failure is now a named, plain-English diagnostic that points at the
`INSTAR_GH_PATH` override instead of an opaque spawn error.

## What to Tell Your User

If you use instar's project tracking, finishing a piece of work can now actually be recorded as
finished. Previously the final step could fail silently-ish on machines where the agent's server
starts automatically at boot, leaving completed work permanently showing as open.

Nothing to do, and nothing changes about how the check works: your agent still verifies the merge
against GitHub rather than taking its own word for it, and still refuses the step when it cannot
verify.

## Summary of New Capabilities

No new capabilities. This restores an existing transition that was unreachable in a common
deployment configuration, and improves the diagnostic when the underlying tool is genuinely
absent.

## Evidence

- Reproduced under the exact failing condition (`PATH=/usr/bin:/bin`, matching what launchd
  supplies): a bare `gh` invocation gives `ENOENT` — the original failure — while the new resolver
  returns `/opt/homebrew/bin/gh`.
- 5 new unit tests: an explicit override wins; a non-existent override is ignored rather than
  returned; the function returns a string or null and never throws; the probe is cached; the
  override is re-read rather than frozen by the cache.
- Clean type-check; the resolver is additive with a single consumer.
- The verification behaviour is untouched — a missing binary still refuses the transition rather
  than assuming the merge happened.
