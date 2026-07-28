# Side-effects review — GitSync.commitAndPush upstream retry

**Change:** `src/core/GitSync.ts` — the `autoPush` block gains a `try/catch`; on failure it resolves
the branch via `symbolic-ref --short HEAD` and retries once as `push -u origin <branch>`. Two tests.

## Direction of effect

Strictly **additive on the failure path only**.

| situation | before | after |
|---|---|---|
| bare `push` succeeds | pushed | **identical** — no extra git call (asserted by test) |
| bare `push` fails, branch resolvable | `false` (looks like "nothing to do") | one retry with explicit upstream |
| bare `push` fails, no branch (detached HEAD) | `false` | original error rethrown → same `false` |
| `autoPush === false` | no push | unchanged |

The happy path executes the same single git command it always did. That is asserted, not assumed —
`does NOT add an explicit upstream when the bare push succeeds` fails if a second push ever appears.

## Why the retry is safe

`push -u origin <branch>` is a no-op with respect to tracking when tracking already exists, and it is
only reached when the bare push has *already failed* — so it cannot turn a working sync into a broken
one. The branch comes from `symbolic-ref --short HEAD`, which this file already uses in two other
places, so no new failure mode is introduced; a detached HEAD yields an empty string and the original
error is rethrown rather than pushing somewhere unintended.

## What this deliberately does NOT fix

`commitAndPush` returns `false` for three distinct situations: no dirty paths, nothing staged, and the
push threw. A caller cannot tell "nothing to sync" from "sync failed".

Not addressed here, for two reasons. It is a **semantic** change to a return value that `GitLeaseStore`
and `RegistrySyncDebouncer` branch on — the lease mechanism that decides which machine serves — so it
deserves its own change with its own review. And `GitLeaseStore:80` already handles the ambiguity
defensively ("Push rejected (a peer advanced) or no-op" → re-read after a pull and retry), so the
acute failure is the push that never lands, not the conflated return.

Filed separately rather than bundled: bundling a behavioural change to the lease path into a push fix
is how one review ends up covering two risks.

## Verification

- **Red → green with a control**: without the src change, `retries with an explicit upstream when the
  bare push fails` FAILS (1 failed / 37 passed); with it, 38/38. The happy-path control passes in both
  directions, which is what shows the change is additive rather than a behaviour swap.
- `tsc --noEmit` clean.
