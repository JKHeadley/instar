# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Adds two enforcement lints — deterministic, no-LLM parser scripts — that back the two
already-ratified constitutional standards A ("An Instar Agent Is Always a Multi-Machine
Entity") and B ("Self-Heal Before Notify") with a cheap structural signal, per
`docs/specs/three-standards-enforcement.md` (§178-202 for A, §256-289 / §343-361 for B).

- `scripts/lint-machine-local-justification.js` grades a spec's `machine-local-justification: <taxonomy-key>`
  marker: an undefended machine-local surface is a finding, and — bidirectionally — a
  spurious/out-of-taxonomy marker, or an `operator-ratified-exception` citing no
  machine-verifiable ref, is a finding too.
- `scripts/lint-self-heal-fields.js` grades a spec's self-heal declaration (anchored on
  the `remediation-actions` field): it requires the full P19 brake set, a non-empty
  `remediation-actions` list (the anti-no-op floor), a units-carrying
  `max-notification-latency`, and a well-formed severity class.

Both ship REPORT-FIRST — they print findings and exit 0 by default (a non-blocking
signal); a `--strict` flag is the FAIL capability used by their tests and available for a
later CI graduation. Each is registered in `docs/STANDARDS-REGISTRY.md` so the
Standards Enforcement-Coverage auditor now grades Standards A and B as enforced by a
deterministic lint (verified: two more standards move from unenforced to lint-enforced).
No constitutional text is minted or re-ratified; no runtime `src/` code changes.

## What to Tell Your User

Nothing proactive — this is instar-developing-agent tooling and nothing changes for a
user. If a user asks how the constitution's "always multi-machine" and "self-heal before
telling me" rules are actually enforced now: two small automatic checkers read a design
document's plain text and flag when it forgets to say which machine a piece of state
lives on, or writes a self-repair plan that would do nothing or never stop trying. For now
these run in report-only mode — they point out the problem but do not block anything — and
they sit underneath the smart reviewer that still makes the real judgment call, rather than
replacing it.

## Summary of New Capabilities

- **Standard A marker floor** — a no-AI checker that flags an undefended machine-local
  state surface in a spec, and also flags the reverse: a made-up justification key or an
  operator-ratified claim with no verifiable proof.
- **Standard B self-heal floor** — a no-AI checker that flags a watchdog self-heal plan
  missing its brakes, listing no real repair actions, or writing a notification deadline
  with no time units.
- **Report-first rollout** — both checkers signal without blocking by default; a strict
  mode exists for their tests and a future graduation.
- **Constitution coverage** — Standards A and B are now graded as lint-enforced by the
  Standards Enforcement-Coverage auditor, not merely documented.

## Evidence

- `tests/unit/lint-machine-local-justification.test.ts` + `tests/unit/lint-self-heal-fields.test.ts`
  — 13 unit tests (7 A + 6 B): positive/defended cases pass; undefended (A1),
  spurious-key (A2), and no-ref (A2) fail under strict; missing-brakes (B1), no-op +
  unitless + unknown-class (B2/B3/B4) fail under strict; out-of-scope is clean; and report
  mode exits 0 on every bad fixture.
- `node scripts/standards-coverage.mjs` reports the lint-enforced standard count rising
  from 0 to 2 with Standards A and B removed from the unenforced-gaps list and zero
  dangling references; the coverage ratchet check passes.
