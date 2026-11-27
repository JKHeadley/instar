# Side effects — restore the silent-fallback count to its baseline so the merge queue moves

ELI16: `docs/specs/silent-fallback-ratchet-machine-load.eli16.md`

## The change

`src/core/machineLoadReport.ts` — the `sampleOnce()` rejection handler gains an in-window
`@silent-fallback-ok` justification. ONE comment; no behaviour change.

## Why

`tests/unit/no-silent-fallbacks.test.ts` is a ratchet: `expect(count).toBeLessThanOrEqual(494)`,
and its own comments say the number only ever decreases. Measured with that scanner:

| tree | count |
|---|---|
| `c7feb1573` (release v1.3.1438) | 493 |
| `origin/main` @ `ebb9366f5` (v1.3.1443) | **495 — over its own baseline** |
| this branch | 494 |

Main failing its own ratchet is not confined to main: Local Verify tests each PR as the
MERGE of the PR and main, so every queued PR inherits the failure. Observed consequences in
`.instar/state/local-verify/journal.jsonl`: PR #2371 `lane-failed:unit:1` with
`file-failed:tests/unit/no-silent-fallbacks.test.ts:1`, and PR #2350 at
`state: gave-up, lastOutcome: refused:verify-failed` after 3 attempts.

The flagged catch is not a swallow — it logs the error with its message, and a missed sample
surfaces downstream as `loadVerdict: 'unknown'` (a report older than 60 s reads unknown), which
is the honest degradation, not a fabricated healthy reading. It needed the canonical marker,
not a code change.

## 1. Over-block — what does this now reject that it shouldn't?

Nothing. A comment cannot reject anything. The ratchet keeps its number at 494; this restores
the tree to it rather than raising it.

## 2. Under-block — what does this still miss?

The second file that moved between 493 and 495 is `src/server/routes.ts` (27 → 28). Its newly
added catch carrying `/* may not exist */` is NOT the counted one — marking it changed the
count by zero, so that edit was reverted rather than left as churn. Which routes.ts catch the
scanner now counts is unresolved; it is likely the documented "extractor-window artifact" the
test's own comments describe, where inserted lines shift a pre-existing catch outside another
catch's 20-line exemption window. Stated rather than guessed at, and it leaves ZERO headroom:
the next change that adds one counted catch fails again. <!-- tracked: CMT-1021 -->

## 3. Level-of-abstraction fit

The marker sits on the catch it describes. No new component, no new authority.

## 4. Signal vs authority

The ratchet is a deterministic test, not a runtime gate; nothing gains blocking authority.

## 5. Interactions

Unblocks the Local Verify merge line for every queued PR. No runtime path changes.

## 6. External surfaces

None. No route, config key, or user-visible behaviour changes.

## 7. Multi-machine posture

Not applicable — a source comment, `machine-local` in no meaningful sense; nothing is stored,
replicated or served.

## 8. Rollback cost

Revert the one-line comment; the count returns to 495 and the queue re-blocks.

## Second-pass review

Not required: no decision point, no block/allow path, no session-lifecycle surface — a comment
on an already-logging catch. The measurement above (four trees, the same scanner) is the
evidence.
