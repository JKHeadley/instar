<!-- bump: patch -->

## What Changed

The Rule 3 pre-commit gate's registry lookup could never match a file under `src/providers/`.

`isInRegistry()` stripped only `src/`, so it searched the state-detector registry for
`providers/adapters/foo/Bar.ts` — while the registry's provider section writes its Location column
relative to `src/providers/`, i.e. `adapters/foo/Bar.ts`. 21 of that section's 23 rows use that
form. The strings never met.

A registered file was therefore still refused, with a message instructing the author to add a
registry entry that already existed — in one case, one that appears in three separate rows.

The lookup now also tries the `src/providers/`-relative form, guarded by
`filepath.startsWith('src/providers/')` so no other file gains a match it did not already have.

## What to Tell Your User

Nothing. This is a contributor-facing pre-commit script — not shipped, not executed at runtime, no
user-visible behaviour.

## Summary of New Capabilities

None. A registry entry still does not exempt a file on its own: `inRegistry && (hasRationale ||
hasCanary)` is unchanged. This only stops the gate from ignoring a registry row that genuinely
exists.

## Evidence

- Red → green, observed rather than predicted: the provider case failed and the `src/`-relative
  control passed before the fix (1 failed / 23 passed); 24/24 after. The control is what isolates
  the cause to the path form.
- **Why the branch had no coverage:** `tests/unit/scripts/check-rule3-coverage.test.ts` copied the
  script into its tmp repo but executed the *original*. Since the script resolves its registry from
  `__dirname/../specs/`, it read the real repo's registry while reading staged files from the tmp
  repo — so every registry fixture a test wrote was silently ignored. Fixed by running the copy;
  all 22 pre-existing tests pass unchanged under the corrected harness.
- Side-effects review: `upgrades/side-effects/rule3-registry-lookup-provider-paths.md`.
