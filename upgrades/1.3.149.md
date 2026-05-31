---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; instar-codey node-ABI outage — deeper root)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the boot wrapper can now heal back to an asdf/nvm node

This is the deeper root of the node-ABI outage that the previous release addressed
at the heal layer. When an agent's Node pointer drifts to a newer Node (e.g. after
a Homebrew upgrade installs Node 25) but its compiled database driver was built for
the older Node it had been using via a version manager (asdf / nvm), the boot
wrapper tries to "heal" by switching to a Node whose ABI matches the driver. But
its candidate list only looked at the standard system Node locations
(`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) — it never looked at
asdf/nvm-managed Nodes. So the one Node that could load the driver was invisible to
it, and it self-healed FORWARD to the wrong ABI and got stuck. This took
instar-codey offline for hours.

The fix adds the system-resolved Node (`which node`, which resolves through
asdf/nvm shims) to the heal candidate list. It is purely additive — it only expands
a candidate pool that is already filtered to ABI-compatible nodes before selection,
so it cannot make a heal worse. A migration-parity marker bump regenerates the boot
wrapper on existing agents (including ones already stuck with the old script).

## Summary of New Capabilities

- The generated `instar-boot.cjs` node-heal now adds the PATH-resolved node
  (`which node`) to its candidate list before the ABI-compatibility selection,
  mirroring the already-correct `resolveNodeCandidates()` symlink-creation path.
- `PostUpdateMigrator.migrateBootWrapperAbiCheck` now requires both the ABI-check
  marker AND the new version-managed-node marker; agents missing the new marker are
  regenerated on update.

## What to Tell Your User

If you ever upgrade Node on the machine running your agent, the agent can now
recover its database engine on its own even when the Node it needs is one managed
by a version manager like asdf or nvm. Previously it only knew to look in the
standard system spots, so an agent could get stuck pointing at the wrong Node after
an upgrade. Nothing to configure — it applies on the next update, and agents that
were already stuck get the repair automatically.

## Evidence

- Root cause traced live in instar-codey logs: the boot wrapper self-healed the
  node link forward to Homebrew Node 25 (ABI 141) while the better-sqlite3 binary
  was ABI 127, with the matching asdf Node 22 absent from the candidate list.
- The already-correct `resolveNodeCandidates()` in the same file (setup.ts) was
  confirmed to include `which node`; only the generated boot-wrapper template
  lacked it.
- Unit: `tests/unit/PostUpdateMigrator-bootWrapperAbiCheck.test.ts` — new cases:
  generated wrapper contains the `which node` discovery before the ABI loop
  (cross-platform), regenerates when the new marker is absent (the codey case),
  idempotent when both markers present.
- Regression: boot-wrapper cjs/plist + durable-node-selection + shadow-install
  self-heal + launchd-handoff suites — 46 tests pass.
- `tsc --noEmit` clean; `npm run lint` clean.
- Spec: `docs/specs/boot-wrapper-version-managed-node-candidates.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/boot-wrapper-version-managed-node-candidates.md`.
