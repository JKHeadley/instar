# Side-effects review — @silent-fallback-ok tags on two GrowthDigestPublisher catches

**Change:** two comments. No statement, signature, control flow, or type is modified.

## Effect

| Surface | Effect |
|---|---|
| Runtime behaviour | **None.** Comments only; `tsc` emits identical JS. |
| The two catch blocks | Unchanged — both still report via `deps.onError`, `escalationActive()` still returns `false`. |
| `no-silent-fallbacks` ratchet | 497 → 495. Baseline **untouched at 495**. |
| Anything outside this file | None. |

## Is the exemption honest?

This is the only question worth asking, since the tag's whole purpose is to suppress a gate.

- **audit catch** — reports through `deps.onError('audit', err)`. An audit-sink fault must not abort
  the digest being recorded. Reports, continues, loses nothing but the audit line the sink itself
  failed to take.
- **`escalationActive()`** — reports through `deps.onError` and returns `false`, failing toward LEGACY
  (consume + record `send-blocked`). Its doc comment already stated this contract *before* this
  change: *"Fails toward LEGACY on any read fault — never crashes, never silently drops."* The tag
  documents behaviour that was already there and already intended.

Both match the exempt case named in the ratchet's own comments: *"a fail-safe failing toward the safe
direction — not a new swallow."*

Neither is silent in the sense the rule cares about: the failure reaches the same error channel the
rest of the class uses. The heuristic keys on `DegradationReporter` specifically, which this class
does not use anywhere.

## What I did not do

**Raise the baseline.** It was one number away and it would have retired the ratchet for everyone.
It stays at 495.

**Restructure the catches to use `DegradationReporter`.** That would be a behaviour change to a
dark-shipping feature during a merge-refresh, mixing two unrelated risks in one commit.

## Verification

- `tests/unit/no-silent-fallbacks.test.ts` — 5/5 green locally; 1 failed before.
- The two entries were identified by diffing per-file counts between `main` and this branch (main=0,
  branch=2 for this file), not by eyeballing a 497-line list — line numbers shift between branches, so
  a positional diff would have been noise.
