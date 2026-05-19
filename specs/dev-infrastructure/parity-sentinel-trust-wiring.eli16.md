---
title: "Parity sentinel trust wiring + backfill — ELI16"
slug: "parity-sentinel-trust-wiring-eli16"
parent: "parity-sentinel-trust-wiring.md"
---

# Parity sentinel trust wiring — explained simply

## What this fixes

Instar has a Sentinel — a background watcher whose job is to check that the canonical version of a skill, hook, agent, tool, or memory primitive matches what's actually rendered on disk for each framework (Claude Code, Codex CLI). When the rendered version drifts, the sentinel can either flag the drift (signal-only) or automatically re-render from canonical (remediate).

Whether the sentinel remediates is supposed to depend on the agent's trust level for the sentinel service — that's the documented "mirror-trust" policy. In practice, the v0.1 sentinel shipped without actually consulting trust. The string "mirror-trust" was a label without behavior. Whenever a global remediationEnabled boolean was true, the sentinel remediated; when false, it didn't. Trust never entered the picture.

This release makes the label honest. The sentinel now consults the trust system. If the agent's trust level for the parity-sentinel service is "autonomous" or "log," remediation proceeds. If it's "approve-always," "approve-first," or "blocked," the sentinel downgrades to flag-only and the operator decides.

## Why the migration matters

The trust system has a default of "approve-always" for any service it hasn't seen before. Without a backfill, every existing deployed agent would silently lose remediation the moment they updated — the sentinel would consult trust, see no entry, fall to the "approve-always" default, and refuse to auto-fix anything. The v0.1 behavior would break for everyone on the next update.

The PostUpdateMigrator (the thing that runs on every "instar update" to bring existing agents forward) now seeds a parity-sentinel trust entry at "log" level. "Log" preserves the v0.1 remediate-by-default behavior while routing every remediation through the trust system's audit channel. From there, the operator can elevate to "autonomous" after a good track record or downgrade to "approve-always" if something goes wrong.

The migration is idempotent — re-runs do nothing — and never overwrites an operator-set entry. So agents that have already configured the parity-sentinel trust explicitly are not touched.

## What changes for you

For Justin: when you next update, the migration will seed the entry at "log" and the sentinel will keep remediating (same behavior as before, just with the audit channel active now). If you ever want to flip it to manual-approval mode, you can do that through the trust system without code changes.

For deployed agents on other machines: same. The seed happens on next update, behavior continues unchanged, the audit trail now records every parity remediation.

## What this is NOT

Not a behavioral change for users. Not a security change — it's the same write surface the sentinel already had. Not a redesign of trust levels — uses the existing AdaptiveTrust API verbatim. Just makes the documented mirror-trust policy actually do what it said it did.
