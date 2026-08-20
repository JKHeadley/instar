<!-- bump: patch -->

## What Changed

**The previous release shipped the identity handover unreachable, which broke joining a machine
to an agent.** This connects it.

The identity-continuity change had two halves that only work together: a guard stopping a
joining machine from inventing its own identity, and a handover carrying the real one across.
The guard shipped wired. The handover shipped as code that nothing called.

Net effect: a machine joining a mesh correctly refused to mint an identity and had no way to
receive one, so the join could not complete.

Now:

- The pairing response carries the agent identity, sealed to the joining machine's encryption
  key — the key that has always arrived on that route and was validated and unused.
- The joining machine installs it **before its server first starts**, so the boot finds an
  identity and never reaches the minting branch. The write is atomic and owner-only.
- On any failure it provisions nothing and says so plainly, naming the remedy. It never falls
  back to minting: a silent split is worse than a join that visibly did not finish.

## Why every check passed on code that was unreachable

Worth recording, because the gap is general rather than a one-off:

- Unit tests exercised the component in isolation. The component was correct.
- Cross-model review examined the design over seven rounds. The design was right.
- The full suite ran the code that exists — it cannot notice code that is absent.
- Docs coverage, the guard manifest and the lints all asked about what IS there.

Each answered a narrower question than the one that mattered: *is it plugged in?* A component
can be perfect, fully tested, well reviewed, and unreachable, with every signal green.

The remedy is a wiring-integrity suite asserting **reachability through the real seams** — that
the route calls the sealer, the join command calls the installer, the server passes through what
the sealer needs, no failure path reaches for the minting call, and a full seal-to-install
round-trip ends with the joining machine holding the *source* machine's identity.

## Evidence

- `tests/unit/agent-identity-handover-wiring.test.ts` — 9 wiring tests.
- 97 tests across the identity work.
- Full suite: 25 failures / 10 files — byte-identical to the pre-change baseline.

## What to Tell Your User

- **If you tried to add a machine to your agent since the last release and it failed, this is
  why — and it works again now.** Existing machines were unaffected throughout; only adding a
  new one was blocked.
- **Nothing to do.** No configuration, no migration, no restart beyond the normal update.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Identity actually carried on join | Automatic. The pairing response seals it to the joining machine, which installs it before its first boot. |
| Loud, named refusal instead of a silent split | Automatic. A failed handover provisions nothing and names the remedy; it never mints. |
| Wiring-integrity coverage | Automatic in CI — asserts the pieces are connected, not merely correct. |
