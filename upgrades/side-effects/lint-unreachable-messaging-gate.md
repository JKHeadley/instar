# Side-Effects Review — lint: ban default-off config gate at an unreachable messaging.* path

**Version / slug:** `lint-unreachable-messaging-gate`
**Date:** `2026-07-04`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change

Adds `scripts/lint-no-unreachable-messaging-gate.js` (wired into the `lint` chain in `package.json`)
and its unit test. The lint fails CI if any source file reads a **default-OFF** config gate at a
`messaging.<child>.*` dot-path — the exact shape of the PR #1379 bug: on a real install `messaging`
is a JSON **array**, so `messaging.<child>.*` resolves `undefined` → the `false` default → the
feature is structurally un-enablable. It flags only the concrete `.get('messaging.*', false)`
LiveConfig gate-read shape, exempts default-`true` gates (unreachable just leaves them on), and
supports an inline `// lint-allow-messaging-gate: <reason>` suppression. Currently 0 offenders on
`main` (PR #1379 removed the last one) — this is a pure forward guard.

## Decision-point inventory

- `scripts/lint-no-unreachable-messaging-gate.js` — **add** — a new CI lint gate.
- `package.json` `lint` script — **modify** — append the new lint to the chain.
- `tests/unit/lint-no-unreachable-messaging-gate.test.ts` — **add** — detector unit tests.

## 1. Over-block

The regex targets `.get('messaging.<...>', false)` specifically. A legitimate default-OFF gate that
genuinely must live under `messaging` (none known) would be flagged — but the correct answer is to
move it to a reachable top-level key (the whole point), and the inline suppression exists for a
deliberate exception. Default-`true` gates and non-`messaging` paths are not flagged.

## 2. Under-block

It only catches the `.get(path, false)` shape. A default-off gate read via a cast
(`(cfg as {...}).messaging?.x`) or a raw-file read (`cfg.messaging.x.enabled` in a generated hook)
is not caught — a known, accepted limitation (the `.get` gate is the primary and highest-frequency
pattern; the two others are rarer and harder to lint without false positives). Documented in the
lint header.

## 3. Level-of-abstraction fit

Right layer: a build-time lint (cheap, deterministic, CI-enforced) is exactly the "Structure beats
Willpower" guard for a class that a human/CI missed once (object-shaped-messaging tests hid it). It
does not add runtime behavior or authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no runtime block/allow surface. It is a build-time CI lint. Its "authority"
  is failing a build on a precise, suppressible pattern — not gating any live message or action.

## 5. Interactions

- **Shadowing:** none — it's an independent step appended to the end of the `lint` chain.
- **Double-fire:** none.
- **Races:** none — pure file scan at build time.
- **Feedback loops:** none.

## 6. External surfaces

- **Install base / agents:** none at runtime — a CI/dev-time lint only.
- **External systems / persistent state:** none.
- **Operator surface:** no operator-facing action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — a build-time lint runs in CI / on a developer's checkout; it has no
runtime, no cross-machine state, no notices, no URLs. It is identical everywhere it runs by
construction.

## 8. Rollback cost

Pure additive tooling — revert the script + the one-line `package.json` edit + the test. No
persistent state, no runtime effect, no user-visible change. Zero-cost back-out.

## Conclusion

A small, precise, suppressible CI lint that would have caught the PR #1379 un-enablable bug at the
read site (`.get('messaging.actionClaim.enabled', false)`). 0 current offenders, so it is a pure
forward guard closing the class the operator's live-enable attempt surfaced. Clear to ship.

## Second-pass review (if required)

**Reviewer:** not required (Tier-1)

## Evidence pointers

- `tests/unit/lint-no-unreachable-messaging-gate.test.ts` — 8 cases: flags the #1379 shape (generic +
  plain + both quote styles), exempts default-true and non-messaging and top-level `actionClaim`,
  honors same-line and preceding-line suppression, regex matches the incident line.
- `node scripts/lint-no-unreachable-messaging-gate.js` → `clean` (0 offenders on current `main`).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `config-unreachable-on-shape` (the class named in the PR #1379 side-effects
  artifact; the guard the operator asked be built to close it).
- **`closure`** — `guard` — this lint IS the class-level guard: it structurally fails CI when a
  default-off config gate is read at an unreachable `messaging.<child>.*` dot-path.
- **`guardEvidence`** — `{ enforcementType: lint, citation: scripts/lint-no-unreachable-messaging-gate.js
  (wired into package.json `lint`, run by .husky/pre-commit + CI), howCaught: it flags
  `.get('messaging.<child>.*', false)` — the exact read shape of the #1379 master gate — so the
  un-enablable gate can never re-land }`.
