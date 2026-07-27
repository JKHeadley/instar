# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`tests/unit/agent-registry.test.ts` and `tests/unit/builtin-manifest.test.ts` were removed from
`FLAKY_TESTS` in `vitest.push.config.ts`, so both run in the push/CI unit gate again. The surrounding
comment now records the measurements and the falsified hypothesis rather than a bare heading.

Neither test is flaky. Both arrived in `f193df789` ("exclude pre-existing flaky tests from push
gate") — a bulk exclusion, not an individual diagnosis — and sat under a
"Environment-dependent / non-deterministic" heading that was thereafter read as a finding about each
one.

## Evidence

Measured on current `main`, three consecutive runs each:

```
agent-registry.test.ts    → 42 passed | 42 passed | 42 passed
builtin-manifest.test.ts  →  9 passed |  9 passed |  9 passed
```

The one concrete environmental hypothesis was tested and falsified. `builtin-manifest.test.ts` reads
`src/data/builtin-manifest.json`, a generated and gitignored artifact that a job which never builds
would not have. Deleting the file and re-running:

```
Tests  9 passed (9)
```

It still passes because the test's own `beforeAll` regenerates it via
`scripts/generate-builtin-manifest.cjs` — it was already self-sufficient by design.

After the change, verified by parsing the resolved `FLAKY_TESTS` array rather than assuming the edit
took: both paths report `NO LONGER EXCLUDED`, 92 entries remain. Both tests run green together
(`Test Files 2 passed (2) · Tests 51 passed (51)`); `tsc --noEmit` exit 0.

## Known limits

The remaining 92 entries are untouched and unexamined. Several — the supertest/port-collision group
especially — are plausibly genuinely environment-bound, and emptying the list wholesale would repeat
the bulk move that caused this. Local determinism is also not proof of CI determinism: if either test
fails in CI, that is a real finding to diagnose, not a reason to re-park it.

## Why the comment is verbose

The note two entries below already described this same mistake: two other tests were re-armed on
2026-06-05 from the same heading, with the observation that the label had been wrong and that both
had rotted while parked. The diagnosis, the precedent and the warning were already in the file,
three lines above two more mislabelled tests. The replacement comment therefore carries the
measurements and the falsified theory, so the next person reaching for that label has to argue with
evidence instead of reapplying a heading.
