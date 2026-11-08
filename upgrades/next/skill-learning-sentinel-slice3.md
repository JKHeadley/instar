<!-- bump: patch -->

## What Changed

Slice 3 of the Skill Learning Sentinel (spec `docs/specs/skill-learning-sentinel.md`): the full lifecycle of a
learned skill, still **dark** (`monitoring.skillLearning.enabled: false`; writes need `mode: live`).

- When a run of a learned skill is corrected, a reviewer of a different model family proposes a patch as cited
  hunks (each answering a named correction); the patched skill is linted and reviewed like a draft.
- Versions keep their bodies (older ones move to content-addressed storage, never deleted) and a per-version
  score; a worse version is reverted within bounds, and two reverts in 30 days lock the skill.
- Retire is its own reconciliation: the lease holder decides; every machine archives its rendering
  byte-for-byte before removing it from the coding tools' discovery. Restore re-reviews. Locked skills get the
  same archive treatment for any rendering left behind.
- Lock / unlock / retire / restore / retire-all taps on the console and the API (PIN on the holder).
- Six attention items: four heal first through the shared self-heal gate (bounded revert; retire the lowest-scored
  unused skill; swap the drafter family; the classifier failure swap) and reach you only after three attempts;
  two (unmeasured / split-brain and growth) are notices only.

## What to Tell Your User

Nothing to do. When the trial runs, a learned skill that goes wrong gets patched or reverted on its own, retired
when it stops earning its keep, and you only hear about it when the automatic fixes have run out.

## Summary of New Capabilities

- Reviewer patches with cited hunks; bounded revert with a breaker; versions with retained bodies.
- Archive-first retire and restore across machines; lock/unlock.
- Heal-first attention items on the shared self-heal gate.

## Evidence

Unit, integration and e2e tests at all three tiers (see the PR); side-effects review with second pass in
`upgrades/side-effects/skill-learning-sentinel-slice3.md`.
