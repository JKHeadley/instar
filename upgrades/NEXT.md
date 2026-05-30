# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The Framework-Onboarding mentor now reports WHY a tick failed, and its Stage-A
step is more resilient.** The mentor's Stage-A step spawns a tiny tool-less
session to compose the next coaching message, then captures it. When that spawn
failed (common on a busy multi-agent box — session-cap pressure / load), the
whole tick collapsed to an opaque `stage-a-failed` with the real cause thrown
away, so it was undiagnosable from `GET /mentor/status`. Now: the real error is
surfaced into `lastResult.error`, and the Stage-A compose-session spawn retries
once with a short backoff before failing with a clear, specific message.

**Multi-machine: the SEND side of the cross-machine command channel now works on
a normally-created machine.** The private per-machine key used to sign every
machine-to-machine command was being loaded from the wrong filename
(`signing-private.pem`), but a normally-created machine stores it as
`signing-key.pem`. So a normal machine signed its outbound commands with an empty
key and the send silently failed — it could receive from peers but never call out
to them (check a peer's presence, hand off a conversation, move one). The loader
now reads the canonical filename, falling back to the legacy one. This is the
send-side companion to the recent command-channel auth fix; together they make
the cross-machine pool actually work over the network. (Found on real hardware:
the laptop couldn't see the mini until its signing key loaded.)

## What to Tell Your User

Only relevant if you run the (off-by-default) Framework-Onboarding mentor. It now
recovers from a transient compose-session spawn failure, and when it does fail it
tells you exactly why (visible on the mentor status page) instead of an
unexplained "stage-a-failed."

If you run across two machines: this release fixes the last piece that kept a
normally-created machine from being able to reach its peers — a second machine
will now correctly show as online and be eligible to receive conversations, and
moving a conversation between machines works. Both machines need to update.

## Summary of New Capabilities

- `GET /mentor/status` → `lastResult.error` now carries the real Stage-A failure
  cause (`MentorTickResult.error`), instead of swallowing it.
- `spawnStageA` retries the compose-session spawn once (transient resilience) and
  throws a clear `stage-a-spawn-failed: … — <cause>` on persistent failure.
- The MeshRpcClient signing-key loader reads the canonical `signing-key.pem`
  (falling back to legacy `signing-private.pem`), so a normally-created machine
  can sign — and therefore SEND — cross-machine commands.

## Evidence

- `tests/unit/MentorOnboardingRunner.test.ts` (+1): a `spawnStageA` that throws
  now yields `lastResult = {ran:false, reason:'stage-a-failed', error:<msg>}` —
  asserts the cause is surfaced (was swallowed by a bare catch in
  `runMentorTick`). Full mentor/stage suite (113 tests / 9 files) green;
  `tsc --noEmit` clean.
- `tests/unit/mesh-signing-key-resolution.test.ts` — the loader reads the
  canonical `signing-key.pem`, tries it before the legacy `signing-private.pem`,
  and the canonical name matches `MachineIdentity.SIGNING_KEY_FILE`.
- Found on real hardware (laptop + mini): the laptop's puller recorded the mini
  online over the signed HTTP channel only after its signing key loaded; before,
  it signed with an empty key and the send threw.
- Side-effects: `upgrades/side-effects/mentor-stage-a-robustness.md`,
  `upgrades/side-effects/mesh-signing-key-filename-fix.md`.
