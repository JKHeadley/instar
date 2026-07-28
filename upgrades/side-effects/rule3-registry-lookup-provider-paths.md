# Side-effects review — Rule 3 gate registry lookup (provider paths)

**Change:** `isInRegistry()` in `scripts/check-rule3-coverage.cjs` gains a second, narrowly-scoped
path form; `tests/unit/scripts/check-rule3-coverage.test.ts` runs the copied script instead of the
original and gains 2 tests + a registry-fixture helper.

## Direction of effect — the only question that matters for a gate

This makes the gate **strictly more permissive**, so the risk to weigh is a false ACCEPT, never a
false refusal.

| Surface | Effect |
|---|---|
| Non-provider files | **None.** The widened form is behind `filepath.startsWith('src/providers/')`, so no other file can gain a match it did not already have. |
| Provider files, registered, with rationale | Now correctly accepted (was refused). **This is the fix.** |
| Provider files, registered, no rationale/canary | Still refused — `inRegistry && (hasRationale \|\| hasCanary)` is unchanged. |
| Provider files, unregistered | Still refused. Containment against a row that does not exist still fails. |
| Runtime / shipped product | **None.** A pre-commit script; not in `src/`, not bundled, not executed by the server. |

## The false-accept surface, stated plainly

Containment is a substring test, so a short row path could in principle match an unintended file.
That property is **pre-existing** and unchanged in kind — this only adds a second candidate string
for paths already under `src/providers/`. A file would need to be under `src/providers/` *and* have
its `src/providers/`-relative path appear verbatim in the registry, which is precisely the
condition the fix exists to honour.

I considered resolving each row against its section heading instead, which would remove the
guesswork entirely. It is the better long-term shape and a larger change; it is not done here.

## Test-harness change — read this as a coverage change, not a cosmetic one

`runCheck` now executes the copy inside the tmp repo. The script resolves the registry from
`__dirname/../specs/`, so running the original read the **real** repo's registry while reading
staged files from the tmp repo.

Consequence: every registry fixture written by a test was silently ignored, and the
"already in the registry" branch had **no reachable coverage at all**. `beforeEach` had always
copied the script in — the copy was simply never run.

All 22 pre-existing tests pass unchanged under the corrected harness, which is the evidence that
this repaired coverage rather than altering what those tests assert.

## Verification

- **Red → green, observed:** before the fix, the provider test failed and the `src/`-relative
  control passed (1 failed / 23 passed). After, 24/24.
- The control is the load-bearing part: it fails if the cause is anything other than the provider
  path form.
- **A correction this produced:** on my first attempt the control failed *too*, which meant my
  explanation was wrong — a registry entry alone never exempted anything. Following that
  disagreement is what surfaced the harness defect. The earlier claim that 26 files on `main` were
  affected is withdrawn: all 26 lack a rationale and would be refused regardless.

## Rollback

`git revert`. Restores the unreachable lookup; no state, no migration, no config.
